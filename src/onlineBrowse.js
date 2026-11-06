// Album and artist pages for music that isn't in the library: the songs
// playing from YouTube, SoundCloud or an addon. Their album and artist
// shortcuts open these instead of the library's pages (which have nothing
// for them). The songs come from the catalogue (YouTube Music, Last.fm, then
// a search of the playback sources) and are found in the playback sources
// when they're played or downloaded, like Home's recommendations.

import { api } from './api.js'
import { loadDiscoveryCatalogue } from './discoveryCatalogue.js'
import { isGhostTrack, streamRef } from './onlineTracks.js'
import { playbackSources, recommendationKey, recommendationMatch, timed } from './recommendations.js'

/** "/online/album?artist=...&album=..." */
export function onlineAlbumPath({ artist, album, albumId, provider, sourceAlbumId } = {}) {
  const params = new URLSearchParams({ artist: String(artist || ''), album: String(album || '') })
  if (/^MPRE[\w-]+$/.test(String(albumId || ''))) params.set('albumId', albumId)
  // An addon's album: from that addon ("source"), by its id when known.
  if (/^a-[0-9a-f]{10}$/.test(String(provider || ''))) {
    params.set('source', provider)
    if (sourceAlbumId) params.set('sourceAlbum', String(sourceAlbumId))
  }
  return `/online/album?${params}`
}

/** The album page of a song: its addon's when it plays from one. */
export function trackAlbumPath(track) {
  const ref = streamRef(track)
  const provider = /^a-/.test(ref?.provider || '') ? ref.provider : /^a-/.test(track.provider || '') ? track.provider : null
  const sourceAlbumId = track.source_album_id || track.sourceAlbumId || track.albumId || null
  return onlineAlbumPath({
    // Some add-ons (including Amazon) return the album id before its display
    // name. The album page resolves that id and displays the add-on's title.
    artist: track.album_artist || track.artist, album: track.album || track.album_name || track.albumName || '', albumId: track.albumId,
    provider, sourceAlbumId: provider ? sourceAlbumId : null,
  })
}

// ---------------------------------------------------------------- addons' own album and artist pages

/** Enabled addons offering `resource` ("album" / "artist"), `first` before the others, then in playback order. */
export async function catalogueAddons(resource, client = api, first = null) {
  const providers = await Promise.resolve(client.onlineProviders?.()).catch(() => [])
  const offering = (Array.isArray(providers) ? providers : []).filter(item => item?.addon && item[resource])
  if (!offering.length) return []
  const order = (await playbackSources(client).catch(() => [])).map(source => source.id)
  const rank = id => (id === first ? -1 : order.includes(id) ? order.indexOf(id) : order.length)
  return offering.map(item => item.id).sort((a, b) => rank(a) - rank(b))
}

const plain = value => recommendationKey(value)

/** The addon's own result for `track` (with its album and artist ids), by searching it. */
async function addonResultFor(track, provider, client) {
  const ref = streamRef(track) || (track.provider && track.id ? { provider: track.provider, id: track.id } : null)
  const response = await timed(() => client.onlineSearch(`${track.artist} ${track.title}`, provider), 12000).catch(() => null)
  const results = Array.isArray(response?.results) ? response.results : []
  return (ref?.provider === provider && results.find(result => String(result.id) === String(ref.id))) || recommendationMatch(track, results)
}

/** Songs from an addon album or artist page: played from that addon directly (no search). */
const exactTracks = (tracks, artwork = '') => tracks.map(track => ({ ...track, exact: true, artwork_url: track.thumbnail || artwork || '' }))

/**
 * An album from an addon that has album pages: { tracks, title, artist,
 * artwork, provider, albumId } or null. Its id: given, else from a song of
 * it (`anchor`), else by searching the addon for the artist and album.
 */
