// Where to buy a song in lossless, for "Get it in lossless" on a track.
//
//  - Store searches, always: Qobuz, Bandcamp and 7digital, searched for
//    "artist title" (plain links the user opens in their browser).
//  - Exact links, when MusicBrainz knows them: the recording is found by its
//    ISRC (the file's own, else the one Deezer's public API gives for the
//    same title, artist and length), and its releases' "purchase for
//    download" / "download for free" links are listed (Bandcamp, Qobuz,
//    7digital, Beatport...).
//
// Nothing here downloads audio: these are links to stores.

const TIMEOUT_MS = 8000
const CACHE_TTL_MS = 60 * 60 * 1000
const MB = 'https://musicbrainz.org/ws/2'
const MB_GAP_MS = 1100 // MusicBrainz asks for at most one request a second
const MAX_RELEASES = 3
const cache = new Map() // key -> { at, value }

let USER_AGENT = 'Lokal ( https://github.com/lokal-music/Desktop )'
try { USER_AGENT = `Lokal/${require('../../package.json').version} ( https://github.com/lokal-music/Desktop )` } catch {}

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

/** Plain store searches for artist + title. */
function searchLinks({ artist, title }) {
  const q = [String(artist || '').split(/\s*,\s*/)[0], title].filter(Boolean).join(' ').replace(/\s*\((?:feat|ft)\.?[^)]*\)/ig, '').trim()
  const e = encodeURIComponent(q)
  return [
    // Qobuz only answers searches under a locale, as a path (/search?q= doesn't
    // work). The app shows these with the Qobuz store of the user's region
    // (src/quality.js); this US one is for other callers.
    { store: 'Qobuz', kind: 'search', format: 'FLAC, up to 24-bit', url: `https://www.qobuz.com/us-en/search/albums/${e}` },
    { store: 'Bandcamp', kind: 'search', format: 'FLAC, when the artist sells there', url: `https://bandcamp.com/search?q=${e}&item_type=t` },
    { store: '7digital', kind: 'search', format: 'FLAC for many releases', url: `https://us.7digital.com/search?q=${e}` },
    { store: 'Discogs', kind: 'info', format: 'Releases, pressings, credits · CDs and vinyl for sale', url: `https://www.discogs.com/search/?q=${e}&type=all` },
    { store: 'AllMusic', kind: 'info', format: 'Reviews, credits, discography', url: `https://www.allmusic.com/search/all/${e}` },
  ]
}

async function getJson(url, fetchImpl, headers = {}, signal = null) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  // The caller giving up (e.g. a download's MusicBrainz deadline) ends it too.
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch { return null } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort) }
}

// MusicBrainz, one request a second across the whole app.
let mbQueue = Promise.resolve()
function mbGet(pathAndQuery, fetchImpl, { gapMs = MB_GAP_MS, signal } = {}) {
  const run = mbQueue.then(async () => {
    // Its caller gave up while it waited in line: skip it, don't hold the queue.
    if (signal?.aborted) return null
    const result = await getJson(`${MB}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}fmt=json`, fetchImpl, { 'User-Agent': USER_AGENT }, signal)
    await new Promise(resolve => setTimeout(resolve, gapMs))
    return result
  })
  mbQueue = run.catch(() => {})
  return run
}

/** An ISRC for a song without one, from Deezer's search (same title, artist and length). */
async function isrcFromDeezer({ artist, title, duration }, fetchImpl) {
  if (!artist || !title) return null
  const q = `artist:"${String(artist).split(/\s*,\s*/)[0].replace(/"/g, '')}" track:"${String(title).replace(/"/g, '')}"`
  let found = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`, fetchImpl)
  // The field search is strict about spelling: a plain search catches the rest.
  if (!found?.data?.length) found = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(`${String(artist).split(/\s*,\s*/)[0]} ${title}`)}&limit=10`, fetchImpl)
  const d = Number(duration) || 0
  const match = (found?.data || []).find(item =>
    (norm(item.title) === norm(title) || norm(item.title_short) === norm(title)) &&
    (!d || !item.duration || Math.abs(Number(item.duration) - d) <= 3))
  if (!match?.id) return null
  const full = await getJson(`https://api.deezer.com/track/${encodeURIComponent(match.id)}`, fetchImpl)
  const isrc = String(full?.isrc || '').toUpperCase()
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null
}

