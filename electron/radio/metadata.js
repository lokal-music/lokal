// Low-cost metadata for visible Radio Browser stations. We never open the
// audio stream to inspect another station's current track.
const { isPublicHttpUrl } = require('../online/publicUrl')

const CACHE_SUCCESS_MS = 60000
const CACHE_FAILURE_MS = 5 * 60000
const MAX_CONCURRENT = 3
const MAX_BODY = 128 * 1024
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

async function visibleStationMetadata(station, { fetchImpl = globalThis.fetch } = {}) {
  if (!station?.id?.startsWith('rb:')) return null
  const target = statusUrl(station.url)
  if (!target) return null
  const entry = cache.get(target)
  if (fetchImpl === globalThis.fetch && entry && Date.now() < entry.until) {
    return parseIcecast(await entry.pending, station.url)
  }
  const pending = withSlot(() => fetchStatus(target, fetchImpl)).catch(() => null)
  if (fetchImpl === globalThis.fetch) {
    const stored = { until: Date.now() + CACHE_FAILURE_MS, pending }
    cache.set(target, stored)
    pending.then(data => { stored.until = Date.now() + (data ? CACHE_SUCCESS_MS : CACHE_FAILURE_MS) })
    if (cache.size > 200) cache.delete(cache.keys().next().value)
  }
  return parseIcecast(await pending, station.url)
}

module.exports = { parseIcecast, statusUrl, visibleStationMetadata }
