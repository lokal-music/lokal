// Addons: online sources the user adds by pasting a manifest URL, using the
// same HTTP protocol as Eclipse Music addons (eclipsemusic.app/docs), itself
// modelled on Stremio's. Lokal ships none and hosts nothing: it only talks
// to the addons the user installed, like a browser talks to the sites the
// user opens.
//
// Supported (v1): tracks; albums and artists when the manifest lists them.
//   GET <base>/manifest.json      id, name, version, resources, icon, settings
//   GET <base>/search?q=...       { tracks: [{ id, title, artist, artists: [{ id, name }], album, albumId,
//                                   trackNumber, discNumber, year, isrc, duration, artworkURL, format }] }
//   GET <base>/stream/<id>        { url, format, expiresAt, ... }
//   GET <base>/album/<id>         { id, title, artist, artistId, artworkURL, year, releaseType, tracks: [...] }   ("album")
//   GET <base>/artist/<id>        { id, name, artworkURL, albums: [{ id, title, year, releaseType, artworkURL,
//                                   trackCount }], topTracks: [...] }                                          ("artist")
// The manifest is read again now and then (refreshManifests), so an addon
// that gains resources needn't be installed again.
// <base> is the manifest URL without "/manifest.json" (it may carry the
// user's token, e.g. https://addon.example/<token>/manifest.json). The
// addon's settings (declared in its manifest, edited in Settings → Addons)
// are sent as query parameters on every request.
//
// Stored in the settings table as JSON under "addons".

const crypto = require('crypto')
const fs = require('node:fs')
const net = require('net')
const { headersForSignedAddon } = require('./httpAddonSigning')
const { extractManifest, stageAddonDash } = require('./addonDash')
const { stageHybrid } = require('./addonHybrid')

const SETTINGS_KEY = 'addons'
const TIMEOUT_MS = { manifest: 10000, search: 10000, stream: 15000, catalogue: 15000 }
const CATALOGUE_TTL_MS = 30 * 60 * 1000
const MANIFEST_MAX_AGE_MS = 6 * 60 * 60 * 1000
const MAX_BYTES = 2 * 1024 * 1024
const SEARCH_TTL_MS = 5 * 60 * 1000
const STREAM_TTL_MS = 20 * 60 * 1000
const validateSigningKey = key => {
  if (typeof key !== 'string' || key.length > 1024 || /[\x00-\x1f\x7f]/.test(key)) throw new Error('Invalid HMAC signing key.')
  return key
}
const ADAPTIVE = /\.(mpd|m3u8)(?:$|[?#])/i
// "manifest": a DASH/HLS manifest (inline or a link) the stream needs. Some
// addons always send the field, with "none" (or false / "") when the link is
// a plain file.
const NO_MANIFEST = new Set(['', 'none', 'null', 'false', '0'])
const needsManifest = manifest => manifest != null && manifest !== false && !NO_MANIFEST.has(String(manifest).trim().toLowerCase())
// Without a "format": what the quality says (a lossless Qobuz/TIDAL file is FLAC).
const FORMAT_BY_QUALITY = { lossless: 'flac', hi_res: 'flac', hi_res_lossless: 'flac', hires: 'flac' }

// Lokal says who it is (like BitChord's "BitChord"), so an addon's author can
// allow it; it never pretends to be another app.
let USER_AGENT = 'Lokal'
try { USER_AGENT = `Lokal/${require('../../package.json').version}` } catch {}

const searchCache = new Map() // `${key}\n${query}` -> { at, results }
// A search result may already contain the selected full recording URL. Keep
// it inside the main process (never expose signed media URLs to the renderer).
const inlineStreamCache = new Map() // `${key}\n${id}` -> { at, value }
const catalogueCache = new Map() // `${key}\n${path}` -> { at, value }
const streamCache = new Map() // `${key}\n${id}` -> stream
const resolving = new Map()

// Diagnostics are opt-in per request and intentionally never carry track IDs,
// add-on URLs, signed parameters, content keys, or JSON response bodies.
function report(onDiagnostic, event, details = {}) {
  try { onDiagnostic?.({ event, ...details }) } catch { /* Logging must never break playback. */ }
}

/** Short stable key for an addon (from its manifest id), used in track ids and URLs. */
function addonKey(manifestId) {
  return crypto.createHash('sha1').update(String(manifestId)).digest('hex').slice(0, 10)
}

/** The provider id an addon's results carry: "a-<key>". */
function providerFor(key) {
  return `a-${key}`
}

/** "a-<key>" -> "<key>", or null. */
function keyOfProvider(provider) {
  const m = String(provider || '').match(/^a-([0-9a-f]{10})$/)
  return m ? m[1] : null
}

function isLocalHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (net.isIPv4(h)) { const [a, b] = h.split('.').map(Number); return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) }
  return h === '::1'
}

