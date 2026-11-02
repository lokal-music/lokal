// Moving covers: the looping clips Apple Music shows instead of a still album
// cover. Ported from BitChord's canvas pipeline (Apple first, then Tidal,
// then a community list, then -- opt-in, with your own cookie -- Spotify
// Canvas; see spotify.js).
//
// None of these are official public APIs:
//   - Apple: the web player's own token, read from music.apple.com's script
//     bundle, used against Apple's catalogue API (amp-api) for an album's
//     "editorialVideo";
//   - Tidal: the token Tidal's embed player ships with, for an album's
//     "videoCover";
//   - community: a list of clips kept by BitChord's community on a
//     Cloudflare worker.
// Any of them may stop working without notice; a failure is simply "no
// moving cover" and the still artwork stays.
//
// A match must have exactly the same title (and album, where both sides know
// it) and every one of the track's artists -- a wrong clip is worse than none.
// Clips are saved as MP4 in a capped cache (Apple's HLS streams are remuxed
// with ffmpeg, no re-encoding), so each plays from disk after the first time.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const TIDAL_TOKEN = 'vNVdglQOjFJJGG2U'
const COMMUNITY_URL = 'https://vivimusicanvas.mkmdevilmi.workers.dev/canvas.json'
const M8TEC_URL = 'https://artwork.m8tec.top/api/v1/artwork/search'
const SOURCES = ['apple', 'tidal', 'community', 'm8tec', 'spotify']
// Spotify needs a cookie, so it's opt-in. m8tec looks up the same Apple Music
// covers as 'apple' through someone else's server, so it's opt-in too: a
// fallback for when Apple's own lookup fails, not a new default destination.
const DEFAULT_SOURCES = ['apple', 'tidal', 'community']
const HIT_TTL = 30 * 24 * 3600 * 1000
const MISS_TTL = 3 * 24 * 3600 * 1000

// ---------------------------------------------------------------- matching

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// "(Official Video)", "[Lyrics]", "| Topic"... the song itself, not the upload.
const NOISE = /\s*[([][^)\]]*(?:official|lyric|audio|video|visuali[sz]er|hd|4k|mv)[^)\]]*[)\]]|\s*\|.*$/gi

function cleanTitle(title) {
  return String(title || '').replace(NOISE, '').trim()
}

function splitArtists(s) {
  return String(s || '')
    .split(/\s*(?:,|&|×|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|;|\/)\s*/i)
    .map(norm)
    .filter(Boolean)
}

function artistsMatch(wanted, got) {
  const want = splitArtists(wanted)
  const have = new Set((Array.isArray(got) ? got : [got]).flatMap(splitArtists))
  const joined = [...have].join(' ')
  return want.length > 0 && want.every(a => have.has(a) || joined.includes(a))
}

// ---------------------------------------------------------------- http

async function getJson(url, headers = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: controller.signal })
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e }
    return await res.json()
  } finally { clearTimeout(timer) }
}

async function getText(url, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally { clearTimeout(timer) }
}

// ---------------------------------------------------------------- Apple

let appleToken = null // { jwt, exp }
let appleTokenFailedAt = 0
const badTokens = new Set()

function decodeJwt(jwt) {
  try {
    const [h, p] = jwt.split('.')
    return { header: Buffer.from(h, 'base64url').toString(), payload: JSON.parse(Buffer.from(p, 'base64url').toString()) }
  } catch { return null }
}

