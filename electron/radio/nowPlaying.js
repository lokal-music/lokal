// Online radio: what a station is playing now, from the station's own API
// (the catalogue's optional `api` field). The stream itself only says
// "Artist - Title"; these add a cover, the album, lyrics, the song's length.
// Every adapter returns the same shape:
//   { artist, title, album?, year?, genre?, cover?, lyrics?, duration?, elapsed? }
// or null when the station's API has nothing (or isn't reachable).

const TIMEOUT_MS = 8000
const RECORD_STATIONS_TTL_MS = 24 * 60 * 60 * 1000

const str = value => (value == null ? '' : String(value).trim())
// A length in seconds: a number, or "m:ss" / "h:mm:ss" text.
const num = value => {
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(str(value))
  if (clock) {
    const seconds = clock[3] != null ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(clock[1]) * 60 + Number(clock[2])
    return seconds > 0 ? seconds : undefined
  }
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined
}
const httpUrl = value => (/^https?:\/\//i.test(str(value)) ? str(value) : undefined)

const RATE_LIMIT_RETRY_MS = 1500

// One JSON can answer for every station of a network (Nova's): a station list
// asking for each of them at once shares one request for a few seconds.
const JSON_TTL_MS = 8000
const jsonCache = new Map() // url -> { at, pending }
function getJson(url, fetchImpl, options = {}) {
  if (fetchImpl !== globalThis.fetch) return getJsonUncached(url, fetchImpl, options)
  const key = `${options.publicOnly ? 'p:' : ''}${url}`
  const hit = jsonCache.get(key)
  if (hit && Date.now() - hit.at < JSON_TTL_MS) return hit.pending
  const pending = getJsonUncached(url, fetchImpl, options)
  jsonCache.set(key, { at: Date.now(), pending })
  pending.then(data => { if (data == null) jsonCache.delete(key) })
  if (jsonCache.size > 50) jsonCache.delete(jsonCache.keys().next().value)
  return pending
}

async function getJsonUncached(url, fetchImpl, { retryRateLimit = true, publicOnly = false } = {}) {
  const { isPublicHttpUrl } = require('../online/publicUrl')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let target = new URL(String(url))
    let response = null
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (publicOnly && !(await isPublicHttpUrl(target.href, { resolveDns: fetchImpl === globalThis.fetch }))) return null
      response = await fetchImpl(target.href, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/json' } })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers?.get?.('location')
      try { await response.body?.cancel?.() } catch {}
      if (!location || redirects === 5) return null
      target = new URL(location, target)
      response = null
    }
    if (!response) return null
    // Too many requests in a row (Radio Record answers 429 to back-to-back
    // ones): once more after a pause.
    if (response.status === 429 && retryRateLimit) {
      clearTimeout(timer)
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_RETRY_MS))
      return getJsonUncached(target.href, fetchImpl, { retryRateLimit: false, publicOnly })
    }
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Drop empty fields; null when there's no song at all. */
function clean(song) {
  if (!song) return null
  const out = {}
  for (const [key, value] of Object.entries(song)) if (value !== undefined && value !== '' && value !== null) out[key] = value
  return out.title || out.artist ? out : null
}

/** Split "Artist - Title" (the first " - "); no separator: all of it is the title. */
function splitText(text) {
  const value = str(text)
  const at = value.indexOf(' - ')
  return at > 0 ? { artist: value.slice(0, at).trim(), title: value.slice(at + 3).trim() } : { artist: '', title: value }
}

// AzuraCast: /api/nowplaying/<station> (one station) or /api/nowplaying (all).
function fromAzuracast(data, api) {
  let entry = data
  if (Array.isArray(data)) {
    const wanted = str(api.station).toLowerCase()
    entry = data.find(item => wanted && [str(item?.station?.shortcode).toLowerCase(), str(item?.station?.id)].includes(wanted)) || data[0]
  }
  const now = entry?.now_playing
  const song = now?.song
  if (!song) return null
  const fallback = splitText(song.text)
  return clean({
    artist: str(song.artist) || fallback.artist,
    title: str(song.title) || fallback.title,
    album: str(song.album),
    genre: str(song.genre),
    lyrics: str(song.lyrics),
    cover: httpUrl(song.art),
    duration: num(now.duration),
    elapsed: num(now.elapsed),
  })
}

// Radio Record: /api/stations/now/ lists every station's song by numeric id;
// the catalogue may name the station by its prefix ("rap"), looked up once a day.
// One answer covers every Record station, so it's shared for a few seconds
// (and between lookups running at once): Record refuses requests in a row.
const RECORD_NOW_TTL_MS = 4000
let recordStations = { at: 0, map: null }
let recordNow = { at: 0, data: null, pending: null }
function recordNowPlaying(fetchImpl, publicOnly = false) {
  if (recordNow.data && Date.now() - recordNow.at < RECORD_NOW_TTL_MS) return Promise.resolve(recordNow.data)
  if (recordNow.pending) return recordNow.pending
  const pending = getJson('https://www.radiorecord.ru/api/stations/now/', fetchImpl, { publicOnly })
    .then(data => {
      if (data) recordNow = { at: Date.now(), data, pending: null }
      else recordNow = { ...recordNow, pending: null }
      return data
    })
  recordNow = { ...recordNow, pending }
  return pending
}
async function recordStationId(station, fetchImpl, publicOnly = false) {
  if (/^\d+$/.test(station)) return Number(station)
  if (!recordStations.map || Date.now() - recordStations.at > RECORD_STATIONS_TTL_MS) {
    const data = await getJson('https://www.radiorecord.ru/api/stations/', fetchImpl, { publicOnly })
    const list = data?.result?.stations
    if (!Array.isArray(list)) return null
    recordStations = { at: Date.now(), map: new Map(list.map(item => [str(item.prefix).toLowerCase(), Number(item.id)])) }
  }
  return recordStations.map.get(station.toLowerCase()) ?? null
}