/** An addon URL must be https (plain http only for addons on this machine or network). */
function checkUrl(raw) {
  let url
  try { url = new URL(String(raw || '').trim()) } catch { throw new Error('That is not a valid URL.') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new Error('Addons must use https:// (plain http is only allowed on this computer or your local network).')
  }
  url.hash = ''
  return url
}

const MAX_REDIRECTS = 5
const REDIRECT = new Set([301, 302, 303, 307, 308])

/**
 * GET `url`, following redirects one by one: each target is resolved against
 * the current URL and checked with checkUrl() before it is requested, so a
 * redirect can't lead to plain http on the internet (or anything else the
 * addon URL itself couldn't be).
 */
async function fetchChecked(url, { fetchImpl = fetch, signal, headers = { Accept: 'application/json' }, addonIntent = null, signingKey = '', onDiagnostic } = {}) {
  let current = checkUrl(url)
  const originalOrigin = current.origin
  for (let hop = 0; ; hop++) {
    // Sign only on the configured origin. A redirect cannot forward a
    // listener's token proof to another host, even if it repeats /a/<token>.
    const signature = current.origin === originalOrigin
      ? headersForSignedAddon(current.toString(), { intent: addonIntent, signingKey }) : {}
    const res = await fetchImpl(current.toString(), { headers: { 'User-Agent': USER_AGENT, ...headers, ...signature }, redirect: 'manual', signal })
    report(onDiagnostic, 'addon-http-status', { status: res.status, hop })
    if (!REDIRECT.has(res.status)) return res
    const location = res.headers?.get?.('location')
    try { await res.body?.cancel?.() } catch {}
    if (!location) throw new Error(`The addon redirected without saying where (HTTP ${res.status}).`)
    if (hop >= MAX_REDIRECTS) throw new Error('The addon redirected too many times.')
    let next
    try { next = new URL(location, current) } catch { throw new Error('The addon redirected to an invalid URL.') }
    try { current = checkUrl(next.toString()) } catch (e) { throw new Error(`The addon redirected to a URL Lokal won't use: ${e.message}`) }
  }
}

/** GET a JSON document from an addon, with a timeout and a size limit. */
async function getJson(url, { timeoutMs, fetchImpl = fetch, addonIntent = null, signingKey = '', onDiagnostic } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000)
  try {
    const res = await fetchChecked(url, { fetchImpl, signal: controller.signal, addonIntent, signingKey, onDiagnostic })
    const text = await res.text()
    report(onDiagnostic, 'addon-json-body', { status: res.status, bytes: Buffer.byteLength(text), json: text.trimStart().startsWith('{') || text.trimStart().startsWith('[') })
    if (text.length > MAX_BYTES) throw new Error('The addon sent too much data.')
    let json = null
    try { json = JSON.parse(text) } catch {}
    if (!res.ok) {
      // Say that the addon refused, and how: its own words plus the status.
      const said = String(json?.error || json?.message || '').slice(0, 200)
      const why = res.status === 401 || res.status === 403
        ? 'refused the request (its access may be restricted, or the link / token may no longer be valid)'
        : res.status === 429 ? 'is limiting requests right now' : `answered with an error`
      const e = new Error(`The addon ${why}${said ? `: "${said}"` : ''} (HTTP ${res.status}).`)
      e.status = res.status
      throw e
    }
    if (!json || typeof json !== 'object') throw new Error('The addon did not answer with JSON.')
    return json
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The addon took too long to answer.')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- storage

function readAll(db) {
  try {
    const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY)?.value
    const list = JSON.parse(raw || '[]')
    return Array.isArray(list) ? list.filter(a => a && a.key && a.baseUrl && a.manifest) : []
  } catch { return [] }
}

function writeAll(db, list) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(list))
  searchCache.clear()
  inlineStreamCache.clear()
  streamCache.clear()
}

/** Settings values for an addon: its manifest defaults, overridden by the user's. */
function effectiveSettings(addon) {
  const values = {}
  for (const field of Array.isArray(addon.manifest?.settings) ? addon.manifest.settings : []) {
    if (!field?.key) continue
    const v = addon.settings?.[field.key] ?? field.default
    if (v !== undefined && v !== null && v !== '') values[field.key] = String(v)
  }
  return values
}