async function appleJwt() {
  if (appleToken && appleToken.exp * 1000 > Date.now() + 60000) return appleToken.jwt
  if (Date.now() - appleTokenFailedAt < 30 * 60 * 1000) return null
  try {
    const html = await getText('https://music.apple.com/us/browse')
    const bundles = [...new Set(html.match(/\/assets\/index(?:-legacy)?[~-][A-Za-z0-9_-]+\.js/g) || [])]
    for (const bundle of bundles) {
      const js = await getText(`https://music.apple.com${bundle}`, 20000)
      for (const jwt of js.match(/ey[\w-]+\.ey[\w-]+\.[\w-]+/g) || []) {
        if (badTokens.has(jwt)) continue
        const d = decodeJwt(jwt)
        if (!d?.payload?.exp || d.payload.exp * 1000 < Date.now()) continue
        if (!/WebPlay/.test(d.header) && !/WebPlay/.test(JSON.stringify(d.payload))) continue
        appleToken = { jwt, exp: d.payload.exp }
        return jwt
      }
    }
  } catch {}
  appleTokenFailedAt = Date.now()
  return null
}

async function appleGet(url) {
  const jwt = await appleJwt()
  if (!jwt) return null
  try {
    return await getJson(url, { Authorization: `Bearer ${jwt}`, Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/' })
  } catch (e) {
    if (e.status === 401) { badTokens.add(jwt); appleToken = null }
    return null
  }
}

const COMPILATION = /playlist|set list|essentials|dj mix|mixed|apple music|today's hits|session/i
const EDITION = /deluxe|expanded|remaster|remix|version|edit|mix|bonus/i

function pickRendition(video) {
  if (!video) return null
  const order = ['motionDetailSquare', 'motionSquareVideo1x1', 'motionDetailRaw', 'motionDetailTall', 'motionTallVideo3x4']
  for (const key of order) {
    const v = video[key]
    const url = v && (v.video || v.videoUrl || v.hlsUrl || v.url)
    if (url) return { url, tall: /Tall|3x4/.test(key) }
  }
  return null
}

async function fromApple({ title, artist, album }, storefront = 'us') {
  const term = [artist, cleanTitle(title), album].filter(Boolean).join(' ')
  const base = `https://amp-api.music.apple.com/v1/catalog/${storefront}`
  const res = await appleGet(`${base}/search?term=${encodeURIComponent(term)}&types=songs&limit=10&extend=editorialVideo&include=albums`)
  const songs = res?.results?.songs?.data || []
  const wantTitle = norm(cleanTitle(title))
  const wantAlbum = norm(album)
  const matches = []
  for (const song of songs) {
    const a = song.attributes || {}
    if (COMPILATION.test(a.albumName || '')) continue
    if (!artistsMatch(artist, a.artistName)) continue
    const t = norm(a.name)
    let score = 10 + (t === wantTitle ? 15 : (t.includes(wantTitle) || wantTitle.includes(t)) ? 7 : -10)
    const al = norm(a.albumName)
    if (wantAlbum) score += al === wantAlbum ? 20 : (al.includes(wantAlbum) || wantAlbum.includes(al)) ? 10 : 0
    const editionHere = EDITION.test(a.albumName || '')
    if (editionHere) score += EDITION.test(album || '') ? 5 : -3
    if (score >= 12) matches.push({ song, score })
  }
  // Best match first; but when several tie (no album to tell the single from
  // the album release, say) the first may simply have no moving cover while
  // another release of the same song does -- so try the top few in turn.
  matches.sort((x, y) => y.score - x.score)
  const seenAlbums = new Set()
  for (const { song } of matches.slice(0, 4)) {
    let video = song.attributes?.editorialVideo
    if (!pickRendition(video)) {
      const albumId = song.relationships?.albums?.data?.[0]?.id || String(song.attributes?.url || '').match(/\/album\/[^?]*?(\d+)(?:\?|$)/)?.[1]
      if (!albumId || String(albumId).startsWith('pl.') || seenAlbums.has(albumId)) continue
      seenAlbums.add(albumId)
      const albumRes = await appleGet(`${base}/albums/${albumId}?extend=editorialVideo`)
      video = albumRes?.data?.[0]?.attributes?.editorialVideo
    }
    const pick = pickRendition(video)
    if (pick) return { url: pick.url, kind: 'hls', source: 'apple', tall: pick.tall }
  }
  return null
}

// ---------------------------------------------------------------- Tidal

async function fromTidal({ title, artist, album }, country = 'US') {
  const q = [album, artist, cleanTitle(title)].filter(Boolean).join(' ')
  const res = await getJson(`https://api.tidal.com/v1/search?query=${encodeURIComponent(q)}&limit=10&types=TRACKS&countryCode=${country}`, { 'X-Tidal-Token': TIDAL_TOKEN }).catch(() => null)
  const wantTitle = norm(cleanTitle(title))
  const wantAlbum = norm(album)
  for (const t of res?.tracks?.items || []) {
    if (norm(t.title) !== wantTitle) continue
    if (!artistsMatch(artist, (t.artists || []).map(a => a.name))) continue
    if (wantAlbum && t.album?.title && norm(t.album.title) !== wantAlbum) continue
    const uuid = t.album?.videoCover
    if (!uuid || uuid.split('-').length !== 5) continue
    return { url: `https://resources.tidal.com/videos/${uuid.split('-').join('/')}/1280x1280.mp4`, kind: 'mp4', source: 'tidal', tall: false }
  }
  return null
}

// ---------------------------------------------------------------- community

let community = { at: 0, items: [] }
async function fromCommunity({ title, artist, album }) {
  if (Date.now() - community.at > 30 * 60 * 1000) {
    try {
      const data = await getJson(COMMUNITY_URL, {}, 15000)
      community = { at: Date.now(), items: Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [] }
    } catch { community.at = Date.now() - 25 * 60 * 1000 }
  }
  const wantTitle = norm(cleanTitle(title))
  const wantAlbum = norm(album)
  for (const item of community.items) {
    const t = norm(item.song)
    if (!t || !(t === wantTitle || t.includes(wantTitle) || wantTitle.includes(t))) continue
    if (!artistsMatch(artist, item.artist) && !artistsMatch(item.artist, artist)) continue
    if (item.album && wantAlbum && norm(item.album) !== wantAlbum) continue
    if (item.url) return { url: item.url, kind: /\.m3u8(?:[?#]|$)/i.test(item.url) ? 'hls' : 'mp4', source: 'community', tall: false }
  }
  return null
}

// artwork.m8tec.top: finds a song's Apple Music animated cover by artist,
// album and title. Its answer names the artist and album it matched, which
// have to be this song's, as for the community list.
async function fromM8tec({ title, artist, album }) {
  const params = new URLSearchParams({ artist: firstArtist(artist) || artist, title: cleanTitle(title) })
  if (album) params.set('album', album)
  let data
  try {
    data = await getJson(`${M8TEC_URL}?${params}`, {}, 15000)
  } catch (e) {
    if (e?.status === 404) return null
    const err = e instanceof Error ? e : new Error(String(e))
    err.transient = true
    throw err
  }
  const url = data?.url || data?.url_tall
  if (!url) return null
  if (data.artist && !artistsMatch(artist, data.artist) && !artistsMatch(data.artist, artist)) return null
  if (album && data.album && norm(data.album) !== norm(album)) return null
  return { url, kind: /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'mp4', source: 'm8tec', tall: !data.url }
}

function firstArtist(s) {
  return String(s || '').split(/\s*(?:,|&|×|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|;|\/)\s*/i)[0].trim()
}

function fromSpotifyCanvas(track, settings) {
  if (!settings.spotify_sp_dc) return null
  // Any failure here is Spotify's (cookie, token, rate limit), not proof the
  // song has no canvas -- so never let it be remembered as a miss.
  return Promise.resolve()
    .then(() => require('./spotify').fromSpotify(track, settings, { norm, cleanTitle, artistsMatch, splitFirstArtist: firstArtist }))
    .catch(e => { const err = e instanceof Error ? e : new Error(String(e)); err.transient = true; throw err })
}

// Every provider is called as (track, settings). Apple's and Tidal's second
// parameter is their storefront/country, so they're wrapped: passing the
// settings object straight through made them search "/catalog/[object
// Object]" and "countryCode=[object Object]", so they never found anything.
const PROVIDERS = {
  apple: (track) => fromApple(track),
  tidal: (track) => fromTidal(track),
  community: (track) => fromCommunity(track),
  m8tec: (track) => fromM8tec(track),
  spotify: fromSpotifyCanvas,
}

// ---------------------------------------------------------------- clip cache

function run(ffmpeg, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let proc
    try { proc = spawn(ffmpeg || 'ffmpeg', args, { windowsHide: true }) } catch (e) { reject(e); return }
    let err = ''
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
    proc.stderr.on('data', d => { err = (err + d).slice(-1000) })
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg ${code}`)) })
  })
}

/** Choose an HLS variant, optionally preferring a high-resolution HEVC stream. */
async function chooseVariant(masterUrl, {
  target = 768,
  highResolution = false,
} = {}) {
  const text = await getText(masterUrl)
  const lines = text.split(/\r?\n/)
  const variants = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/)
    if (!m) continue
    const attrs = m[1]
    const uri = lines.slice(i + 1).find(l => l && !l.startsWith('#'))
    const codecs = (attrs.match(/CODECS="([^"]+)"/) || [])[1] || ''
    const res = (attrs.match(/RESOLUTION=(\d+)x(\d+)/) || []).slice(1).map(Number)
    if (!uri || !/(?:avc1|hvc1|hev1)/i.test(codecs)) continue
    const codec = /(?:hvc1|hev1)/i.test(codecs) ? 'hevc' : 'h264'
    variants.push({ uri: new URL(uri, masterUrl).href, width: res[0] || 0, height: res[1] || 0, codec })
  }
  if (!variants.length) return masterUrl
  const area = variant => variant.width * variant.height
  const eligible = variants.filter(v => Math.min(v.width, v.height) >= target)
  if (highResolution) {
    const hevc2160 = eligible
      .filter(v => v.codec === 'hevc' && Math.min(v.width, v.height) >= 2160)
      .sort((a, b) => area(a) - area(b))
    if (hevc2160.length) return hevc2160[0].uri
    const h264 = eligible.filter(v => v.codec === 'h264')
    const bestH264 = h264.sort((a, b) => area(b) - area(a))[0]
    if (bestH264) return bestH264.uri
    const hevc = eligible.filter(v => v.codec === 'hevc').sort((a, b) => area(b) - area(a))[0]
    if (hevc) return hevc.uri
  }
  const h264 = eligible.filter(v => v.codec === 'h264')
  const chosen = (h264.length ? h264 : eligible.filter(v => v.codec === 'hevc')).sort((a, b) => area(a) - area(b))[0]
    || variants.filter(v => v.codec === 'h264').sort((a, b) => area(b) - area(a))[0]
    || variants.sort((a, b) => area(b) - area(a))[0]
  return chosen?.uri || masterUrl
}

async function download(url, dest, timeoutMs = 60000) {
  // The timer covers the body too, so a stalled transfer can't leave the
  // clip's in-flight promise hanging forever.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1024) throw new Error('empty clip')
    fs.writeFileSync(dest, buf)
  } finally {
    clearTimeout(timer)
  }
}

// Moving covers share the cache limit with playback copies (electron/cache.js).
function trimCache(dir, keep) {
  require('../cache').trim({ keep })
}

const inFlight = new Map()

/** The clip as an MP4 file in the cache (fetched/remuxed once). */
async function cachedClip(found, { cacheDir, ffmpeg, highResolution = false }) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const cacheKey = `${found.url}|${highResolution ? 'high' : 'default'}`
  const dest = path.join(cacheDir, crypto.createHash('sha1').update(cacheKey).digest('hex').slice(0, 20) + '.mp4')
  if (fs.existsSync(dest)) {
    try { const now = new Date(); fs.utimesSync(dest, now, now) } catch {}
    return dest
  }
  if (inFlight.has(dest)) return inFlight.get(dest)
  const job = (async () => {
    const temp = `${dest}.part.mp4`
    try {
      if (found.kind === 'hls') {
        const variant = await chooseVariant(found.url, { highResolution })
        await run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', variant, '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', temp])
      } else {
        await download(found.url, temp)
      }
      fs.renameSync(temp, dest)
      trimCache(cacheDir, dest)
      return dest
    } catch {
      try { fs.unlinkSync(temp) } catch {}
      return null
    }
  })().finally(() => inFlight.delete(dest))
  inFlight.set(dest, job)
  return job
}

// ---------------------------------------------------------------- lookup

function ensureTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS motion_covers (key TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER)')
}

function keyFor({ title, artist, album }) {
  return `${norm(cleanTitle(title))}|${norm(artist)}|${norm(album)}`
}

function enabledSources(settings) {
  let list = null
  try { list = JSON.parse(settings.motion_cover_sources || 'null') } catch {}
  const chosen = Array.isArray(list) ? list : DEFAULT_SOURCES
  // Always in the same order, whatever order they were switched on in --
  // except that Spotify can be asked first ("Prioritize Spotify Canvas").
  // Spotify needs Electron (a hidden browser window mints its token), so a
  // standalone web server skips it and keeps the other sources.
  const spotifyOk = !!settings.spotify_sp_dc && !!process.versions.electron
  const order = SOURCES.filter(s => chosen.includes(s) && (s !== 'spotify' || spotifyOk))
  if (settings.spotify_canvas_first === '1' && order.includes('spotify')) return ['spotify', ...order.filter(s => s !== 'spotify')]
  return order
}

/**
 * @returns {Promise<{ file: string, source: string, tall: boolean } | null>}
 */
// The library stores a missing album as the literal "Unknown Album". Treat
// that (or an empty album) as no album, so sources match on title and artist
// alone -- otherwise Tidal and the community list, which require the album to
// match when one is given, never found anything for these tracks.
const NO_ALBUM = /^\s*(?:unknown album|unknown|untitled)?\s*$/i

async function motionCoverFor(db, track, { settings = {}, cacheDir, ffmpeg } = {}) {
  if (!track?.title || !track?.artist) return null
  if (NO_ALBUM.test(track.album || '')) track = { ...track, album: '' }
  if (settings.motion_covers === '0') return null
  const sources = enabledSources(settings)
  if (!sources.length) return null
  ensureTable(db)
  // "|s3": Spotify lookups from before the canvas-query switch are ignored.
  // "|v2": lookups from before the provider-call fix above are ignored (they
  // were cached as "no moving cover" for days).
  // "|v3": lookups made before "Unknown Album" was ignored are looked up again.
  const key = keyFor(track) + `|${sources.join(',')}|v3` + (sources.includes('spotify') ? '|s3' : '')
  const row = db.prepare('SELECT data, fetched_at FROM motion_covers WHERE key = ?').get(key)
  let found
  if (row) {
    const data = row.data ? JSON.parse(row.data) : null
    const fresh = Date.now() - row.fetched_at < (data ? HIT_TTL : MISS_TTL)
    if (fresh) found = data
  }
  if (found === undefined) {
    found = null
    let unsure = false // a source failed on its end: don't remember this as "none"
    for (const id of sources) {
      try { found = await PROVIDERS[id](track, settings) } catch (e) { found = null; if (e?.transient) unsure = true }
      if (found) break
    }
    if (found || !unsure) db.prepare('INSERT OR REPLACE INTO motion_covers (key, data, fetched_at) VALUES (?, ?, ?)').run(key, found ? JSON.stringify(found) : null, Date.now())
  }
  if (!found) return null
  const highResolution = settings.high_resolution_motion_covers === '1'
  const file = await cachedClip(found, { cacheDir, ffmpeg, highResolution })
  return file ? { file, source: found.source, tall: !!found.tall } : null
}

module.exports = { motionCoverFor, fromApple, fromTidal, fromCommunity, fromM8tec, artistsMatch, cleanTitle, norm, chooseVariant, SOURCES, DEFAULT_SOURCES, cachedClip }
