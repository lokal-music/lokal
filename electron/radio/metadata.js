// Low-cost metadata for visible Radio Browser stations. We never open the
// audio stream to inspect another station's current track.
const { isPublicHttpUrl } = require('../online/publicUrl')

const { nowPlaying, coverFor } = require('./nowPlaying')

const NOVA_METADATA_URL = 'https://www.nova.fr/radios-data/www.nova.fr/all.json'
// These are the broadcaster's official stream hosts, carried over from
// Lokal's original radios.json catalog. Do not infer an API from a name alone.
const NOVA_HOSTS = {
  'radionova.ice.infomaniak.ch': 'radio-nova',
  'nova-vnt.ice.infomaniak.ch': 'nova-classics',
  'nova-ln.ice.infomaniak.ch': 'nova-lanuit',
  'nova-dance.ice.infomaniak.ch': 'nova-danse',
  'nova-odn.ice.infomaniak.ch': 'nova-hip-hop',
  'nova-reggae.ice.infomaniak.ch': 'nova-reggae',
  'nova-soul.ice.infomaniak.ch': 'nova-soul',
  'nova-nouvo.ice.infomaniak.ch': 'nouvo-nova',
  'novalaplage.ice.infomaniak.ch': 'nova-la-plage',
}

function broadcasterApiForStation(station) {
  try {
    const stream = new URL(station?.url)
    const code = NOVA_HOSTS[stream.hostname.toLowerCase()]
    if (!code) return null
    return {
      type: 'json', url: NOVA_METADATA_URL,
      match: 'radio.code=' + code,
      artist: 'currentTrack.artist', title: 'currentTrack.title',
      cover: 'currentTrack.image', duration: 'currentTrack.duration',
    }
  } catch { return null }
}

const CACHE_SUCCESS_MS = 60000
const CACHE_FAILURE_MS = 5 * 60000
const MAX_CONCURRENT = 3
const MAX_BODY = 512 * 1024
const cache = new Map() // origin -> { until, pending }
let active = 0
const waiting = []

function withSlot(task) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++
      try { resolve(await task()) } catch (error) { reject(error) }
      finally {
        active--
        const next = waiting.shift()
        if (next) next()
      }
    }
    if (active < MAX_CONCURRENT) run()
    else waiting.push(run)
  })
}

function statusUrl(streamUrl) {
  try {
    const stream = new URL(streamUrl)
    if (!['http:', 'https:'].includes(stream.protocol) || stream.username || stream.password) return null
    return new URL('/status-json.xsl', stream.origin).href
  } catch { return null }
}

function parseIcecast(data, streamUrl) {
  const sources = data?.icestats?.source
  if (!sources) return null
  const rows = Array.isArray(sources) ? sources : [sources]
  const wanted = (() => { try { return new URL(streamUrl).pathname } catch { return '' } })()
  const matching = rows.find(item => {
    if (typeof item !== 'object' || !item) return false
    try { return new URL(item.listenurl).pathname === wanted } catch { return false }
  })
  // Do not misattribute a different mount on a shared radio host.
  const source = matching || (rows.length === 1 ? rows[0] : null)
  if (!source) return null
  const value = String(source.title || source.song || '').trim().slice(0, 300)
  if (!value || /^unknown|^offline$/i.test(value)) return null
  const split = value.indexOf(' - ')
  return split > 0 && split < value.length - 3
    ? { artist: value.slice(0, split), title: value.slice(split + 3) }
    : { artist: '', title: value }
}


// Generic broadcaster adapters. Never infer a live song from Radio Browser
// directory fields: they describe stations, not the current recording.
function sameStreamUrl(a, b) {
  try {
    const left = new URL(a), right = new URL(b)
    return left.protocol === right.protocol && left.host.toLowerCase() === right.host.toLowerCase()
      && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '')
  } catch { return false }
}

function parseAzuraCast(data, streamUrl) {
  const rows = Array.isArray(data) ? data : data?.now_playing ? [data] : []
  const entry = rows.find(row => {
    const links = [row?.station?.listen_url,
      ...(Array.isArray(row?.station?.mounts) ? row.station.mounts.map(m => m.url || m.listen_url) : []),
      ...(Array.isArray(row?.station?.remotes) ? row.station.remotes.map(m => m.url || m.listen_url) : [])]
    return links.some(link => sameStreamUrl(link, streamUrl))
  })
  if (!entry?.now_playing?.song) return null
  const song = entry.now_playing.song
  const text = String(song.text || '').trim()
  const parsed = parseTitle(text)
  const title = String(song.title || parsed.title || '').trim()
  if (!title) return null
  const art = String(song.art || '').trim()
  return {
    artist: String(song.artist || parsed.artist || '').trim(),
    title,
    ...(art.startsWith('https://') || art.startsWith('http://') ? { cover: art } : {}),
    ...(Number(entry.now_playing.duration) > 0 ? { duration: Number(entry.now_playing.duration) } : {}),
  }
}

