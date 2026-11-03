// Shared by artist metadata and music-video discovery. The public key permits
// roughly 30 requests/minute; space all callers through the same queue.
const BASE = 'https://www.theaudiodb.com/api/v1/json/123'
const USER_AGENT = 'Lokal (https://github.com/lokal-music/Desktop)'

function createClient({ fetchImpl = fetch, gapMs = 2100 } = {}) {
  let nextAt = 0
  async function get(endpoint, params = {}) {
    const wait = Math.max(0, nextAt - Date.now())
    nextAt = Date.now() + wait + gapMs
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const url = new URL(`${BASE}/${endpoint}`)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      const res = await fetchImpl(url.href, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
      if (!res.ok) throw new Error(`TheAudioDB answered ${res.status}`)
      return await res.json()
    } finally { clearTimeout(timer) }
  }

  async function searchTracks(artist, title) {
    // The catalogue uses "The Black Eyed Peas", for example, even when local
    // tags omit "The". Only retry the spelling; callers still verify identity.
    const names = [artist, /^the\s/i.test(artist) ? artist.replace(/^the\s+/i, '') : `The ${artist}`]
    for (const name of names) {
      const data = await get('searchtrack.php', { s: name, t: title })
      if (!data || !Object.hasOwn(data, 'track') || (data.track !== null && !Array.isArray(data.track))) throw new Error('Invalid TheAudioDB track response')
      if (data.track?.length) return data.track
    }
    return []
  }
  return { get, searchTracks }
}

module.exports = { ...createClient(), createClient }