/** What the UI may see about an addon (no base URL: it can contain the user's token). */
function publicView(addon) {
  const m = addon.manifest
  return {
    key: addon.key,
    provider: providerFor(addon.key),
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description || '',
    // An addon without an icon gets its service's (or its initial): addonBrand.js.
    icon: /^https:\/\//.test(String(m.icon || '')) ? m.icon : require('./addonBrand').addonIcon({ name: m.name, id: m.id, host: (() => { try { return new URL(addon.baseUrl).host } catch { return '' } })() }),
    resources: m.resources,
    settingsSchema: Array.isArray(m.settings) ? m.settings : [],
    settings: effectiveSettings(addon),
    hasSigningKey: !!addon.signingKey,
    enabled: addon.enabled !== false,
    host: (() => { try { return new URL(addon.baseUrl).host } catch { return '' } })(),
    installedAt: addon.installedAt || null,
  }
}

/** Installed addons, as the UI sees them. */
function list(db) {
  return readAll(db).map(publicView)
}

/** Enabled addons that can search and stream (for the source switch in search). */
function searchable(db) {
  return list(db).filter(a => a.enabled && a.resources.includes('search') && a.resources.includes('stream'))
}

function findByKey(db, key) {
  return readAll(db).find(a => a.key === key) || null
}

/**
 * Install (or update) an addon from its manifest URL.
 * @returns the installed addon (public view)
 */