function fromRadioRecord(data, id) {
  const entry = (Array.isArray(data?.result) ? data.result : []).find(item => Number(item?.id) === id)
  const track = entry?.track
  if (!track) return null
  return clean({
    artist: str(track.artist),
    title: str(track.song),
    cover: httpUrl(track.image600) || httpUrl(track.image200) || httpUrl(track.image100),
  })
}

// laut.fm: api.laut.fm/station/<name>/current_song
function fromLautfm(data) {
  if (!data || typeof data !== 'object') return null
  const started = Date.parse(str(data.started_at).replace(' ', 'T').replace(/ ([+-]\d\d)(\d\d)$/, '$1:$2'))
  const length = num(data.length)
  return clean({
    artist: str(data.artist?.name),
    title: str(data.title),
    album: str(data.album),
    genre: str(data.genre),
    year: num(data.releaseyear),
    duration: length,
    elapsed: Number.isFinite(started) ? Math.max(0, (Date.now() - started) / 1000) : undefined,
  })
}

/** `a.b[0].c` inside `data`. */
function pick(data, path) {
  if (!path) return undefined
  let value = data
  for (const part of String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (value == null) return undefined
    value = value[part]
  }
  return value
}

// Any other JSON API: the catalogue says where each field is.
// A list answering for several stations (one JSON for all of a network's
// radios): `match` is "path=value", the entry whose `path` is `value`.
function selectEntry(data, match) {
  if (!match) return data
  // Some broadcasters (notably Radio Nova) return { radios: [...] }
  // rather than an array at the root. The mobile adapter already supports
  // both shapes; the desktop adapter previously read an empty currentTrack.
  const entries = Array.isArray(data) ? data
    : Array.isArray(data?.radios) ? data.radios
      : null
  if (!entries) return data
  const at = String(match).indexOf('=')
  if (at < 1) return null // never guess the first radio on a shared feed
  const path = match.slice(0, at).trim()
  const value = match.slice(at + 1).trim()
  return entries.find(item => str(pick(item, path)) === value) ?? null
}

function fromJson(data, api) {
  data = selectEntry(data, api.match)
  if (data == null) return null
  const fallback = api.text ? splitText(pick(data, api.text)) : { artist: '', title: '' }
  return clean({
    artist: str(pick(data, api.artist)) || fallback.artist,
    title: str(pick(data, api.title)) || fallback.title,
    album: str(pick(data, api.album)),
    lyrics: str(pick(data, api.lyrics)),
    cover: httpUrl(pick(data, api.cover)),
    duration: num(pick(data, api.duration)),
    elapsed: num(pick(data, api.elapsed)),
  })
}

// A station whose API gives no cover: the song's artwork from iTunes' public
// search, when the song is there (matched on title and artist, so another
// song's cover is never put on it). Kept per song: it's asked once.
const coverCache = new Map()
const normalize = value => str(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
async function coverFor(song, fetchImpl) {
  const key = `${normalize(song.artist)}|${normalize(song.title)}`
  if (coverCache.has(key)) return coverCache.get(key)
  let cover
  try {
    const query = new URLSearchParams({ term: `${song.artist} ${song.title}`.trim(), media: 'music', entity: 'song', limit: '5' })
    const data = await getJson(`https://itunes.apple.com/search?${query}`, fetchImpl)
    const wantedTitle = normalize(song.title)
    const wantedArtist = normalize(song.artist)
    const hit = (Array.isArray(data?.results) ? data.results : []).find(item => {
      const title = normalize(item.trackName)
      const artist = normalize(item.artistName)
      return (title === wantedTitle || title.startsWith(`${wantedTitle} `)) && (!wantedArtist || artist.includes(wantedArtist) || wantedArtist.includes(artist))
    })
    cover = httpUrl(hit?.artworkUrl100)?.replace(/\/\d+x\d+bb\./, '/600x600bb.')
  } catch {}
  if (coverCache.size > 200) coverCache.delete(coverCache.keys().next().value)
  coverCache.set(key, cover)
  return cover
}

/** What the station's API says is playing, or null; its cover from iTunes when the API has none. */
async function nowPlaying(api, options = {}) {
  const song = await nowPlayingFromApi(api, options)
  if (song && !song.cover && song.title) {
    const cover = await coverFor(song, options.fetchImpl || fetch)
    if (cover) return { ...song, cover }
  }
  return song
}

/** What the station's API says is playing, or null. */
async function nowPlayingFromApi(api, { fetchImpl = fetch, publicOnly = false } = {}) {
  const type = str(api?.type).toLowerCase()
  try {
    if (type === 'azuracast') return fromAzuracast(await getJson(api.url, fetchImpl, { publicOnly }), api)
    if (type === 'radiorecord') {
      const id = await recordStationId(str(api.station), fetchImpl, publicOnly)
      if (id == null) return null
      return fromRadioRecord(await recordNowPlaying(fetchImpl, publicOnly), id)
    }
    if (type === 'lautfm') return fromLautfm(await getJson(`https://api.laut.fm/station/${encodeURIComponent(str(api.station))}/current_song`, fetchImpl, { publicOnly }))
    if (type === 'json') return fromJson(await getJson(api.url, fetchImpl, { publicOnly }), api)
  } catch {}
  return null
}

module.exports = { nowPlaying, coverFor, fromAzuracast, fromRadioRecord, fromLautfm, fromJson, pick, splitText }