function parseTitle(value) {
  const text = String(value || '').trim().slice(0, 300)
  if (!text || /^(unknown|offline|n\/a)$/i.test(text)) return null
  const index = text.indexOf(' - ')
  return index > 0 ? { artist: text.slice(0, index), title: text.slice(index + 3) }
    : { artist: '', title: text }
}

function shoutcastStatusUrl(streamUrl) {
  try {
    const stream = new URL(streamUrl)
    if (!['http:', 'https:'].includes(stream.protocol) || stream.username || stream.password) return null
    const sid = stream.searchParams.get('sid')
    // A multi-stream SHOUTcast server needs the right SID. Do not falsely
    // attribute stream 1's song to a different numeric stream.
    const pathSid = /^\/stream\/(\d+)\/?$/.exec(stream.pathname)?.[1]
    const value = sid || pathSid || '1'
    if (!/^[1-9]\d{0,3}$/.test(value)) return null
    const url = new URL('/stats', stream.origin)
    url.searchParams.set('sid', value)
    url.searchParams.set('json', '1')
    return url.href
  } catch { return null }
}

function parseShoutcast(data) {
  if (!data || typeof data !== 'object' || !('songtitle' in data) ||
      (data.streamstatus != null && Number(data.streamstatus) === 0)) return null
  return parseTitle(data.songtitle)
}

function azuraCastStatusUrl(streamUrl) {
  try {
    const stream = new URL(streamUrl)
    if (!['http:', 'https:'].includes(stream.protocol) || stream.username || stream.password) return null
    return new URL('/api/nowplaying', stream.origin).href
  } catch { return null }
}

async function fetchStatus(url, fetchImpl = globalThis.fetch) {
  const safe = await isPublicHttpUrl(url, { resolveDns: fetchImpl === globalThis.fetch })
  if (!safe) return null
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(4500),
    headers: { Accept: 'application/json', 'User-Agent': 'Lokal-Stations/1.0' },
  })
  if (!response.ok || Number(response.headers?.get?.('content-length') || 0) > MAX_BODY) return null
  const body = await response.text()
  if (body.length > MAX_BODY) return null
  try { return JSON.parse(body) } catch { return null }
}

async function cachedFetch(target, work, fetchImpl) {
  const entry = cache.get(target)
  if (fetchImpl === globalThis.fetch && entry && Date.now() < entry.until) return entry.pending
  const pending = withSlot(work).catch(() => null)
  if (fetchImpl === globalThis.fetch) {
    const record = { until: Date.now() + CACHE_FAILURE_MS, pending }
    cache.set(target, record)
    pending.then(data => { record.until = Date.now() + (data ? CACHE_SUCCESS_MS : CACHE_FAILURE_MS) })
    if (cache.size > 200) cache.delete(cache.keys().next().value)
  }
  return pending
}

/**
 * Fetch only small, public metadata endpoints. A station may expose no
 * track data at all; callers must display "Current track unavailable" rather
 * than assign a different stream's song or open an audio connection.
 */
async function visibleStationMetadata(station, { fetchImpl = globalThis.fetch } = {}) {
  if (!station?.id?.startsWith('rb:')) return null
  const provider = broadcasterApiForStation(station)
  let song = null
  if (provider) {
    song = await cachedFetch('broadcaster:' + station.id,
      () => nowPlaying(provider, { fetchImpl, publicOnly: true }), fetchImpl)
  } else {
    const lookups = [
      [statusUrl(station.url), data => parseIcecast(data, station.url)],
      [azuraCastStatusUrl(station.url), data => parseAzuraCast(data, station.url)],
      [shoutcastStatusUrl(station.url), parseShoutcast],
    ]
    for (const [target, parse] of lookups) {
      if (!target) continue
      const data = await cachedFetch(target, () => fetchStatus(target, fetchImpl), fetchImpl)
      song = parse(data)
      if (song?.title) break
    }
  }
  if (!song?.title) return null
  if (song.cover || !song.artist || fetchImpl !== globalThis.fetch) return song
  const cover = await coverFor(song, fetchImpl).catch(() => null)
  return cover ? { ...song, cover } : song
}

module.exports = {
  parseIcecast, parseAzuraCast, parseShoutcast, shoutcastStatusUrl,
  azuraCastStatusUrl, statusUrl, broadcasterApiForStation, visibleStationMetadata,
}