async function install(db, manifestUrl, { fetchImpl, signingKey = '' } = {}) {
  validateSigningKey(signingKey)
  const url = checkUrl(manifestUrl)
  if (!/\/manifest\.json$/i.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/+$/, '')}/manifest.json`
  const baseUrl = url.toString().replace(/\/manifest\.json(?:\?.*)?$/i, '')
  const existing = readAll(db).find(a => a.baseUrl === baseUrl)
  const selectedKey = signingKey || existing?.signingKey || ''
  const manifest = await getJson(freshUrl(url), { timeoutMs: TIMEOUT_MS.manifest, fetchImpl, signingKey: selectedKey })
  return saveManifest(db, url, manifest, { signingKey: selectedKey })
}

/**
 * The manifest URL with a throwaway parameter: a CDN in front of an addon
 * (Cloudflare) can keep serving an old manifest for hours, so a new version
 * (new resources) would go unseen. Only the fetch uses it, never the saved URL.
 */
function freshUrl(url) {
  const fresh = new URL(url.toString())
  fresh.searchParams.set('lokal_fresh', String(Date.now()))
  return fresh.toString()
}

function saveManifest(db, url, manifest, { signingKey } = {}) {
  const resources = Array.isArray(manifest.resources) ? manifest.resources.filter(r => typeof r === 'string') : []
  if (!manifest.id || !manifest.name || !manifest.version) throw new Error('This is not an addon manifest (id, name and version are required).')
  if (!resources.includes('search') || !resources.includes('stream')) throw new Error('This addon cannot search and stream tracks, so Lokal cannot use it.')
  const clean = {
    id: String(manifest.id).slice(0, 200),
    name: String(manifest.name).slice(0, 100),
    version: String(manifest.version).slice(0, 40),
    description: String(manifest.description || '').slice(0, 500),
    icon: String(manifest.icon || '').slice(0, 1000),
    resources,
    types: Array.isArray(manifest.types) ? manifest.types.slice(0, 10) : [],
    settings: Array.isArray(manifest.settings) ? manifest.settings.slice(0, 30) : [],
  }
  const key = addonKey(clean.id)
  const baseUrl = url.toString().replace(/\/manifest\.json(?:\?.*)?$/i, '')
  const all = readAll(db)
  const existing = all.find(a => a.key === key)
  const addon = { key, baseUrl, manifest: clean, enabled: existing ? existing.enabled !== false : true, settings: existing?.settings || {}, signingKey: signingKey === undefined ? existing?.signingKey || '' : validateSigningKey(signingKey), installedAt: existing?.installedAt || Date.now(), manifestAt: Date.now() }
  // Updating keeps its place among the addons (the playback order lists them).
  writeAll(db, existing ? all.map(a => (a.key === key ? addon : a)) : [...all, addon])
  return publicView(addon)
}

const refreshing = new Set()
/**
 * Read installed addons' manifests again when the copy is older than
 * `maxAgeMs` (new resources, settings, name), keeping the user's settings.
 * Failures are quiet: the saved manifest stays.
 */
async function refreshManifests(db, { fetchImpl, maxAgeMs = MANIFEST_MAX_AGE_MS } = {}) {
  const due = readAll(db).filter(a => !refreshing.has(a.key) && !(Date.now() - (a.manifestAt || 0) < maxAgeMs))
  await Promise.all(due.map(async addon => {
    refreshing.add(addon.key)
    try {
      const url = new URL(`${addon.baseUrl}/manifest.json`)
      const manifest = await getJson(freshUrl(url), { timeoutMs: TIMEOUT_MS.manifest, fetchImpl, signingKey: addon.signingKey || '' })
      // The same addon only: a manifest that changed its id is a different one.
      if (addonKey(String(manifest?.id || '').slice(0, 200)) === addon.key) saveManifest(db, url, manifest)
    } catch {} finally { refreshing.delete(addon.key) }
  }))
  return list(db)
}

function remove(db, key) {
  writeAll(db, readAll(db).filter(a => a.key !== key))
  return { ok: true }
}

function setEnabled(db, key, enabled) {
  writeAll(db, readAll(db).map(a => (a.key === key ? { ...a, enabled: !!enabled } : a)))
  return { ok: true }
}

/** Save the user's values for an addon's settings (only keys its manifest declares). */
function setSettings(db, key, values = {}, { signingKey } = {}) {
  if (signingKey !== undefined) validateSigningKey(signingKey)
  writeAll(db, readAll(db).map(a => {
    if (a.key !== key) return a
    const allowed = new Set((a.manifest.settings || []).map(f => f?.key).filter(Boolean))
    const next = {}
    for (const [k, v] of Object.entries(values || {})) if (allowed.has(k)) next[k] = typeof v === 'boolean' || typeof v === 'number' ? v : String(v ?? '').slice(0, 500)
    return { ...a, settings: next, signingKey: signingKey === undefined ? a.signingKey || '' : signingKey }
  }))
  return { ok: true }
}

/** <base><path>?<addon settings>&<extra> */
function endpoint(addon, path, extra = {}) {
  const url = new URL(`${addon.baseUrl}${path}`)
  for (const [k, v] of Object.entries(effectiveSettings(addon))) url.searchParams.set(k, v)
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  return url.toString()
}

// ---------------------------------------------------------------- search & stream

/** Seconds from an addon track (duration in s, or durationMs). */
function durationOf(t) {
  if (Number(t.durationMs) > 0) return Math.round(Number(t.durationMs) / 1000)
  const d = Number(t.duration)
  if (!(d > 0)) return null
  return d > 36000 ? Math.round(d / 1000) : Math.round(d) // some send ms in "duration"
}

const idOf = value => (value == null || value === '' ? null : String(value).slice(0, 300))
const positive = value => (Number(value) > 0 ? Math.floor(Number(value)) : null)
const httpsImage = value => (/^https:\/\//.test(String(value || '')) ? String(value).slice(0, 1000) : null)
const RELEASE_TYPES = new Set(['album', 'single', 'ep', 'compilation', 'live'])

/** One addon track, as Lokal's online results carry it. */
function trackOf(t, provider) {
  const name = artist => String(typeof artist === 'object' ? artist?.name || '' : artist || '').slice(0, 500)
  const artistList = Array.isArray(t.artists) ? t.artists.filter(a => name(a)) : []
  const artists = artistList.map(name)
  if (!artists.length && name(t.artist)) artists.push(name(t.artist))
  // Add-ons use both a plain album string and an album object. Amazon-style
  // results commonly put the display name in `album.name`, so normalize that
  // before the track is saved as the player's current track. Without it the
  // player hides its album navigation controls while the song is streaming.
  const album = t.album && typeof t.album === 'object'
    ? t.album.title || t.album.name || t.album.albumName || t.album.album_name
    : t.album
  const albumId = t.albumId ?? t.album_id ?? (typeof t.album === 'object' ? t.album?.id ?? t.album?.albumId ?? t.album?.album_id : null)
  return {
    provider,
    id: String(t.id).slice(0, 300),
    title: String(t.title).slice(0, 500),
    artist: name(t.artist) || artists.join(', '),
    artists,
    // The addon's ids: its artists (told apart from namesakes) and album.
    artistIds: artistList.length ? artistList.map(a => (typeof a === 'object' ? idOf(a.id) : null)) : [],
    album: album ? String(album).slice(0, 500) || null : null,
    albumId: idOf(albumId),
    track_num: positive(t.trackNumber),
    disc_num: positive(t.discNumber),
    year: positive(t.year),
    isrc: t.isrc ? String(t.isrc).slice(0, 20) : null,
    genre: typeof t.genre === 'string' && t.genre.trim() ? t.genre.trim().slice(0, 100) : null,
    duration: durationOf(t),
    thumbnail: httpsImage(t.artworkURL || t.albumArtworkURL || t.artworkUrl || t.albumArtworkUrl || t.coverUrl || t.thumbnailUrl || t.artwork || t.thumbnail),
    quality: t.format ? String(t.format).slice(0, 40) : null,
    kind: 'song',
  }
}

/** Tracks from an addon's /search. */
async function search(db, key, query, { fetchImpl, limit = 20, timeoutMs = TIMEOUT_MS.search, onDiagnostic } = {}) {
  const addon = findByKey(db, key)
  if (!addon || addon.enabled === false) throw new Error('This addon is not installed or is turned off.')
  const q = String(query || '').trim()
  if (q.length < 2) return []
  const cacheKey = `${key}\n${q.toLowerCase()}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) {
    report(onDiagnostic, 'search-cache-hit', { count: cached.results.length })
    return cached.results.slice(0, limit)
  }
  const json = await getJson(endpoint(addon, '/search', { q }), { timeoutMs, fetchImpl, addonIntent: 'stream', signingKey: addon.signingKey || '', onDiagnostic })
  const provider = providerFor(key)
  const rows = [json.tracks, json.data?.tracks, json.results, json.items].find(Array.isArray) || []
  report(onDiagnostic, 'search-payload', {
    shape: Array.isArray(json.tracks) ? 'tracks' : Array.isArray(json.data?.tracks) ? 'data.tracks'
      : Array.isArray(json.results) ? 'results' : Array.isArray(json.items) ? 'items' : 'missing',
    received: rows.length,
    valid: rows.filter(t => t && t.id != null && t.title).length,
  })
  const results = rows
    .filter(t => t && t.id != null && t.title)
    .map(t => {
      const track = trackOf(t, provider)
      // Mobile can play an already resolved streamURL from search. Cache only
      // obvious progressive media: opaque endpoints may return JSON or an MPD
      // and must still be resolved through /stream rather than sent to audio.
      if (typeof t.streamURL === 'string' && t.streamURL.length < 8192 &&
          !t.preview && !t.isPreview && !t.previewOnly && !t.isSample &&
          t.encrypted !== true && !t.drm && !Object.keys(t.headers || {}).length) {
        try {
          const direct = new URL(require('./addonDash').guardMediaUrl(t.streamURL, addon.baseUrl))
          if (/\.(?:flac|mp3|m4a|mp4|ogg|opus|wav|aac|webm)$/i.test(direct.pathname)) {
            if (inlineStreamCache.size >= 200) inlineStreamCache.delete(inlineStreamCache.keys().next().value)
            inlineStreamCache.set(`${key}\n${track.id}`, { at: Date.now(), value: { ...t, url: direct.toString() } })
          }
        } catch { /* The normal /stream path remains available. */ }
      }
      return track
    })
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value)
  searchCache.set(cacheKey, { at: Date.now(), results })
  report(onDiagnostic, 'search-normalized', { count: results.length, withArtwork: results.filter(t => !!t.thumbnail).length })
  return results.slice(0, limit)
}