export async function loadAddonAlbum({ artist, album, provider, sourceAlbumId, anchor }, client = api) {
  for (const addon of await catalogueAddons('album', client, provider)) {
    let id = addon === provider ? sourceAlbumId : null
    if (!id && anchor?.title) id = (await addonResultFor({ artist, ...anchor }, addon, client))?.albumId
    if (!id) {
      const response = await timed(() => client.onlineSearch(`${artist} ${album}`, addon), 12000).catch(() => null)
      const results = Array.isArray(response?.results) ? response.results : []
      const sameArtist = result => [result.artist, ...(result.artists || [])].some(name => plain(name) === plain(artist))
      id = results.find(result => result.albumId && releaseTitleKey(result.album) === releaseTitleKey(album) && sameArtist(result))?.albumId
    }
    if (!id) continue
    const result = await timed(() => client.addonAlbum(addon, id), 15000).catch(() => null)
    if (!result || result.error || !result.tracks?.length) continue
    return { tracks: exactTracks(result.tracks, result.artwork_url), title: result.title || album, artist: result.artist || artist, artwork: result.artwork_url || '', year: result.year, provider: addon, albumId: result.id }
  }
  return null
}

/**
 * An artist from an addon that has artist pages: { name, image, tracks,
 * albums } or null. Their id tells them from namesakes: the one credited on
 * `anchor` (a song of theirs), else of the artists so named in the addon's
 * search the one sharing the most with `hints` (the library's titles), else
 * the one most of the results credit.
 */
export async function loadAddonArtist(name, { anchor, hints = [] } = {}, client = api) {
  const want = plain(name)
  const hinted = new Set(hints.map(plain).filter(Boolean))
  const fromResult = (result, addon) => ({
    name: result.name || name,
    image: result.image || '',
    tracks: exactTracks(result.tracks),
    albums: (result.albums || []).map(item => ({ ...item, provider: addon, sourceAlbumId: item.albumId, albumId: null })),
  })

  // An artist search result already has an exact ID from its source. Honour
  // it before resolving by name; namesakes on YouTube or other addons must
  // not replace the artist the user explicitly clicked.
  if (anchor?.artistId && String(anchor.provider || '').startsWith('a-')) {
    const direct = await timed(() => client.addonArtist(anchor.provider, anchor.artistId), 15000).catch(() => null)
    if (direct && !direct.error && (direct.tracks?.length || direct.albums?.length)) {
      return fromResult(direct, anchor.provider)
    }
  }

  for (const addon of await catalogueAddons('artist', client, anchor?.provider)) {
    let id = null
    if (anchor?.title) {
      const own = await addonResultFor({ artist: name, ...anchor }, addon, client)
      const at = (own?.artists || []).findIndex(artist => plain(artist) === want)
      id = own?.artistIds?.[at >= 0 ? at : 0] || null
    }
    if (!id) {
      const response = await timed(() => client.onlineSearch(name, addon), 12000).catch(() => null)
      const tally = new Map() // id -> { count, hints }
      for (const result of Array.isArray(response?.results) ? response.results : []) {
        ;(result.artists || []).forEach((artist, index) => {
          const artistId = result.artistIds?.[index]
          if (!artistId || plain(artist) !== want) return
          const entry = tally.get(artistId) || { count: 0, hints: 0 }
          entry.count++
          if (hinted.has(plain(result.title)) || hinted.has(plain(result.album))) entry.hints++
          tally.set(artistId, entry)
        })
      }
      id = [...tally.entries()].sort((a, b) => b[1].hints - a[1].hints || b[1].count - a[1].count)[0]?.[0] || null
    }
    if (!id) continue
    const result = await timed(() => client.addonArtist(addon, id), 15000).catch(() => null)
    if (!result || result.error || (!result.tracks?.length && !result.albums?.length)) continue
    return fromResult(result, addon)
  }
  return null
}

/** A song that isn't a library file: streamed, or a ghost row. */
export const isOnlineTrack = track => !!track && (isGhostTrack(track) || !track.file_path)

/** The library's copies of an album, if it has any songs of it as files. */
export async function libraryAlbum({ artist, album }, client = api) {
  if (!album) return null
  const tracks = await Promise.resolve(client.getAlbumTracks({ title: album, album_artist: artist })).catch(() => [])
  return (Array.isArray(tracks) ? tracks : []).some(track => track?.file_path && !isGhostTrack(track)) ? { title: album, album_artist: artist } : null
}

