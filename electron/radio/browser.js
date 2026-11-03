// Radio Browser discovery for Lokal Stations. Only directory-reported >=256 kbps
// streams (or lossless codecs) may enter the playback catalogue.
const MIRRORS = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info']
const MIN_BITRATE = 256
const LOSSLESS = new Set(['FLAC', 'ALAC', 'WAV', 'PCM'])
const LOSSY = new Set(['MP3', 'AAC', 'AAC+', 'HE-AAC', 'OPUS', 'OGG', 'VORBIS'])
const CACHE_MS = 90000
const cache = new Map()

function eligibleStation(item) {
  if (!item || item.lastcheckok === 0 || item.lastcheckok === false) return false
  const codec = String(item.codec || '').trim().toUpperCase()
  const bitrate = Number(item.bitrate)
  if (!LOSSLESS.has(codec) && (!LOSSY.has(codec) || !Number.isFinite(bitrate) || bitrate < MIN_BITRATE)) return false
  const url = item.url_resolved || item.url
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return false
  } catch { return false }
  return !!String(item.stationuuid || '').trim() && !!String(item.name || '').trim()
}

function toStation(item) {
  const codec = String(item.codec || '').trim().toUpperCase()
  const isLossless = LOSSLESS.has(codec)
  const bitrate = Number(item.bitrate) || 0
  const tags = String(item.tags || '').split(',').map(s => s.trim()).filter(Boolean)
  return {
    id: 'rb:' + item.stationuuid,
    title: String(item.name).trim(),
    url: item.url_resolved || item.url,
    icon: /^https?:\/\//.test(item.favicon || '') ? item.favicon : null,
    genre: tags[0] || '',
    genres: tags,
    country: item.country || '',
    countrycode: item.countrycode || '',
    language: item.language || '',
    codec, bitrate, lossless: isLossless,
    votes: Number(item.votes) || 0,
    description: [item.country, item.language].filter(Boolean).join(' · '),
    stationuuid: item.stationuuid,
  }
}

function queryParams(params = {}, lossless = false) {
  const result = new URLSearchParams({
    hidebroken: 'true',
    limit: String(Math.max(1, Math.min(80, Number(params.limit) || 60))),
    offset: String(lossless ? 0 : Math.max(0, Math.min(20000, Number(params.offset) || 0))),
    order: 'clickcount',
    reverse: 'true',
    bitrateMin: lossless ? '0' : String(MIN_BITRATE),
  })
  if (lossless) result.set('codec', 'FLAC')
  for (const field of ['name', 'tag', 'countrycode', 'language']) {
    const value = String(params[field] || '').trim().slice(0, 80)
    if (value) result.set(field, value)
  }
  return result
}

async function request(params, lossless, fetchImpl) {
  const qs = queryParams(params, lossless)
  let lastError
  for (const mirror of MIRRORS) {
    try {
      const response = await fetchImpl(mirror + '/json/stations/search?' + qs.toString(), {
        signal: AbortSignal.timeout(9000),
        headers: { Accept: 'application/json', 'User-Agent': 'Lokal-Stations/1.0' },
      })
      if (!response.ok) throw new Error('Radio Browser HTTP ' + response.status)
      const rows = await response.json()
      if (!Array.isArray(rows)) throw new Error('Unexpected Radio Browser response')
      return rows
    } catch (error) { lastError = error }
  }
  throw lastError || new Error('Radio Browser is unreachable')
}

async function browseStations(params = {}, { fetchImpl = globalThis.fetch } = {}) {
  const safe = queryParams(params).toString()
  const key = safe
  const cached = cache.get(key)
  if (fetchImpl === globalThis.fetch && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const pending = (async () => {
    const [lossy, lossless] = await Promise.all([
      request(params, false, fetchImpl),
      Number(params.offset || 0) === 0 ? request({ ...params, limit: 30 }, true, fetchImpl).catch(() => []) : Promise.resolve([]),
    ])
    const seen = new Set()
    const stations = [...lossless, ...lossy].filter(eligibleStation).map(toStation)
      .sort((a, b) => Number(b.lossless) - Number(a.lossless) || b.bitrate - a.bitrate || b.votes - a.votes)
      .filter(station => {
        // Collapse alternate directory entries for the same broadcaster, taking
        // the highest-quality compatible stream first.
        const urlKey = 'url:' + station.url.replace(/\/$/, '').toLowerCase()
        const nameKey = 'name:' + station.countrycode.toUpperCase() + ':' +
          station.title.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
        if (seen.has(station.id) || seen.has(urlKey) || seen.has(nameKey)) return false
        seen.add(station.id)
        seen.add(urlKey)
        seen.add(nameKey)
        return true
      })
    return { stations, hasMore: lossy.length === Math.max(1, Math.min(80, Number(params.limit) || 60)), nextOffset: Math.max(0, Number(params.offset) || 0) + lossy.length, source: 'Radio Browser', minBitrate: MIN_BITRATE }
  })()
  if (fetchImpl === globalThis.fetch) {
    cache.set(key, { at: Date.now(), value: pending })
    if (cache.size > 40) cache.delete(cache.keys().next().value)
    pending.catch(() => { if (cache.get(key)?.value === pending) cache.delete(key) })
  }
  return pending
}

module.exports = { MIN_BITRATE, eligibleStation, toStation, browseStations, queryParams }