/** A cached catalogue request (/album, /artist) of an addon that declares `resource`. */
async function catalogue(db, key, resource, id, { fetchImpl } = {}) {
  const addon = findByKey(db, key)
  if (!addon || addon.enabled === false) throw new Error('This addon is not installed or is turned off.')
  if (!addon.manifest.resources.includes(resource)) throw new Error(`This addon has no ${resource} pages.`)
  const path = `/${resource}/${encodeURIComponent(String(id || '').slice(0, 300))}`
  const cacheKey = `${key}\n${path}`
  const cached = catalogueCache.get(cacheKey)
  if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.value
  const json = await getJson(endpoint(addon, path), { timeoutMs: TIMEOUT_MS.catalogue, fetchImpl, addonIntent: 'stream', signingKey: addon.signingKey || '' })
  if (catalogueCache.size > 100) catalogueCache.delete(catalogueCache.keys().next().value)
  catalogueCache.set(cacheKey, { at: Date.now(), value: json })
  return json
}

/** An album, its tracks in order: { id, title, artist, artistId, artwork_url, year, release_type, tracks }. */
async function album(db, key, id, options = {}) {
  const json = await catalogue(db, key, 'album', id, options)
  const provider = providerFor(key)
  const artwork = httpsImage(json.artworkURL || json.artwork)
  const tracks = (Array.isArray(json.tracks) ? json.tracks : [])
    .filter(t => t && t.id != null && t.title)
    .map(t => {
      const track = trackOf(t, provider)
      return { ...track, album: track.album || String(json.title || '').slice(0, 500), albumId: track.albumId || idOf(json.id), thumbnail: track.thumbnail || artwork }
    })
    .sort((a, b) => (a.disc_num || 1) - (b.disc_num || 1) || (a.track_num || 1e4) - (b.track_num || 1e4))
  return {
    provider, id: idOf(json.id) || String(id), title: String(json.title || '').slice(0, 500), artist: String(json.artist || '').slice(0, 500),
    artistId: idOf(json.artistId), artwork_url: artwork, year: positive(json.year),
    release_type: RELEASE_TYPES.has(json.releaseType) ? json.releaseType : 'album', tracks,
  }
}