const BUY_TYPES = new Set(['purchase for download', 'download for free'])

// Stores that sell lossless downloads (FLAC/WAV/ALAC). Others (iTunes,
// Amazon MP3...) are left out: this is about getting it in lossless.
const LOSSLESS_STORES = [
  ['bandcamp.com', 'Bandcamp', 'FLAC'],
  ['qobuz.com', 'Qobuz', 'FLAC, up to 24-bit'],
  ['7digital.com', '7digital', 'FLAC for many releases'],
  ['hdtracks.com', 'HDtracks', 'FLAC, hi-res'],
  ['beatport.com', 'Beatport', 'WAV / AIFF / FLAC'],
  ['junodownload.com', 'Juno Download', 'WAV / FLAC'],
  ['prestomusic.com', 'Presto Music', 'FLAC, often hi-res'],
  ['bleep.com', 'Bleep', 'FLAC / WAV'],
  ['boomkat.com', 'Boomkat', 'FLAC / WAV'],
]

/** The lossless store behind a URL: { store, format }, or null. */
function losslessStore(url) {
  let host = ''
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return null }
  const hit = LOSSLESS_STORES.find(([domain]) => host === domain || host.endsWith(`.${domain}`))
  return hit ? { store: hit[1], format: hit[2] } : null
}

/** A readable name for a free download's host. */
function hostName(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'Download' }
}

/** Exact purchase / free download links for an ISRC, from MusicBrainz. */
async function musicBrainzLinks(isrc, fetchImpl, opts) {
  const found = await mbGet(`/recording?query=${encodeURIComponent(`isrc:${isrc}`)}&limit=3`, fetchImpl, opts)
  const releases = []
  for (const recording of found?.recordings || []) {
    for (const release of recording.releases || []) {
      if (!releases.includes(release.id) && release.status !== 'Bootleg') releases.push(release.id)
    }
  }
  const links = []
  const seen = new Set()
  for (const id of releases.slice(0, MAX_RELEASES)) {
    const release = await mbGet(`/release/${encodeURIComponent(id)}?inc=url-rels`, fetchImpl, opts)
    for (const rel of release?.relations || []) {
      const url = rel?.url?.resource
      if (!BUY_TYPES.has(rel.type) || !/^https?:\/\//.test(String(url || '')) || seen.has(url)) continue
      seen.add(url)
      const free = rel.type === 'download for free'
      const store = losslessStore(url)
      if (!free && !store) continue // sold, but not in lossless
      links.push({
        store: store?.store || hostName(url),
        kind: free ? 'free' : 'exact',
        format: free ? `Free download${store ? ` · ${store.format}` : ''}` : store.format,
        release: release.title || null,
        url: url.replace(/^http:\/\//, 'https://'),
      })
    }
  }
  return { links, recordingFound: !!found?.recordings?.length }
}

/**
 * Lossless purchase options for a track row:
 * { exact: [...], searches: [...], isrc, isrcSource: 'file' | 'deezer' | null, identified }
 */
async function buyLinks(track, { fetchImpl = fetch, mbGapMs } = {}) {
  const key = track?.isrc || `${norm(track?.artist)}|${norm(track?.title)}|${Math.round(Number(track?.duration) || 0)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  let isrc = track?.isrc || null
  let isrcSource = isrc ? 'file' : null
  if (!isrc) {
    isrc = await isrcFromDeezer(track || {}, fetchImpl).catch(() => null)
    if (isrc) isrcSource = 'deezer'
  }
  let exact = { links: [], recordingFound: false }
  if (isrc) exact = await musicBrainzLinks(isrc, fetchImpl, { gapMs: mbGapMs }).catch(() => exact)
  const value = {
    exact: exact.links,
    searches: searchLinks(track || {}),
    isrc,
    isrcSource,
    identified: exact.recordingFound,
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

module.exports = { buyLinks, searchLinks, losslessStore, isrcFromDeezer, mbGet }