/** An album's songs, in order: { tracks, error } */
export async function loadOnlineAlbum({ artist, album, albumId, artwork, provider, sourceAlbumId, anchor }, client = api, options = {}) {
  // A player's direct add-on album link can have the exact source ID before
  // the search result has a display name. Resolve that ID first so the page
  // doesn't depend on a title-based catalogue lookup.
  if (provider && sourceAlbumId) {
    const fromAddon = await loadAddonAlbum({ artist, album, provider, sourceAlbumId, anchor }, client).catch(() => null)
    if (fromAddon) return { tracks: fromAddon.tracks, error: '', provider: fromAddon.provider, artwork: fromAddon.artwork, title: fromAddon.title, artist: fromAddon.artist }
  }
  // The catalogues first (Last.fm, YouTube Music); then an addon with album
  // pages (the whole album, in order); then a search of the playback sources.
  let result = await loadDiscoveryCatalogue({ type: 'album', artist, album, albumId }, client, { ...options, searchSources: false })
  if (!result.tracks?.length) {
    const fromAddon = await loadAddonAlbum({ artist, album, provider, sourceAlbumId, anchor }, client).catch(() => null)
    if (fromAddon) return { tracks: fromAddon.tracks, error: '', provider: fromAddon.provider, artwork: fromAddon.artwork, title: fromAddon.title, artist: fromAddon.artist }
    result = await loadDiscoveryCatalogue({ type: 'album', artist, album, albumId }, client, { ...options, skipSources: ['lastfm', 'youtube'] })
  }
  // Songs without their own cover show the album's.
  // The album's artist goes along: a song credited "Estelle, D-Nice & ..." is found as Estelle's.
  const tracks = (result.tracks || []).map(track => ({ ...track, album: track.album || album, album_artist: track.album_artist || artist, artwork_url: track.artwork_url || track.thumbnail || artwork || '' }))
  return { tracks, error: tracks.length ? '' : result.error }
}

/** An artist's popular songs: { tracks, error } */
export async function loadOnlineArtistSongs(artist, client = api, options = {}) {
  const result = await loadDiscoveryCatalogue({ type: 'artist', artist }, client, { searchSources: true, ...options })
  return { tracks: (result.tracks || []).map(track => ({ ...track, artwork_url: track.artwork_url || track.thumbnail || '' })), error: result.error || '' }
}

/**
 * One artist's songs and releases from their YouTube Music channel, so a
 * namesake's music isn't mixed in. `anchor`: a song of theirs (the one
 * playing) to find the channel by; `hints`: the library's titles by them.
 * { name, tracks, albums } or null (no channel found: search by name instead).
 */
export async function loadArtistChannel(artist, { anchor, hints = [] } = {}, client = api, { timeoutMs = 20000 } = {}) {
  const result = await timed(() => client.discoveryCatalogue({ source: 'youtube', type: 'artistPage', artist, anchor, hints: hints.slice(0, 80) }), timeoutMs).catch(() => null)
  if (!result || result.error || (!result.tracks?.length && !result.albums?.length)) return null
  const tracks = result.tracks.map(track => ({ ...track, source: 'youtube', artwork_url: track.artwork_url || track.thumbnail || '' }))
  const albums = [...(result.albums || [])]
  const byTitle = new Map(albums.map(album => [releaseTitleKey(album.title), album]))
  for (const track of tracks) {
    if (!track.album) continue
    const key = releaseTitleKey(track.album)
    const existing = byTitle.get(key)
    const role = mainArtistMetadata(track)
    if (!existing) {
      const album = { title: track.album, artist: result.name || artist, albumId: track.albumId, artwork_url: track.artwork_url, ...role }
      albums.push(album)
      byTitle.set(key, album)
    } else if (mainArtistMetadata(existing).is_main_artist === undefined && role.is_main_artist !== undefined) {
      // The channel catalogue can list the release without its credit role;
      // a matching song may still identify it as a feature release.
      existing.is_main_artist = role.is_main_artist
    }
  }
  return { name: result.name || artist, image: result.image || '', tracks, albums }
}

/**
 * An artist's albums: from YouTube Music or Last.fm, plus the albums of
 * `songs` (so a source that only searches songs still gives some).
 */