/** An artist: { id, name, image, albums: [{ albumId, title, year, release_type, artwork_url, track_count }], tracks }. */
async function artist(db, key, id, options = {}) {
  const json = await catalogue(db, key, 'artist', id, options)
  const provider = providerFor(key)
  const name = String(json.name || '').slice(0, 500)
  return {
    provider, id: idOf(json.id) || String(id), name, image: httpsImage(json.artworkURL || json.artwork),
    albums: (Array.isArray(json.albums) ? json.albums : []).filter(a => a && a.id != null && a.title).slice(0, 300).map(a => ({
      provider, albumId: idOf(a.id), title: String(a.title).slice(0, 500), artist: name, year: positive(a.year),
      release_type: RELEASE_TYPES.has(a.releaseType) ? a.releaseType : 'album', artwork_url: httpsImage(a.artworkURL || a.artwork), track_count: positive(a.trackCount),
    })),
    tracks: (Array.isArray(json.topTracks) ? json.topTracks : []).filter(t => t && t.id != null && t.title).slice(0, 50).map(t => trackOf(t, provider)),
  }
}

const MIME = { flac: 'audio/flac', mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm' }

/**
 * Addons don't all spell their stream format the same way. Eclipse-compatible
 * responses may provide format, container and codec separately, and some put
 * bit depth / sample rate into a descriptive format string (e.g. "FLAC 24-bit
 * / 192 kHz"). Normalize the common audio names before choosing a MIME type.
 */
function normalizeAudioFormat(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  if (/\bflac\b|free lossless audio codec/.test(raw)) return 'flac'
  if (/\b(?:mp3|mpeg|mpga)\b/.test(raw)) return 'mp3'
  if (/\b(?:aac|mp4a)(?:[.\s;-]|$)/.test(raw)) return 'aac'
  if (/\bm4a\b/.test(raw)) return 'm4a'
  if (/\bmp4\b/.test(raw)) return 'mp4'
  if (/\bopus\b/.test(raw)) return 'opus'
  if (/\b(?:ogg|oga|vorbis)\b/.test(raw)) return 'ogg'
  if (/\b(?:wav|wave|pcm)\b/.test(raw)) return 'wav'
  if (/\bwebm\b/.test(raw)) return 'webm'
  return ''
}

/** Determine the direct stream's format without trusting a display-quality label alone. */
function streamFormat(json, url) {
  // Prefer the addon's explicit format, then its container. The URL extension
  // describes the bytes being fetched; codec is the fallback when neither is
  // useful (e.g. a signed URL ending in an opaque id).
  for (const value of [json.format, json.container, json.mimeType, json.mime]) {
    const format = normalizeAudioFormat(value)
    if (MIME[format]) return format
  }
  try {
    const extension = new URL(url).pathname.match(/\.([^.\/]+)$/)?.[1]
    const format = normalizeAudioFormat(extension)
    if (MIME[format]) return format
  } catch {}
  const codec = normalizeAudioFormat(json.codec)
  if (MIME[codec]) return codec
  const quality = String(json.quality || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return FORMAT_BY_QUALITY[quality] || ''
}

/** The audio URL for an addon track (from its /stream), cached until it expires. */
async function resolveStream(db, key, id, { fetchImpl, force = false, download = false, timeoutMs = TIMEOUT_MS.stream, onDiagnostic } = {}) {
  const addon = findByKey(db, key)
  if (!addon || addon.enabled === false) throw new Error('This addon is not installed or is turned off.')
  // Playback and download use separate intent-scoped caches.
  const cacheKey = `${key}\n${id}\n${download ? 'download' : 'stream'}`
  const cached = streamCache.get(cacheKey)
  // A deferred shared-cache trim may have removed a previously staged file.
  // Never return a dead file reference from the TTL cache.
  if (!force && cached && cached.expiresAt > Date.now() &&
      (!cached.file || fs.existsSync(cached.file))) {
    report(onDiagnostic, 'resolve-cache-hit', { transport: cached.type || 'url' })
    return cached
  }
  if (!force && resolving.has(cacheKey)) {
    report(onDiagnostic, 'resolve-inflight')
    return resolving.get(cacheKey)
  }
  // LastWave may wrap the real audio inside "stream" and/or "data".
  // Its default format=manifest="dash" is not proof that the returned URL
  // is an MPD. Prefer actual audio bytes, then a *real* DASH plan.
  const job = (async () => {
    const url = endpoint(addon, `/stream/${encodeURIComponent(id)}`)
    const options = { timeoutMs, fetchImpl, addonIntent: download ? 'download' : 'stream', signingKey: addon.signingKey || '' }
    let raw
    const inline = inlineStreamCache.get(`${key}\n${id}`)
    // An explicit quality setting must be resolved by the add-on, not by an
    // inline URL that may point to a different tier.
    const qualitySelected = Object.keys(addon.settings || {}).some(name => /quality|format|codec|bitrate/i.test(name))
    const useInline = !force && !download && !qualitySelected && inline &&
      Date.now() - inline.at < SEARCH_TTL_MS
    report(onDiagnostic, 'resolve-start', { source: useInline ? 'search-inline' : 'stream-endpoint', download: !!download, forced: !!force, qualitySelected })
    options.onDiagnostic = onDiagnostic
    if (useInline) raw = inline.value
    else try { raw = await getJson(url, options) }
    catch (error) {
      // Mobile retries transient stream minting errors once, preserving the
      // exact signing/intent scope; never retry auth or entitlement failures.
      if (error?.status !== 502 && error?.status !== 503) throw error
      raw = await getJson(url, options)
    }
    const layers = [raw, raw.data, raw.stream, raw.data?.stream]
      .filter(layer => layer && typeof layer === 'object' && !Array.isArray(layer))
    const json = Object.assign({}, ...layers)
    for (const layer of layers) {
      if (layer.drm != null && layer.drm !== false) throw new Error('This add-on requires DRM, which Lokal cannot play.')
      if (layer.headers && Object.keys(layer.headers).length) throw new Error('This add-on requires unsupported media headers.')
      if (layer.encrypted != null && layer.encrypted !== false && !json.hybrid)
        throw new Error('This add-on returned encrypted media without a supported hybrid plan.')
    }
    // Hybrid plans contain the content key and CDN ranges; keep them in the
    // Electron process, never forward them to the renderer or playback URL.
    const candidates = ['url', 'directUrl', 'streamURL', 'streamUrl', 'downloadURL', 'downloadUrl', 'mediaURL', 'mediaUrl']
      .map(name => json[name]).filter(value => typeof value === 'string' && value.trim() && !value.startsWith('data:'))
    const progressive = candidates.map(value => {
      try { return checkUrl(value).toString() } catch { return null }
    }).filter(Boolean).filter(value => !ADAPTIVE.test(value))
    const explicit = progressive.find(value => /\.(?:flac|mp3|m4a|mp4|ogg|opus|wav|aac|webm)(?:[?#]|$)/i.test(value))
    const manifest = explicit || json.hybrid ? null : extractManifest(json, addon.baseUrl)
    report(onDiagnostic, 'stream-payload', {
      nestedData: !!raw.data, nestedStream: !!raw.stream || !!raw.data?.stream,
      candidateUrls: candidates.length, progressiveUrls: progressive.length,
      explicitAudio: !!explicit, hybrid: !!json.hybrid,
      dash: !!manifest, hasQuality: !!json.quality,
    })
    let stream
    if (json.hybrid) {
      report(onDiagnostic, 'transport-selected', { transport: 'hybrid' })
      const file = await stageHybrid(json.hybrid, addon.baseUrl, {
        fetchImpl, key: cacheKey, onDiagnostic,
      })
      stream = { type: 'file', file, url: null, headers: {},
        mime: 'audio/mp4', format: 'm4a', quality: json.quality || null,
        expiresAt: Date.now() + STREAM_TTL_MS }
    } else if (manifest) {
      report(onDiagnostic, 'transport-selected', { transport: 'dash', inlineManifest: !!manifest.xml })
      const file = await stageAddonDash(manifest, addon.baseUrl, {
        fetchImpl, key: cacheKey, onDiagnostic,
      })
      stream = { type: 'file', file, url: null, headers: {},
        mime: 'audio/mp4', format: 'm4a', quality: json.quality || null,
        expiresAt: Date.now() + STREAM_TTL_MS }
    } else {
      const direct = explicit || progressive[0]
      if (!direct) throw new Error('The addon gave no playable audio link or supported DASH manifest.')
      // The protocol string "dash" is a LastWave default, not a media
      // transport indicator when the URL itself points to progressive audio.
      for (const value of [json.mediaType, json.container, json.mimeType]) {
        if (/\b(?:hls|mpegurl|m3u8|mpd)\b/i.test(String(value || ''))) {
          throw new Error('This addon streams an unsupported adaptive format.')
        }
      }
      const format = streamFormat(json, direct)
      report(onDiagnostic, 'transport-selected', { transport: 'url', format: format || 'unknown' })
      stream = { url: direct, headers: {}, mime: MIME[format] || 'audio/*',
        expiresAt: Math.max(Date.now() + 30000,
          Number(json.expiresAt) > 0 ? Number(json.expiresAt) * (Number(json.expiresAt) < 1e12 ? 1000 : 1) - 60000 : Date.now() + STREAM_TTL_MS),
        format: format || null, quality: json.quality || null }
    }
    if (streamCache.size > 200) streamCache.delete(streamCache.keys().next().value)
    streamCache.set(cacheKey, stream)
    report(onDiagnostic, 'resolve-complete', { transport: stream.type || 'url', format: stream.format || 'unknown' })
    return stream
  })().catch(error => {
    report(onDiagnostic, 'resolve-failed', { status: Number(error?.status) || null, name: error?.name || 'Error' })
    throw error
  }).finally(() => resolving.delete(cacheKey))
  resolving.set(cacheKey, job)
  return job
}

module.exports = {
  addonKey, providerFor, keyOfProvider, checkUrl, getJson, fetchChecked,
  list: db => [...list(db), ...packageList(db)],
  searchable: db => [...searchable(db), ...packageList(db).filter(a => a.enabled && !a.linksOnly && a.resources.includes('search'))],
  install: (db, url, options) => /\.(sflx|spotiflac-ext)(?:[?#]|$)/i.test(String(url)) ? packageService(db).install({ url }) : install(db, url, options),
  remove: (db, key) => optionalPackages(db)?.find(key) ? packageService(db).remove(key) : remove(db, key),
  setEnabled: (db, key, enabled) => optionalPackages(db)?.find(key) ? packageService(db).setEnabled(key, enabled) : setEnabled(db, key, enabled),
  setSettings: (db, key, values, options) => optionalPackages(db)?.find(key) ? packageService(db).setSettings(key, values) : setSettings(db, key, values, options),
  refreshManifests,
  search: (db, key, query, options) => optionalPackages(db)?.find(key) ? packageService(db).search(key, query, options) : search(db, key, query, options),
  resolveStream: (db, key, id, options) => optionalPackages(db)?.find(key) ? require('../mornye/media').resolve(db, key, id, options) : resolveStream(db, key, id, options),
  findByKey: (db, key) => findByKey(db, key) || optionalPackages(db)?.find(key),
  album: (db, key, id, options) => optionalPackages(db)?.find(key) ? packageService(db).album(key, id) : album(db, key, id, options),
  artist: (db, key, id, options) => optionalPackages(db)?.find(key) ? packageService(db).artist(key, id) : artist(db, key, id, options),
  trackOf, packageService,
}

function packageService(db) { return require('../mornye/packages').service(db) }
// A failing package service must not take the HTTP addons down with it.
function packageList(db) {
  try { return optionalPackages(db)?.list() || [] } catch (error) { console.warn('[addons] Mornye packages unavailable:', error.message); return [] }
}
function optionalPackages(db) { return typeof db?.exec === 'function' ? packageService(db) : null }
