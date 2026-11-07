import { artworkCandidates } from './artworkQuality.mjs'

// Match mobile's full-player artwork selection: compare decoded pixel sizes,
// not the dimensions requested in a CDN URL. A 200 response may contain a
// tiny placeholder instead of the advertised 1200px image.
export const PLAYER_ARTWORK_TARGET = 1000
const MAX_LOOKUP_MS = 24000
const PROBE_TIMEOUT_MS = 6000
const cache = new Map()
const independentAmazonArt = new Map()

export function isAmazonMusicAddonLabel(label) {
  return /^amazon(?:\b|[-_])/i.test(String(label || '').trim())
}
const playableImage = url => typeof url === 'string' && /^(?:https:\/\/|file:\/\/)/i.test(url)

export function probeArtworkPixels(url, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!playableImage(url) || typeof Image === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    const image = new Image()
    let finished = false
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      image.onload = null
      image.onerror = null
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    image.referrerPolicy = 'no-referrer'
    image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => finish(null)
    image.src = url
  })
}

/** First try each provider rendition, then an independent metadata match.
 * Return the largest *decoded* image. Smaller fallbacks remain available while
 * full-resolution artwork is being fetched, and the audio never waits for it.
 */
export async function choosePlayerArtwork(src, { title, artist, resolveRemote, inspect = probeArtworkPixels, now = Date.now, preferIndependent = false, onIndependentResolved } = {}) {
  const deadline = now() + MAX_LOOKUP_MS
  let best = null
  const tried = new Set()
  async function inspectCandidates(url) {
    for (const candidate of artworkCandidates(url)) {
      if (tried.has(candidate) || !playableImage(candidate)) continue
      tried.add(candidate)
      const remaining = deadline - now()
      if (remaining <= 0) break
      let dimensions
      try { dimensions = await inspect(candidate, Math.min(PROBE_TIMEOUT_MS, remaining)) } catch { continue }
      const width = Number(dimensions?.width) || 0
      const height = Number(dimensions?.height) || 0
      if (width <= 0 || height <= 0) continue
      const side = Math.min(width, height), area = width * height
      if (!best || side > best.side || (side === best.side && area > best.area)) {
        best = { url: candidate, side, area }
      }
      // Once the image is large enough, do not generate unnecessary traffic.
      if (side >= PLAYER_ARTWORK_TARGET) break
    }
  }
  const lookupIndependent = async () => {
    if (!title || !artist || !resolveRemote || now() >= deadline) return false
    // One catalogue URL returning a 404 or a tiny placeholder must not
    // exhaust artwork recovery. Ask the same resolver for its next matching
    // provider result, excluding every unsuccessful URL (Mobile parity).
    const rejected = new Set(src ? [src] : [])
    for (let attempt = 0; attempt < 3 && now() < deadline; attempt++) {
      try {
        const remote = await resolveRemote({
          type: 'track', title, artist, exclude: src || '',
          excludes: [...rejected], remoteOnly: true,
        })
        if (!remote || rejected.has(remote) || now() >= deadline) break
        rejected.add(remote)
        const previous = best
        best = null
        await inspectCandidates(remote)
        const independent = best
        // A failed candidate does not erase already decoded source artwork.
        if (!independent || (preferIndependent && independent.side < 300)) {
          best = previous
          continue
        }
        if (!preferIndependent && previous &&
          (previous.side > independent.side ||
            (previous.side === independent.side && previous.area >= independent.area))) {
          best = previous
          continue
        }
        if (preferIndependent) onIndependentResolved?.(independent.url)
        return true
      } catch { /* Try the next independent source or keep existing art. */ }
    }
    return false
  }

  if (preferIndependent && await lookupIndependent()) return best?.url || null
  await inspectCandidates(src)
  if (!preferIndependent && (!best || best.side < PLAYER_ARTWORK_TARGET)) await lookupIndependent()
  return best?.url || null
}

export function resolvePlayerArtwork(track, src, resolveRemote, { preferIndependent = false } = {}) {
  if (!track?.id || !track?.title || !track?.artist) return Promise.resolve(null)
  const identity = JSON.stringify([track.id, track.file_path])
  // Once an independent cover is applied to the Now Playing record, do not
  // exclude it and initiate a second lookup against another catalogue.
  if (preferIndependent && independentAmazonArt.get(identity) === src) return Promise.resolve(src)
  const key = JSON.stringify([track.id, track.file_path, track.title, track.artist, src, preferIndependent])
  const existing = cache.get(key)
  if (existing && Date.now() - existing.at < (existing.hit ? 3600000 : 120000)) return existing.promise
  const entry = {
    at: Date.now(), hit: false,
    promise: choosePlayerArtwork(src, {
      title: track.title, artist: track.artist, resolveRemote, preferIndependent,
      onIndependentResolved: url => {
        independentAmazonArt.set(identity, url)
        if (independentAmazonArt.size > 200) independentAmazonArt.delete(independentAmazonArt.keys().next().value)
      },
    })
      .then(url => { entry.hit = !!url; return url })
      .catch(() => null),
  }
  cache.set(key, entry)
  if (cache.size > 180) cache.delete(cache.keys().next().value)
  return entry.promise
}