export async function loadOnlineArtistAlbums(artist, songs = [], client = api, { timeoutMs = 12000 } = {}) {
  const albums = []
  for (const source of ['youtube', 'lastfm']) {
    const result = await timed(() => client.discoveryCatalogue({ type: 'albums', artist, source }), timeoutMs).catch(() => null)
    if (Array.isArray(result?.albums) && result.albums.length) { albums.push(...result.albums); break }
  }
  for (const song of songs) {
    if (song?.album) albums.push({
      title: song.album,
      artist: song.album_artist || artist,
      artwork_url: song.artwork_url || song.thumbnail || '',
      release_type: song.album_release_type || song.albumReleaseType || song.album_type || song.albumType || song.release_type || song.releaseType,
      track_count: song.album_track_count || song.albumTrackCount || song.album?.track_count || song.album?.trackCount,
      ...mainArtistMetadata(song),
    })
  }
  const seen = new Map()
  for (const album of albums) {
    const key = recommendationKey(album.title)
    if (!key) continue
    const known = seen.get(key)
    if (!known) seen.set(key, { ...album })
    else {
      if (!known.artwork_url && album.artwork_url) known.artwork_url = album.artwork_url
      if (!known.release_type) known.release_type = album.release_type || album.releaseType || album.album_type || album.albumType || album.type
      if (!known.track_count) known.track_count = album.track_count || album.trackCount || album.total_tracks || album.totalTracks
      if (known.is_main_artist == null) {
        const role = mainArtistMetadata(album)
        if (role.is_main_artist !== undefined) known.is_main_artist = role.is_main_artist
      }
    }
  }
  return [...seen.values()]
}

/** A release title to compare by: "I Am (Expanded Edition)" -> "i am". */
export const releaseTitleKey = title => recommendationKey(String(title || '').replace(/\s*[([][^)\]]*[)\]]/g, '')) || recommendationKey(title)

/** Preserve the album-level main/featured-artist role when a release is inferred from a song. */
function mainArtistMetadata(source) {
  const album = source?.album && typeof source.album === 'object' ? source.album : null
  const value = [
    source?.album_is_main_artist, source?.albumIsMainArtist,
    album?.is_main_artist, album?.isMainArtist,
    source?.is_main_artist, source?.isMainArtist,
    source?.main_artist, source?.mainArtist,
  ].find(value => value !== undefined && value !== null)
  return value === undefined ? {} : { is_main_artist: value }
}

/** How many of the library's songs (files) each release has, by releaseTitleKey. */
export function libraryAlbumCounts(libraryTracks = []) {
  const counts = new Map()
  for (const track of libraryTracks || []) {
    if (!track?.album || !track.file_path || isGhostTrack(track)) continue
    const key = releaseTitleKey(track.album)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

/**
 * How much of `release` the library has: { owned, total, full } (total
 * when the source says how many songs it has), or null when none of it.
 */
export function releaseOwnership(release, counts) {
  const owned = counts?.get(releaseTitleKey(release?.title)) || 0
  if (!owned) return null
  const total = Number(release?.track_count) || 0
  return { owned, total, full: !!total && owned >= total }
}

/**
 * The online tracklist with the library's songs in it: each online song the
 * library has is replaced by the library's copy (which plays the file); the
 * rest stay online. Library songs the online list doesn't have (bonus tracks)
 * come last. { tracks, missing, owned }
 */
export function mergeWithLibrary(onlineTracks = [], libraryTracks = []) {
  const local = (libraryTracks || []).filter(track => track?.file_path && !isGhostTrack(track))
  const used = new Set()
  const tracks = (onlineTracks || []).map(track => {
    const free = local.filter(item => !used.has(item))
    const own = recommendationMatch(track, free) || free.find(item => recommendationMatch(item, [track]))
    if (!own) return track
    used.add(own)
    return own
  })
  const extras = local.filter(item => !used.has(item))
  return {
    tracks: [...tracks, ...extras],
    missing: tracks.filter(track => isOnlineTrack(track)),
    owned: used.size + extras.length,
  }
}

// Which albums and artists are shown with their online songs (the "Full album
// online" / "More online" switches), remembered on this computer.
const CONNECTED_KEY = 'lokal-online-connected'
const ONLINE_DEFAULT_KEY = 'lokal-online-pages-default'
const PAGE_MODES_KEY = 'lokal-online-page-mode-overrides'

// This controls the *initial* mode of library album and artist pages. A page
// explicitly switched by the user keeps its own preference.
export function onlineByDefault() {
  try { return localStorage.getItem(ONLINE_DEFAULT_KEY) !== '0' } catch { return true }
}
export function setOnlineByDefault(on) {
  try { localStorage.setItem(ONLINE_DEFAULT_KEY, on ? '1' : '0') } catch {}
}
function connectedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(CONNECTED_KEY) || '[]')) } catch { return new Set() }
}
function pageModes() {
  try {
    const saved = JSON.parse(localStorage.getItem(PAGE_MODES_KEY) || '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch { return {} }
}
export function isConnected(key) {
  if (!key) return false
  const modes = pageModes()
  if (Object.prototype.hasOwnProperty.call(modes, key)) return modes[key] === true
  // Pre-existing positive page choices still work. Previously unopened pages
  // (and pages without an explicit choice) inherit the global default.
  return connectedSet().has(key) || onlineByDefault()
}
export function setConnected(key, on) {
  if (!key) return
  const modes = pageModes()
  // Reinsert the key so the most recently changed pages survive the cap.
  delete modes[key]
  modes[key] = !!on
  try { localStorage.setItem(PAGE_MODES_KEY, JSON.stringify(Object.fromEntries(Object.entries(modes).slice(-500)))) } catch {}
  const set = connectedSet()
  if (on) set.add(key)
  else set.delete(key)
  try { localStorage.setItem(CONNECTED_KEY, JSON.stringify([...set].slice(-500))) } catch {}
}

// ---------------------------------------------------------------- cache

// Online album and artist data, kept once loaded: coming back to a page (or
// opening it again later) shows it at once instead of looking it all up
// again. Refresh buttons load it anew. In memory, and in localStorage for a
// week (the newest 80); failed or empty lookups aren't kept.
const CACHE_KEY = 'lokal-online-cache-v1'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CACHE_MAX = 80
let memory = null

function cacheEntries() {
  if (memory) return memory
  memory = new Map()
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')
    for (const [key, entry] of Array.isArray(saved) ? saved : []) {
      if (entry && Date.now() - entry.at < CACHE_TTL_MS) memory.set(key, entry)
    }
  } catch {}
  while (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value)
  return memory
}

function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify([...cacheEntries()].slice(-CACHE_MAX))) } catch {}
}

const cacheKeyOf = (kind, parts) => `${kind}:${parts.map(part => recommendationKey(part) || String(part || '')).join('|')}`

/** The key an online album is cached under. */
export const albumCacheKey = ({ artist, album, albumId, provider, sourceAlbumId } = {}) => cacheKeyOf('album', [artist, album, albumId, provider, sourceAlbumId])
/** The key an online artist is cached under. */
export const artistCacheKey = (name, anchor = null) => {
  const normalizedName = recommendationKey(name) || String(name || '')
  // Provider artist IDs are opaque identifiers, not names. Preserve their
  // exact spelling and case so distinct IDs cannot share a profile cache entry.
  if (anchor?.artistId != null && anchor?.provider) {
    return JSON.stringify(['artist-source', normalizedName, String(anchor.provider), String(anchor.artistId)])
  }
  return cacheKeyOf('artist', [name])
}

/** What's cached under `key` (and when), or null. */
export function peekOnline(key) {
  const entries = cacheEntries()
  const entry = entries.get(key)
  if (!entry) return null
  if (Date.now() - entry.at >= CACHE_TTL_MS) {
    entries.delete(key)
    return null
  }
  // Touch the entry so eviction remains least-recently-used.
  entries.delete(key)
  entries.set(key, entry)
  return entry
}

/** Keep `value` under `key` (newest last). */
export function keepOnline(key, value) {
  const entries = cacheEntries()
  entries.delete(key)
  entries.set(key, { at: Date.now(), value })
  while (entries.size > CACHE_MAX) entries.delete(entries.keys().next().value)
  saveCache()
}

/**
 * The cached value of `key`, else `load()`'s (kept when `keep(value)` says it
 * found something). `refresh` loads it anew.
 */
export async function cachedOnline(key, load, { refresh = false, keep = () => true } = {}) {
  if (!refresh) {
    const hit = peekOnline(key)
    if (hit) return hit.value
  }
  const value = await load()
  if (value && keep(value)) keepOnline(key, value)
  return value
}

/** An album's songs (loadOnlineAlbum), from the cache when it has them. */
export function loadOnlineAlbumCached(options, client = api, loadOptions = {}, { refresh = false } = {}) {
  return cachedOnline(albumCacheKey(options), () => loadOnlineAlbum(options, client, loadOptions), { refresh, keep: result => result.tracks?.length > 0 })
}
