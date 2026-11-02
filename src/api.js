import { loadBrowserPerformanceSettings, saveBrowserPerformanceSettings, onBrowserPerformanceSettings } from './browserPerformanceSettings.mjs'
import { updateYoutubeAccountStatus, clearYoutubeAccountStatus, youtubeAccountStatusRevision } from './youtubeAccountStatus.js'
import { cancelDownloadBatches } from './downloadCancellation.js'

const isE = () => {
  try {
    if (typeof window !== 'undefined' && window.electron?.isElectron === true) return true
    if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')) return true
  } catch {}
  return false
}
const el = () => window.electron
const BASE = '/api'
const YOUTUBE_LOCAL_UNLIKES_KEY = 'lokal-youtube-local-unlikes'

function youtubeLocalUnlikes(userId = 'guest') {
  try {
    const value = JSON.parse(localStorage.getItem(YOUTUBE_LOCAL_UNLIKES_KEY) || '{}')
    if (Array.isArray(value)) return userId === 'guest' ? new Set(value.map(String)) : new Set()
    return new Set(Array.isArray(value?.[userId || 'guest']) ? value[userId || 'guest'].map(String) : [])
  } catch { return new Set() }
}

function rememberYoutubeUnlike(videoId, unlike, userId = 'guest') {
  if (!videoId) return
  const key = userId || 'guest'
  let stored = {}
  try {
    const value = JSON.parse(localStorage.getItem(YOUTUBE_LOCAL_UNLIKES_KEY) || '{}')
    stored = Array.isArray(value) ? { guest: value } : (value && typeof value === 'object' ? value : {})
  } catch {}
  const ids = new Set(Array.isArray(stored[key]) ? stored[key].map(String) : [])
  if (unlike) ids.add(String(videoId))
  else ids.delete(String(videoId))
  stored[key] = [...ids].slice(-500)
  try { localStorage.setItem(YOUTUBE_LOCAL_UNLIKES_KEY, JSON.stringify(stored)) } catch {}
}

// Where a video that isn't downloaded streams from: Lokal's own local
// address for it (plain HTTP, which the video player handles best), kept
// once known; lokal-stream:// while there's none, asked again next time
// (the server may start later).
let videoStreamBase = null
const streamBase = async () => {
  if (videoStreamBase) return videoStreamBase
  const base = await Promise.resolve(el()?.musicVideoStreamBase?.()).catch(() => null)
  if (base) videoStreamBase = base
  return base || null
}

async function musicVideoResult(r) {
  if (r?.error) return r
  if (!r?.videoId) return null
  // Not downloaded: streamed from YouTube (the picture only; the song plays
  // its own audio). Downloading it stays an option.
  const streamed = !r.file && !!r.needsDownload && /^[\w-]{11}$/.test(r.videoId)
  const base = streamed ? await streamBase() : null
  const src = r.file ? electronFileURL(r.file)
    : streamed ? (base ? `${base}/ytv/${encodeURIComponent(r.videoId)}` : `lokal-stream://ytv/${encodeURIComponent(r.videoId)}`)
      : null
  return { ...r, src, streamed }
}

function buildLastfmAuthUrl(apiKey) {
  const callback = isE()
    ? 'lokal://lastfm-auth'
    : `${window.location.origin}${BASE}/lastfm/callback`
  return `https://www.last.fm/api/auth/?${new URLSearchParams({ api_key: apiKey || '', cb: callback })}`
}

function electronFileURL(filePath = '') {
  if (!filePath) return ''
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
    .replace(/%3A/g, ':')

  if (encoded.startsWith('//')) return `file:${encoded}`
  if (/^[A-Za-z]:/.test(encoded)) return `file:///${encoded}`
  return `file://${encoded}`
}

function normalizeProfilePayload(data = {}) {
  return {
    userId: data.userId,
    displayName: data.displayName ?? data.display_name,
    bio: data.bio ?? '',
    avatarData: data.avatarData ?? data.avatar ?? null,
  }
}

function albumTrackParams(album) {
  const data = album && typeof album === 'object'
    ? { album: album.title || album.album || '', albumArtist: album.album_artist || album.albumArtist || '' }
    : { album: album || '' }
  return new URLSearchParams(Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== '')))
}

// Web mode with API_KEY set on the server: ask for the key once, let the
// server store it as a cookie (which also covers artwork and audio), then
// reload so everything that failed without it loads.
let apiKeyPrompt = null
/** Ask once for the server's API key, store it as a cookie via /api/auth, then reload. */
function askForApiKey() {
  if (!apiKeyPrompt) {
    apiKeyPrompt = (async () => {
      let message = 'This Lokal server is protected. Enter its API key:'
      for (;;) {
        const key = window.prompt(message)
        if (!key) return false
        const res = await fetch(BASE + '/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        }).catch(() => null)
        if (res?.ok) { window.location.reload(); return true }
        if (res?.status === 403) {
          // Plain HTTP from outside the local network: retrying won't help.
          window.alert((await res.json().catch(() => ({}))).error || 'This server refused the key.')
          return false
        }
        message = 'That key was not accepted. Enter the API key:'
      }
    })()
    // Once it's settled (cancelled, refused or accepted), a later 401 can ask again.
    apiKeyPrompt.finally(() => { apiKeyPrompt = null })
  }
  return apiKeyPrompt
}

async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}))
      if (body.needsApiKey) askForApiKey()
      return { error: body.error || 'Not authorized' }
    }
    if (!res.ok) return { error: (await res.json().catch(() => ({}))).error || 'Request failed' }
    return res.json()
  } catch (e) { return { error: e.message } }
}

// The settings as last read (plus changes saved since), or null before the
// first read. Synchronous, for a page's first render.
let settingsSnapshot = null
// Bumped by every successful save: a read that started before one is older
// than the snapshot and mustn't replace it.
let settingsRevision = 0
export const peekSettings = () => settingsSnapshot

/**
 * Word-by-word lyrics (Settings > Playback > Lyrics): the saved setting, so it
 * follows a backup or another device; this computer's copy only until the
 * settings are read.
 */
export function wordSyncEnabled() {
  const saved = settingsSnapshot?.word_sync
  if (saved === '0' || saved === '1') return saved === '1'
  try { return localStorage.getItem('word-sync') !== '0' } catch { return true }
}

export const api = {
  get isElectron() { return isE() },
  fileURL: (path) => electronFileURL(path),
  artworkURL: (id, full = false) => BASE + '/artwork/' + encodeURIComponent(id) + (full ? '?full=1' : ''),
  // Full art is loaded only for large surfaces; Electron uses the local cover protocol.
  fullArtworkURL: (id) => isE() ? 'lokal-stream://cover/' + encodeURIComponent(id) : BASE + '/artwork/' + encodeURIComponent(id) + '?full=1',
  folderArtworkURL: (filePath) => `${BASE}/tracks/folder-artwork?path=${encodeURIComponent(filePath || '')}`,
  // An album's cover (from getAllAlbums: the path, and the track it's from).
  // Artwork is served by track id, not by path (or album title).
  albumArtURL: (album) => {
    if (!album?.artwork_path) return null
    if (isE()) return `file://${album.artwork_path}`
    return album.artwork_track_id ? `${BASE}/artwork/${encodeURIComponent(album.artwork_track_id)}` : null
  },
  playlistCoverURL: (id) => `${BASE}/playlists/${encodeURIComponent(id)}/cover`,
  streamURL: (t) => `${BASE}/stream/${encodeURIComponent(t.id)}`,
  avatarURL: (id) => `${BASE}/avatar/${id}`,
  getTracks: (o = {}) => isE() ? el().getTracks(o) : apiFetch(`/tracks?${new URLSearchParams(o)}`),
  getTrackFileSize: (id) => isE() ? el().getTrackFileSize(id) : apiFetch(`/tracks/${encodeURIComponent(id)}/file-size`),
  repairLowQualityArtwork: () => isE() ? el().repairLowQualityArtwork() : Promise.resolve({ error: 'Artwork repair requires the desktop app' }),
  artworkRepairStatus: () => isE() ? el().artworkRepairStatus() : Promise.resolve({ running: false }),
  cancelArtworkRepair: () => isE() ? el().cancelArtworkRepair() : Promise.resolve({ running: false }),
  onArtworkRepairProgress: (fn) => isE() ? el().onArtworkRepairProgress(fn) : () => {},
  getLibraryFolders: (relativePath = '', search = '', root = '') => isE()
    ? el().getLibraryFolders(relativePath, search, root)
    : apiFetch('/tracks/library-folders?path=' + encodeURIComponent(relativePath) + (search ? '&search=' + encodeURIComponent(search) : '') + (root ? '&root=' + encodeURIComponent(root) : '')),
  renameLibraryFolders: (changes, root = '') => isE()
    ? el().renameLibraryFolders(changes, root)
    : Promise.resolve({ error: 'Folder management is only available in the desktop app' }),
  deleteLibraryFolders: (paths, root = '') => isE()
    ? el().deleteLibraryFolders(paths, root)
    : Promise.resolve({ error: 'Folder management is only available in the desktop app' }),
  onLibraryChanged: (fn) => isE() && el().onLibraryChanged ? el().onLibraryChanged(fn) : () => {},
  // A song that couldn't be played (Library → Songs with errors), or played again fine.
  reportTrackError: (id, message) => isE() ? el().reportTrackError(id, message) : apiFetch(`/tracks/${encodeURIComponent(id)}/error`, { method: 'POST', body: { message } }),
  clearTrackError: (id) => isE() ? el().clearTrackError(id) : apiFetch(`/tracks/${encodeURIComponent(id)}/error`, { method: 'DELETE' }),
  getMissingTracks: () => isE() ? el().getMissingTracks() : apiFetch('/tracks/missing'),
  searchTracks: (q) => isE() ? el().searchTracks(q) : apiFetch(`/tracks/search?q=${encodeURIComponent(q)}`),
  // The library's files in short: [[artist, title, source_ref], ...] (see libraryIndex.js).
  libraryKeys: () => isE() ? el().libraryKeys() : apiFetch('/tracks/library-keys'),
  searchLyrics: (q) => isE() ? el().searchLyrics(q) : apiFetch(`/tracks/search-lyrics?q=${encodeURIComponent(q)}`),
  toggleLike: async (tid, uid, track = null) => {
    const r = await (isE() ? el().toggleLike(tid, uid) : apiFetch(`/tracks/${tid}/like`, { method:'POST', body:{userId:uid} }))
    // The like went to the song, whichever copy was clicked: every id it goes
    // by (library copy, streamed copies) follows, so all its hearts agree.
    // Tagged with the user it was for: a late answer after switching user
    // mustn't touch the new user's hearts.
    if (r && typeof r === 'object' && Array.isArray(r.ids)) window.dispatchEvent(new CustomEvent('lokal:liked', { detail: { ids: r.ids, liked: !!r.liked, userId: uid ?? null } }))
    if (r && typeof r === 'object' && typeof r.liked === 'boolean' && track) {
      // Account-backed likes are best-effort mirrors. A local like remains
      // successful when a provider is offline or signed out.
      const youtubeId = String(track.file_path || '').match(/^ghost:\/\/youtube\/online\/([\w-]+)$/)?.[1]
      if (youtubeId) {
        rememberYoutubeUnlike(youtubeId, !r.liked, uid)
        Promise.resolve(api.youtubeSetLiked(youtubeId, r.liked)).catch(() => {})
      }
      if (track.artist && track.title) Promise.resolve(api.lastfmSetLoved(track.artist, track.title, r.liked)).catch(() => {})
      // New likes go to Spotify's Liked Songs too, when sync is on (it checks).
      if (r.liked && track.artist && track.title) Promise.resolve(api.spotifyLikesPush({ title: track.title, artist: track.artist, album: track.album, userId: uid ?? 'guest' })).catch(() => {})
    }
    return r
  },
  setLike: async (tid, uid, liked) => {
    const r = await (isE() ? el().setLike(tid, uid, liked) : apiFetch(`/tracks/${tid}/like-state`, { method:'POST', body:{userId:uid, liked:!!liked} }))
    if (r && typeof r === 'object' && Array.isArray(r.ids)) window.dispatchEvent(new CustomEvent('lokal:liked', { detail: { ids: r.ids, liked: !!r.liked, userId: uid ?? null } }))
    return r
  },
  isYoutubeLocallyUnliked: (videoId, uid) => youtubeLocalUnlikes(uid || 'guest').has(String(videoId || '')),
  // Likes kept in step with Spotify (desktop; electron/ipc/spotifyLikes.js).
  spotifyLikesStatus: () => isE() && el()?.spotifyLikesStatus ? el().spotifyLikesStatus() : Promise.resolve({ enabled: false }),
  spotifyLikesEnable: (userId) => isE() && el()?.spotifyLikesEnable ? el().spotifyLikesEnable(userId) : Promise.resolve({ enabled: false, error: 'Only in the desktop app' }),
  spotifyLikesDisable: () => isE() && el()?.spotifyLikesDisable ? el().spotifyLikesDisable() : Promise.resolve({ enabled: false }),
  spotifyLikesPoll: () => isE() && el()?.spotifyLikesPoll ? el().spotifyLikesPoll() : Promise.resolve({ items: [] }),
  spotifyLikesAck: (progress) => isE() && el()?.spotifyLikesAck ? el().spotifyLikesAck(progress) : Promise.resolve(null),
  // Discovery's Spotify source: Made For You mixes and their songs (desktop).
  spotifyMadeForYou: (force = false) => isE() && el()?.spotifyMadeForYou ? el().spotifyMadeForYou(force) : Promise.resolve({ mixes: [], error: 'Spotify discovery works in the desktop app.' }),
  spotifyLibraryPlaylists: (force = false) => isE() && el()?.spotifyLibraryPlaylists ? el().spotifyLibraryPlaylists(force) : Promise.resolve({ playlists: [], error: 'Spotify playlists are available in the desktop app.' }),
  spotifyLibraryPlaylistTracks: (uri, force = false) => isE() && el()?.spotifyLibraryPlaylistTracks ? el().spotifyLibraryPlaylistTracks(uri, force) : Promise.resolve({ tracks: [], error: 'Spotify playlists are available in the desktop app.' }),
  spotifyPlaylist: (uri, force = false) => isE() && el()?.spotifyPlaylist ? el().spotifyPlaylist(uri, force) : Promise.resolve({ tracks: [], error: 'Spotify discovery works in the desktop app.' }),
  spotifyRecentlyPlayed: (force = false) => isE() && el()?.spotifyRecentlyPlayed ? el().spotifyRecentlyPlayed(force) : Promise.resolve({ tracks: [] }),
  // AutoMix: a song's analysis (desktop; electron/automix), null when it can't be.
  automixAnalyze: (track) => isE() && el()?.automixAnalyze ? el().automixAnalyze(track) : Promise.resolve(null),
  automixStemClip: (outgoing, incoming) => isE() && el()?.automixStemClip ? el().automixStemClip(outgoing, incoming) : Promise.resolve(null),
  automixPreparePair: (outgoing, incoming, engineDir) => isE() && el()?.automixPreparePair ? el().automixPreparePair(outgoing, incoming, engineDir) : Promise.resolve(null),
  // Flow's songs: the library with this user's likes and plays (electron/ipc/flow.js; the server's /tracks/flow-pool on the web).
  flowPool: (uid) => isE() && el()?.flowPool ? el().flowPool(uid || 'guest') : apiFetch(`/tracks/flow-pool?userId=${encodeURIComponent(uid || 'guest')}`),
  spotifyLikesPush: (track) => isE() && el()?.spotifyLikesPush ? el().spotifyLikesPush(track) : Promise.resolve({ ok: false }),
  getLikedTracks: (uid) => isE() ? el().getLikedTracks(uid) : apiFetch(`/tracks/liked?userId=${uid||'guest'}`),
  incrementPlayTime: (tid, uid, s) => isE() ? el().incrementPlayTime(tid, uid, s) : Promise.resolve(),
  getHistory: (uid, l) => isE() ? el().getHistory(uid, l) : apiFetch(`/tracks/history?userId=${uid||'guest'}&limit=${l||30}`),
  getSuggestions: (uid) => isE() ? el().getSuggestions(uid) : apiFetch(`/tracks/suggestions?userId=${uid||'guest'}`),
  getRelated: (tid, uid) => isE() ? el().getRelated(tid, uid) : apiFetch(`/tracks/${tid}/related?userId=${uid||'guest'}`),
  checkDuplicates: () => isE() ? el().checkDuplicates() : apiFetch('/tracks/duplicates'),
  checkPossibleDuplicates: () => isE() ? el().checkPossibleDuplicates() : apiFetch('/tracks/possible-duplicates'),
  mergeDuplicates: (keepId, removeIds) => isE() ? el().mergeDuplicates(keepId, removeIds) : apiFetch('/tracks/merge', { method:'POST', body:{keepId, removeIds} }),
  mergeAllDuplicates: () => isE() ? el().mergeAllDuplicates() : apiFetch('/tracks/merge-all', { method:'POST' }),
  deleteTracks: (ids) => isE() ? el().deleteTracks(ids) : apiFetch('/tracks/batch-delete', { method:'POST', body:{ids} }),
  deleteTrackByPath: (filePath) => isE() ? el().deleteTrackByPath(filePath) : apiFetch('/tracks/delete-by-path', { method:'POST', body:{filePath} }),
  getArtists: () => isE() ? el().getArtists() : apiFetch('/artists'),
  getArtistsPage: (opts = {}) => isE()
    ? el().getArtistsPage(opts)
    : apiFetch(`/artists?${new URLSearchParams({
        search: opts.search || '',
        limit: String(opts.limit || 60),
        offset: String(opts.offset || 0),
        sort: opts.sort || 'name',
        ...(opts.followed ? { followed: '1' } : {}),
        ...(opts.mainOnly ? { mainOnly: '1' } : {}),
      })}`),
  getArtist: (id) => isE() ? el().getArtist(id) : apiFetch(`/artists/${id}`),
  getAlbumTracks: (a) => isE() ? el().getAlbumTracks(a) : apiFetch(`/tracks?${albumTrackParams(a)}`),
  getAllAlbums: () => isE() ? el().getAllAlbums() : apiFetch('/albums'),
  searchAlbums: (q) => isE() ? el().searchAlbums(q) : apiFetch(`/albums/search?q=${encodeURIComponent(q)}`),
  artistUpdateBio: (id, b) => isE() ? el().artistUpdateBio(id, b) : apiFetch(`/artists/${id}/bio`, { method:'PUT', body:{bio:b} }),
  artistSetImage: (id, d) => isE() ? el().artistSetImage(id, d) : apiFetch(`/artists/${id}/image`, { method:'PUT', body:{imageData:d} }),
  artistSetImageUrl: (id, url) => isE() ? el().artistSetImageUrl(id, url) : apiFetch(`/artists/${id}/image-url`, { method:'PUT', body:{url} }),
  artistRefreshMetadata: (id, opts = {}) => isE() ? el().artistRefreshMetadata(id, opts) : apiFetch(`/artists/${id}/refresh-metadata`, { method:'POST', body: opts }),
  artistVisuals: (id, name, titles, force = false) => isE() && el()?.artistVisuals
    ? el().artistVisuals(id, name, titles, force).then(v => v?.logoFile
      ? { ...v, logoSrc: 'file://' + v.logoFile.replace(/\\\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/%3A/g, ':') }
      : v)
    : Promise.resolve(null),
  artistMotion: (id, name, titles) => isE() && el()?.artistMotion
    ? el().artistMotion(id, name, titles).then(v => v?.file
      ? { src: 'file://' + v.file.replace(/\\\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/%3A/g, ':') }
      : null)
    : Promise.resolve(null),
  // Refresh every artist's bio and picture from a provider (a background job; poll its status).
  artistsRefreshAllMetadata: (opts = {}) => isE() ? el().artistsRefreshAllMetadata(opts) : apiFetch('/artists/refresh-all', { method:'POST', body: opts }),
  artistsRefreshAllStatus: () => isE() ? el().artistsRefreshAllStatus() : apiFetch('/artists/refresh-all'),
  artistsRefreshAllCancel: () => isE() ? el().artistsRefreshAllCancel() : apiFetch('/artists/refresh-all', { method:'DELETE' }),
  artistSearchMetadata: (query, opts = {}) => isE()
    ? el().artistSearchMetadata(query, opts)
    : apiFetch(`/artists/metadata/search?${new URLSearchParams({ q: query || '', source: opts.source || 'either' })}`),
  artistApplyMetadataSelection: (id, selection, mode = 'both') => isE()
    ? el().artistApplyMetadataSelection(id, selection, mode)
    : apiFetch(`/artists/${id}/metadata-selection`, { method:'POST', body:{ selection, mode } }),
  artistClearImageOverride: (id) => isE() ? el().artistClearImageOverride(id) : apiFetch(`/artists/${id}/image/fallback`, { method:'POST' }),
  artistsForTrack: (trackId) => isE() ? el().artistsForTrack(trackId) : apiFetch(`/artists/for-track/${encodeURIComponent(trackId)}`),
  artistRename: (id, n) => isE() ? el().artistRename(id, n) : apiFetch(`/artists/${id}/rename`, { method:'PUT', body:{name:n} }),
  artistMerge: (s, t) => isE() ? el().artistMerge(s, t) : apiFetch('/artists/merge', { method:'POST', body:{sourceId:s,targetId:t} }),
  artistDelete: (id) => isE() ? el().artistDelete(id) : apiFetch(`/artists/${id}`, { method:'DELETE' }),
  trackSetArtwork: (id, d) => isE() ? el().trackSetArtwork(id, d) : apiFetch(`/tracks/${id}/artwork`, { method:'PUT', body:{imageData:d} }),
  trackSetGenre: (id, genre) => isE() ? el().trackSetGenre(id, genre) : apiFetch(`/tracks/${id}/genre`, { method:'PUT', body:{genre} }),
  getPlaylists: (uid) => isE() ? el().getPlaylists(uid) : apiFetch(`/playlists?userId=${uid||'guest'}`),
  createPlaylist: (n, uid, d) => isE() ? el().createPlaylist(n, uid, d) : apiFetch('/playlists', { method:'POST', body:{name:n,userId:uid,description:d} }),
  updatePlaylist: (id, d) => isE() ? el().updatePlaylist(id, d) : apiFetch(`/playlists/${id}`, { method:'PUT', body:d }),
  smartPlaylistPreview: (rules, uid) => isE() ? el().smartPlaylistPreview(rules, uid) : apiFetch('/playlists/smart-preview', { method:'POST', body:{ rules, userId: uid } }),
  addToPlaylist: (pl, tid) => isE() ? el().addToPlaylist(pl, tid) : apiFetch(`/playlists/${pl}/tracks`, { method:'POST', body:{trackId:tid} }),
  addMultipleToPlaylist: async (pl, trackIds) => {
    if (!trackIds || trackIds.length === 0) return
    for (const tid of trackIds) {
      await (isE() ? el().addToPlaylist(pl, tid) : apiFetch(`/playlists/${pl}/tracks`, { method:'POST', body:{trackId:tid} }))
    }
  }, 
  removeFromPlaylist: (pl, tid) => isE() ? el().removeFromPlaylist(pl, tid) : apiFetch(`/playlists/${pl}/tracks/${tid}`, { method:'DELETE' }),
  getPlaylistTracks: (pl) => isE() ? el().getPlaylistTracks(pl) : apiFetch(`/playlists/${pl}/tracks`),
  deletePlaylist: (pl) => isE() ? el().deletePlaylist(pl) : apiFetch(`/playlists/${pl}`, { method:'DELETE' }),
  playlistImport: (name, entries, userId) => isE() ? el().playlistImport(name, entries, userId || 'guest') : apiFetch('/playlists/import', { method: 'POST', body: { name, entries, userId: userId || 'guest' }}),
  playlistImportFile: (name, fileContent, fileType, userId) => isE() ? el().playlistImportFile(name, fileContent, fileType, userId || 'guest') : apiFetch('/playlists/import-file', { method:'POST', body:{name, fileContent, fileType, userId:userId||'guest'} }),
  previewExternalPlaylistImport: (payload) => isE() ? el().previewExternalPlaylistImport(payload) : apiFetch('/playlists/external-import-preview', { method:'POST', body:payload }),
  importExternalPlaylist: (payload) => isE() ? el().importExternalPlaylist(payload) : apiFetch('/playlists/external-import', { method:'POST', body:payload }),
  importExternalTrackMetadata: (payload) => isE() ? el().importExternalTrackMetadata(payload) : apiFetch('/playlists/external-import-metadata', { method:'POST', body:payload }),
  previewLinkPlaylist: (payload) => isE() ? el().previewLinkPlaylist(payload) : apiFetch('/playlists/link-preview', { method:'POST', body:payload }),
  importLinkPlaylist: (payload) => isE() ? el().importLinkPlaylist(payload) : apiFetch('/playlists/link-import', { method:'POST', body:payload }),
  // A playlist linked to one on Spotify / Tidal / Apple Music / Qobuz (desktop).
  playlistSyncStatus: (id) => isE() ? el().playlistSyncStatus(id) : Promise.resolve({ linked: false, unsupported: true }),
  playlistSyncLink: (id, url) => isE() ? el().playlistSyncLink(id, url) : Promise.resolve({ error: 'Playlist sync works in the desktop app.' }),
  playlistSyncUnlink: (id) => isE() ? el().playlistSyncUnlink(id) : Promise.resolve({ ok: true }),
  playlistSyncLinked: () => isE() ? el().playlistSyncLinked() : Promise.resolve([]),
  playlistSync: (id, userId) => isE() ? el().playlistSync(id, userId) : Promise.resolve({ error: 'Playlist sync works in the desktop app.' }),
  resolveGhostTrack: (ghostTrackId, targetTrackId, options = {}) => isE() ? el().resolveGhostTrack(ghostTrackId, targetTrackId, options) : apiFetch('/playlists/resolve-ghost', { method:'POST', body:{ ghostTrackId, targetTrackId, options } }),
  reorderPlaylist: (pl, trackIds) => isE() ? el().reorderPlaylist(pl, trackIds) : apiFetch(`/playlists/${pl}/reorder`, { method:'PUT', body:{trackIds} }),
  deduplicatePlaylist: pl => isE() ? el().deduplicatePlaylist(pl) : apiFetch(`/playlists/${pl}/deduplicate`, { method:'POST' }),
  getMixes: (uid) => isE() ? el().getMixes(uid) : apiFetch(`/mixes?userId=${uid||'guest'}`),
  getLyrics: (tid, ti, ar, al, dur, fp, opts = {}) => isE() ? el().getLyrics(tid, ti, ar, al, dur, fp, opts) : apiFetch(`/lyrics/${tid}?${new URLSearchParams({title:ti||'',artist:ar||'',album:al||'',duration:dur||'',filePath:fp||'',refresh:opts.refresh?'1':''})}`),
  getLyricsFrom: (providerId, tid, ti, ar, al, dur, fp) => isE() ? el().getLyricsFrom(providerId, tid, ti, ar, al, dur, fp) : apiFetch(`/lyrics/${tid}/from/${encodeURIComponent(providerId)}?${new URLSearchParams({title:ti||'',artist:ar||'',album:al||'',duration:dur||'',filePath:fp||''})}`),
  getLyricsSources: () => isE() ? el().getLyricsSources() : apiFetch('/lyrics/sources'),
  romanizeLyrics: (tid, lines) => isE() ? el().romanizeLyrics(tid, lines) : apiFetch(`/lyrics/${tid}/romanize`, { method:'POST', body:{ lines } }),
  detectLyricsLanguage: (tid, lines) => (isE() && typeof el().detectLyricsLanguage === 'function')
    ? el().detectLyricsLanguage(tid, lines)
    : apiFetch(`/lyrics/${tid}/detect-language`, { method:'POST', body:{ lines } }),
  translateLyrics: (tid, lines, targetLang = 'en') => (isE() && typeof el().translateLyrics === 'function')
    ? el().translateLyrics(tid, lines, targetLang)
    : apiFetch(`/lyrics/${tid}/translate`, { method:'POST', body:{ lines, targetLang } }),
  importLyrics: (tid, c, t, fp) => isE() ? el().importLyrics(tid, c, t, fp) : apiFetch(`/lyrics/${tid}/import`, { method:'POST', body:{content:c,type:t,filePath:fp} }),
  clearLyricsCache: (tid) => isE() ? el().clearLyricsCache(tid) : apiFetch(`/lyrics/${tid}`, { method:'DELETE' }),
  // The lyrics inside the track's own file (tags), read and written on request only.
  readFileLyrics: (tid) => isE() ? el().readFileLyrics(tid) : apiFetch(`/lyrics/${tid}/file`),
  writeFileLyrics: (tid, text) => isE() ? el().writeFileLyrics(tid, text) : apiFetch(`/lyrics/${tid}/file`, { method:'PUT', body:{ text } }),
  embedLyricsFrom: (providerId, tid, ti, ar, al, dur) => isE() ? el().embedLyricsFrom(providerId, tid, ti, ar, al, dur) : apiFetch(`/lyrics/${tid}/embed/${encodeURIComponent(providerId)}`, { method:'POST', body:{ title:ti||'', artist:ar||'', album:al||'', duration:dur||'' } }),
  exportLyricsFile: (providerId, tid, ti, ar, al, dur) => isE() && el()?.exportLyricsFile ? el().exportLyricsFile(providerId, tid, ti, ar, al, dur) : Promise.reject(new Error('File export is available in the desktop app.')),
  clearLyricsDb: () => isE() ? el().clearLyricsDb() : apiFetch('/lyrics/clear-all', { method:'POST' }),
  // Both keep the snapshot peekSettings() hands out, so a page can paint with
  // the real settings on its first frame instead of defaults.
  getSettings: () => {
    const revision = settingsRevision
    return Promise.resolve(isE() ? el().getSettings() : apiFetch('/settings')).then(s => {
      if (s && typeof s === 'object' && !s.error && revision === settingsRevision) settingsSnapshot = s
      return s
    })
  },
  saveSettings: (s) => Promise.resolve(isE() ? el().saveSettings(s) : apiFetch('/settings', { method:'PUT', body:s })).then(r => {
    if (!r?.error && Object.prototype.hasOwnProperty.call(s || {}, 'yt_cookie_header')) clearYoutubeAccountStatus()
    if (!r?.error && s && typeof window !== 'undefined' && ['yt_cookie_header', 'yt_account_session', 'yt_account_revision', 'lastfm_api_key', 'lastfm_username', 'lastfm_enabled', 'recommendation_source', 'spotify_sp_dc'].some(key => Object.prototype.hasOwnProperty.call(s, key))) {
      window.dispatchEvent(new Event('lokal:recommendation-access-changed'))
    }
    // Only what was actually saved goes into the snapshot.
    if (!r?.error && s && typeof s === 'object') {
      settingsRevision++
      if (settingsSnapshot) settingsSnapshot = { ...settingsSnapshot, ...s }
    }
    return r
  }),
  exportAllData: () => isE() ? el().exportAllData() : apiFetch('/settings/export-all'),
  importAllData: (payload) => isE() ? el().importAllData(payload) : apiFetch('/settings/import-all', { method:'POST', body: payload }),
  factoryReset: () => isE() ? el().factoryReset() : apiFetch('/settings/factory-reset', { method:'POST' }),
  clearTracks: () => isE() ? el().clearTracks() : apiFetch('/settings/clear-tracks', { method:'POST' }),
  getKeepCommaArtists: () => isE() ? el().getKeepCommaArtists() : apiFetch('/settings/keep-comma-artists'),
  setKeepCommaArtists: (artists) => isE() ? el().setKeepCommaArtists(artists) : apiFetch('/settings/keep-comma-artists', { method:'PUT', body:{artists} }),
  getArtistSplitWords: () => isE() ? el().getArtistSplitWords() : apiFetch('/settings/artist-split-words'),
  setArtistSplitWords: (words) => isE() ? el().setArtistSplitWords(words) : apiFetch('/settings/artist-split-words', { method: 'PUT', body: { words } }),
  getTheme: () => isE() ? el().getTheme() : apiFetch('/settings/theme'),
  saveTheme: (theme, overrides) => isE() ? el().saveTheme(theme, overrides) : apiFetch('/settings/theme', { method:'PUT', body:{theme, overrides} }),
  scanFolder: (f, o = {}) => isE() ? el().scanFolder(f, o) : apiFetch('/settings/scan', { method:'POST', body:{folder:f, full:!!o.full} }),
  connectNetworkShare: (location) => isE()
    ? el().connectNetworkShare(location)
    : Promise.resolve({ error: 'Network folder import is only available in the desktop application.' }),
  scanFolders: async (folders) => {
    const list = [...new Set((Array.isArray(folders) ? folders : []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))]
    if (isE()) return el().scanFolders(list)
    for (const folder of list) await api.scanFolder(folder)
    return api.saveSettings({ music_folders: JSON.stringify(list), music_folder: list[0] || '' })
  },
  resolveFileToPlay: (f) => isE() ? el().resolveFileToPlay(f) : Promise.resolve({ success: false, error: 'Electron only' }),
  onOpenFileRequest: (fn) => { if (isE() && typeof el().onOpenFileRequest === 'function') return el().onOpenFileRequest(fn); return () => {} },
  updateThumbarState: (state) => (isE() && typeof el().updateThumbarState === 'function') ? el().updateThumbarState(state) : Promise.resolve(),
  // Settings > Library > Open Folders In: start one of those programs on a sidebar folder.
  launchFolderApp: (appPath, folder) => isE() ? el().launchFolderApp(appPath, folder) : Promise.resolve({ ok: false }),
  setTaskbarProgress: (state) => (isE() && typeof el().setTaskbarProgress === 'function') ? el().setTaskbarProgress(state) : Promise.resolve(),
  onThumbarCommand: (fn) => { if (isE() && typeof el().onThumbarCommand === 'function') return el().onThumbarCommand(fn); return () => {} },
  openFolder: () => isE() ? el().openFolder() : Promise.resolve(null),
  openFile: (f) => isE() ? el().openFile(f) : Promise.resolve(null),
  readFileBinary: (fp) => isE() ? el().readFileBinary(fp) : Promise.resolve(null),
  readFileAsDataURL: (fp) => isE() ? el().readFileAsDataURL(fp) : Promise.resolve(null),
  searchYT: (q, page = 1) => isE() ? el().searchYT(q, page) : apiFetch(`/download/search?q=${encodeURIComponent(q)}&page=${page}`),
  searchYTPaginated: (q, page = 1) => isE() ? el().searchYT(q, page) : apiFetch(`/download/search?q=${encodeURIComponent(q)}&page=${page}`),
  searchYTArtist: (artist, page = 1) => isE() ? el().searchYTArtist(artist, page) : apiFetch(`/download/artist-search?q=${encodeURIComponent(artist)}&page=${page}`),
  downloadYT: (url, o) => isE() ? el().downloadYT(url, o) : apiFetch('/download', { method:'POST', body:{url,...o} }),
  // Online results (YouTube Music 'yt', SoundCloud 'sc'), streamed with the user's yt-dlp.
  onlineSearch: (q, provider = 'yt', options = {}) => isE()
    ? el().onlineSearch(q, provider, { automatic: options.automatic === true })
    : apiFetch(`/online/search?${new URLSearchParams({ q, provider })}`),
  globalCatalogueSearch: (q, options = {}) => isE() ? el().globalCatalogueSearch(q, options) : apiFetch(`/online/global?${new URLSearchParams({ q, ...options })}`),
  onlineSave: (items) => isE() ? el().onlineSave(items) : apiFetch('/online/save', { method:'POST', body:{ items } }),
  onlinePrepare: async (provider, id, force = false, options = {}) => {
    const started = await (isE() ? el().onlinePrepare(provider, id, force, { automatic: options.automatic === true }) : apiFetch(`/online/prepare/${encodeURIComponent(provider)}/${encodeURIComponent(id)}${force ? '?force=1' : ''}`, { method:'POST' }))
    if (!started?.pending) return started
    const operation = cancel => api.addonsPackages({ action: 'operation', id: started.operationId, cancel })
    const abort = () => { operation(true).catch(() => {}) }
    options.signal?.addEventListener('abort', abort, { once: true })
    const deadline = Date.now() + 15 * 60 * 1000
    try {
      for (;;) {
        if (options.signal?.aborted || Date.now() > deadline) { abort(); return { error: 'Audio preparation cancelled or timed out' } }
        const status = await operation(false)
        options.onProgress?.(status)
        if (status?.ok || status?.error || status?.status === 'cancelled') return status
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    } finally { options.signal?.removeEventListener('abort', abort) }
  },
  onlineProviders: () => isE() ? el().onlineProviders() : apiFetch('/online/providers'),
  // A streamed song's genre (looked up when it has none), or null.
  onlineGenre: (trackId) => isE() ? el().onlineGenre(trackId) : apiFetch(`/online/genre/${encodeURIComponent(trackId)}`).then(r => r?.genre || null),
  // A misspelt search's correction: { corrected, source } (corrected null when none).
  searchSpelling: (q) => isE() ? el().searchSpelling(q) : apiFetch(`/online/spelling?q=${encodeURIComponent(q)}`),
  discoveryArtwork: items => isE() ? el().discoveryArtwork(items) : apiFetch('/online/artwork', { method: 'POST', body: { items } }),
  discoveryCatalogue: options => options.source === 'youtube'
    ? (isE() ? el().youtubeCatalogue(options) : apiFetch('/online/catalogue', { method: 'POST', body: options }))
    : (isE() ? el().lastfmCatalogue(options) : apiFetch('/lastfm/catalogue', { method: 'POST', body: options })),
  youtubeAccount: (force = false) => {
    const version = youtubeAccountStatusRevision()
    return Promise.resolve(isE() ? el().youtubeAccount(force) : apiFetch(`/online/account?force=${force ? '1' : '0'}`)).then(result => { updateYoutubeAccountStatus(result, version); return result })
  },
  youtubeSignIn: async options => {
    if (!isE()) return { error: 'YouTube Music sign-in is available in the desktop app.' }
    const result = await el().youtubeSignIn(options)
    if (result?.authenticated) {
      clearYoutubeAccountStatus()
      updateYoutubeAccountStatus(result)
      window.dispatchEvent(new Event('lokal:recommendation-access-changed'))
    }
    return result
  },
  youtubeCancelSignIn: () => isE() ? el().youtubeCancelSignIn() : Promise.resolve({ ok: true }),
  onYoutubeSignInStatus: callback => isE() && el()?.onYoutubeSignInStatus ? el().onYoutubeSignInStatus(callback) : () => {},
  youtubeDisconnect: async () => {
    const result = isE() ? await el().youtubeDisconnect() : await api.saveSettings({ yt_cookies: '0', yt_cookie_header: '', yt_account_session: '0' })
    if (!result?.error && result?.ok) {
      clearYoutubeAccountStatus()
      window.dispatchEvent(new Event('lokal:recommendation-access-changed'))
    }
    return result
  },
  youtubeLibraryPlaylists: (force = false) => isE() ? el().youtubeLibraryPlaylists(force) : Promise.resolve({ playlists: [], error: 'Desktop-only YouTube Music account.' }),
  youtubeLibraryPlaylistTracks: (id, force = false) => isE() ? el().youtubeLibraryPlaylistTracks(id, force) : Promise.resolve({ tracks: [], error: 'Desktop-only YouTube Music account.' }),
  youtubeAccountPlaylist: (playlistId) => isE() ? el().youtubeAccountPlaylist(playlistId) : apiFetch(`/online/account-playlist/${encodeURIComponent(playlistId)}`),
  youtubeRadio: (videoId) => isE() ? el().youtubeRadio(videoId) : apiFetch(`/online/radio/${encodeURIComponent(videoId)}`),
  youtubeSetLiked: (videoId, liked) => isE() ? el().youtubeSetLiked(videoId, liked) : apiFetch('/online/account-liked', { method: 'POST', body: { videoId, liked } }),
  atmosCapabilities: () => isE() && el().atmosCapabilities ? el().atmosCapabilities() : Promise.resolve({ available: false }),
  atmosDevices: () => isE() && el().atmosDevices ? el().atmosDevices() : Promise.resolve({ devices: [] }),
  atmosChooseMpv: () => isE() && el().atmosChooseMpv ? el().atmosChooseMpv() : Promise.resolve({ error: 'Desktop only' }),
  atmosOpenFile: (device, mode) => isE() && el().atmosOpenFile ? el().atmosOpenFile(device, mode) : Promise.resolve({ error: 'Desktop only' }),
  atmosPlay: (provider, id, device = '', mode = 'hdmi') => isE() && el().atmosPlay
    ? el().atmosPlay(provider, id, device, mode) : Promise.resolve({ error: 'Native Atmos HDMI output requires desktop Lokal' }),
  atmosStop: () => isE() && el().atmosStop ? el().atmosStop() : Promise.resolve({ ok: true }),
  atmosCommand: command => isE() && el().atmosCommand ? el().atmosCommand(command) : Promise.resolve({ error: 'Unavailable' }),
  onAtmosStatus: callback => isE() && el()?.onAtmosStatus ? el().onAtmosStatus(callback) : () => {},
  onlineDownloadUrl: (provider, id) => isE() ? el().onlineDownloadUrl(provider, id) : apiFetch(`/online/download-url/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`, { method:'POST' }),
  // Addons: online sources added by manifest URL (Settings → Addons).
  addonsList: () => isE() ? el().addonsList() : apiFetch('/online/addons'),
  // An addon's album / artist page (when its manifest lists "album" / "artist").
  addonAlbum: (provider, id) => isE() ? el().addonAlbum(provider, id) : apiFetch(`/online/addon-album/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`),
  addonArtist: (provider, id) => isE() ? el().addonArtist(provider, id) : apiFetch(`/online/addon-artist/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`),
  addonsInstall: (url) => isE() ? el().addonsInstall(url) : apiFetch('/online/addons', { method:'POST', body:{ url } }),
  addonsRemove: (key) => isE() ? el().addonsRemove(key) : apiFetch(`/online/addons/${encodeURIComponent(key)}`, { method:'DELETE' }),
  addonsSetEnabled: (key, enabled) => isE() ? el().addonsSetEnabled(key, enabled) : apiFetch(`/online/addons/${encodeURIComponent(key)}/enabled`, { method:'PUT', body:{ enabled } }),
  addonsSetSettings: (key, values) => isE() ? el().addonsSetSettings(key, values) : apiFetch(`/online/addons/${encodeURIComponent(key)}/settings`, { method:'PUT', body:{ values } }),
  addonsPackages: request => isE() ? el().addonsPackages(request) : apiFetch('/online/addons/packages', { method:'POST', body:request }),
  // An addon's access was checked again (its login window closed). Desktop only.
  onAddonAuthChanged: fn => isE() && el().onAddonAuthChanged ? el().onAddonAuthChanged(fn) : () => {},
  // Casting (desktop only; electron/ipc/cast.js).
  castAvailable: () => isE() && !!el()?.castDevices,
  castDevices: () => isE() && el()?.castDevices ? el()?.castDevices() : Promise.resolve([]),
  castAddDevice: (address) => Promise.resolve(el()?.castAddDevice?.(address)),
  castRemoveDevice: (id) => Promise.resolve(el()?.castRemoveDevice?.(id)),
  castConnect: (deviceId) => Promise.resolve(el()?.castConnect?.(deviceId)),
  castDisconnect: (options) => isE() && el()?.castDisconnect ? el()?.castDisconnect(options) : Promise.resolve(null),
  castStatus: () => isE() && el()?.castStatus ? el()?.castStatus() : Promise.resolve({ state: 'idle' }),
  castSetWindow: (window) => Promise.resolve(el()?.castSetWindow?.(window)),
  castCommand: (command) => Promise.resolve(el()?.castCommand?.(command)),
  castCustom: (data) => isE() && el()?.castCustom ? el()?.castCustom(data) : Promise.resolve(false),
  castUpNext: (tracks) => isE() && el()?.castUpNext ? el()?.castUpNext(tracks) : Promise.resolve(false),
  castVideo: (request) => isE() && el()?.castVideo ? el()?.castVideo(request) : Promise.resolve({ found: false }),
  onCastDevices: fn => isE() && el()?.onCastDevices ? el()?.onCastDevices(fn) : () => {},
  onCastStatus: fn => isE() && el()?.onCastStatus ? el()?.onCastStatus(fn) : () => {},
  onCastEnded: fn => isE() && el()?.onCastEnded ? el()?.onCastEnded(fn) : () => {},
  onCastFinished: fn => isE() && el()?.onCastFinished ? el()?.onCastFinished(fn) : () => {},
  onCastTrackError: fn => isE() && el()?.onCastTrackError ? el()?.onCastTrackError(fn) : () => {},
  onCastCustom: fn => isE() && el()?.onCastCustom ? el()?.onCastCustom(fn) : () => {},
  onlineStreamURL: (provider, id) => isE() ? `lokal-stream://${provider}/${encodeURIComponent(id)}` : `${BASE}/online/stream/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`,
  downloadPlaylist: (url, o) => isE() ? el().downloadPlaylist(url, o) : apiFetch('/download/playlist', { method:'POST', body:{url,...o} }),
  getDownloadedPlaylists: () => isE() ? el().getDownloadedPlaylists() : apiFetch('/download/playlists'),
  redownloadPlaylist: (id) => isE() ? el().redownloadPlaylist(id) : apiFetch('/download/playlist/redownload', { method:'POST', body:{playlistId:id} }),
  removeFromPlaylistArchive: (id, videoId) => isE() ? el().removeFromPlaylistArchive(id, videoId) : apiFetch('/download/playlist/remove-archive', { method:'POST', body:{playlistId:id, videoId} }),
  deleteDownloadedPlaylist: (id) => isE() ? el().deleteDownloadedPlaylist(id) : apiFetch('/download/playlist', { method:'DELETE', body:{playlistId:id} }),
  getPlaylistArchiveIds: (id) => isE() ? el().getPlaylistArchiveIds(id) : apiFetch(`/download/playlist/archive-ids?playlistId=${id}`),
  linkInfo: (url) => isE() ? el().linkInfo(url) : apiFetch('/download/link-info', { method:'POST', body:{url} }),
  cancelDownload: (id) => isE() ? el().cancelDownload(id) : apiFetch('/download/cancel', { method:'POST', body:{id} }),
  getDownloadQueue: () => isE() ? el().getDownloadQueue() : apiFetch('/download/queue'),
  retryDownload: (id) => isE() ? el().retryDownload(id) : apiFetch('/download/retry', { method:'POST', body:{id} }),
  removeDownload: (id) => isE() ? el().removeDownload(id) : apiFetch('/download/remove', { method:'POST', body:{id} }),
  cancelAllDownloads: () => {
    cancelDownloadBatches()
    return isE() ? el().cancelAllDownloads() : apiFetch('/download/cancel-all', { method:'POST', body:{} })
  },
  clearFinishedDownloads: () => isE() ? el().clearFinishedDownloads() : apiFetch('/download/clear-finished', { method:'POST', body:{} }),
  markDownloadsSeen: () => isE() ? el().markDownloadsSeen() : apiFetch('/download/seen', { method:'POST', body:{} }),
  storageLocations: () => isE() ? el().storageLocations() : Promise.resolve(null),
  chooseStorageLocation: (kind) => isE() ? el().chooseStorageLocation(kind) : Promise.resolve(null),
  resetStorageLocation: (kind) => isE() ? el().resetStorageLocation(kind) : Promise.resolve(null),
  cacheUsage: () => isE() ? el().cacheUsage() : Promise.resolve(null),
  cacheTrim: () => isE() ? el().cacheTrim() : Promise.resolve(null),
  cacheClear: () => isE() ? el().cacheClear() : Promise.resolve(null),
  // Cache Analysis page (desktop only: it reads the app's folder).
  cacheAnalysisRun: () => isE() && el().cacheAnalysisRun ? el().cacheAnalysisRun() : Promise.resolve({ ok: false, unsupported: true }),
  cacheAnalysisClean: (mode) => isE() && el().cacheAnalysisClean ? el().cacheAnalysisClean(mode) : Promise.resolve({ ok: false, unsupported: true }),
  onCacheAnalysisProgress: (fn) => isE() && el().onCacheAnalysisProgress ? el().onCacheAnalysisProgress((_, p) => fn(p)) : () => {},
  artworkMesh: (trackId) => isE() ? el().artworkMesh(trackId) : apiFetch(`/artwork-fx/mesh/${encodeURIComponent(trackId)}`).then(r => (Array.isArray(r) ? r : null)),
  // Online radio: a cover given as a URL (a station has no library row).
  artworkMeshFromUrl: (url) => isE() ? el().artworkMeshFromUrl(url) : apiFetch(`/artwork-fx/mesh-url?${new URLSearchParams({ url })}`).then(r => (Array.isArray(r) ? r : null)),
  radioGetCatalog: () => isE() ? el().radioGetCatalog() : apiFetch('/radio/catalog'),
  radioLoadCatalog: (url) => isE() ? el().radioLoadCatalog(url) : apiFetch('/radio/catalog', { method: 'POST', body: { url } }),
  radioNowPlaying: (stationApi) => isE() ? el().radioNowPlaying(stationApi) : apiFetch('/radio/now-playing', { method: 'POST', body: { api: stationApi } }).catch(() => null),
  // { src, source } -- src is something a <video> can play in this mode.
  spotifyCanvasCheck: () => isE() ? el().spotifyCanvasCheck() : apiFetch('/artwork-fx/spotify-check', { method: 'POST' }),
  // Home → Releases → Followed artists: those followed on Spotify or in the Apple Music library (desktop app).
  linkedFollowedArtists: (service) => isE() && el().linkedFollowedArtists ? el().linkedFollowedArtists(service) : Promise.resolve({ error: 'Linking accounts needs the desktop app.' }),
  motionCover: (trackId) => isE()
    ? el().motionCover(trackId).then(r => (r?.file ? { ...r, src: `file://${r.file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/%3A/g, ':')}` } : null))
    : apiFetch(`/artwork-fx/motion/${encodeURIComponent(trackId)}`).then(r => (r?.src ? r : null)),
  // The official music video of a track (desktop only): { videoId, src?, segments, ... } or null.
  musicVideo: (trackId) => isE() && el().musicVideo
    ? el().musicVideo(trackId).then(musicVideoResult)
    : Promise.resolve(null),
  // Download the discovered video into the shared cache for local playback.
  musicVideoDownload: (trackId) => isE() && el().musicVideoDownload
    ? el().musicVideoDownload(trackId).then(musicVideoResult)
    : Promise.resolve(null),
  musicVideoPrepare: (trackId) => isE() && el().musicVideoPrepare ? el().musicVideoPrepare(trackId).then(musicVideoResult) : Promise.resolve(null),
  musicVideoDeleteDownload: async (trackId, videoId) => {
    if (!isE() || !el().musicVideoDeleteDownload) return { error: 'Music videos are available in the desktop app.' }
    window.dispatchEvent(new CustomEvent('lokal:music-video-changing', { detail: { trackId, videoId } }))
    await new Promise(resolve => setTimeout(resolve, 0))
    try { return await el().musicVideoDeleteDownload(trackId) }
    finally { window.dispatchEvent(new Event('lokal:refresh')) }
  },
  musicVideoList: () => isE() && el().musicVideoList ? el().musicVideoList() : Promise.resolve([]),
  musicVideoSave: (trackId, saved = true) => isE() && el().musicVideoSave
    ? el().musicVideoSave(trackId, saved) : Promise.resolve({ error: 'Music videos are available in the desktop app.' }),
  // How the lookup is going ({ trackId, stage, index, total }), desktop only.
  onMusicVideoProgress: (fn) => isE() && el().onMusicVideoProgress ? el().onMusicVideoProgress((_, p) => fn(p)) : () => {},
  indexAllMusicVideos: () => isE() && el().indexAllMusicVideos ? el().indexAllMusicVideos() : Promise.resolve(null),
  // A song's own video (Edit Track: any link or file), for the side panel's
  // loop: { src } or { error }. fallback: the first address didn't play.
  clipVideoSource: (link, options) => isE() && el().clipVideoSource
    ? el().clipVideoSource(link, options).catch(e => ({ error: e?.message || 'Failed' }))
    : Promise.resolve({ error: 'Only in the desktop app' }),
  musicVideoAnimatedPreview: (videoId, query, force = false) => isE() && el().musicVideoAnimatedPreview ? el().musicVideoAnimatedPreview(videoId, query, force) : Promise.resolve(null),
  cancelMusicVideoIndex: () => isE() && el().cancelMusicVideoIndex ? el().cancelMusicVideoIndex() : Promise.resolve(null),
  musicVideoIndexStatus: () => isE() && el().musicVideoIndexStatus ? el().musicVideoIndexStatus() : Promise.resolve(null),
  onMusicVideoIndexProgress: (fn) => isE() && el().onMusicVideoIndexProgress ? el().onMusicVideoIndexProgress((_, p) => fn(p)) : () => {},
  indexAllLyrics: () => isE() && el().indexAllLyrics ? el().indexAllLyrics() : Promise.resolve(null),
  cancelLyricsIndex: () => isE() && el().cancelLyricsIndex ? el().cancelLyricsIndex() : Promise.resolve(null),
  // Lyrics Analysis page (desktop only: it reads every file in the music folder).
  lyricsAnalysisGet: () => isE() && el().lyricsAnalysisGet ? el().lyricsAnalysisGet() : Promise.resolve({ report: null, progress: { running: false }, unsupported: true }),
  lyricsAnalysisRun: () => isE() && el().lyricsAnalysisRun ? el().lyricsAnalysisRun() : Promise.resolve({ ok: false, error: 'Lyrics analysis works in the desktop app.' }),
  onLyricsAnalysisProgress: (fn) => isE() && el().onLyricsAnalysisProgress ? el().onLyricsAnalysisProgress((_, p) => fn(p)) : () => {},
  onLyricsIndexProgress: (fn) => isE() && el().onLyricsIndexProgress ? el().onLyricsIndexProgress((_, p) => fn(p)) : () => {},
  playableFile: (fp) => isE() ? el().playableFile(fp) : Promise.resolve(null),
  soulseekStatus: () => isE() ? el().soulseekStatus() : apiFetch('/download/soulseek/status'),
  soulseekSearch: (text) => isE() ? el().soulseekSearch(text) : apiFetch('/download/soulseek/search', { method:'POST', body:{ text } }),
  soulseekResults: (id) => isE() ? el().soulseekResults(id) : apiFetch(`/download/soulseek/search/${encodeURIComponent(id)}`),
  soulseekFinishSearch: (id) => isE() ? el().soulseekFinishSearch(id) : apiFetch(`/download/soulseek/search/${encodeURIComponent(id)}`, { method:'PUT' }),
  soulseekStopSearch: (id) => isE() ? el().soulseekStopSearch(id) : apiFetch(`/download/soulseek/search/${encodeURIComponent(id)}`, { method:'DELETE' }),
  soulseekDownload: (file, opts = {}) => isE() ? el().soulseekDownload(file, opts) : apiFetch('/download/soulseek/download', { method:'POST', body:{ file, ...opts } }),
  // Settings → Soulseek, built in (desktop app): Lokal runs the Soulseek client itself.
  soulseekClient: () => isE() && el().soulseekClient ? el().soulseekClient() : Promise.resolve(null),
  soulseekConnect: () => isE() && el().soulseekConnect ? el().soulseekConnect() : Promise.resolve({ error: 'Soulseek needs the Lokal desktop app.' }),
  soulseekDisconnect: () => isE() && el().soulseekDisconnect ? el().soulseekDisconnect() : Promise.resolve(null),
  soulseekCheckUpdate: () => isE() && el().soulseekCheckUpdate ? el().soulseekCheckUpdate() : Promise.resolve({ error: 'Soulseek needs the Lokal desktop app.' }),
  soulseekUpdate: () => isE() && el().soulseekUpdate ? el().soulseekUpdate() : Promise.resolve({ error: 'Soulseek needs the Lokal desktop app.' }),
  onSoulseekClient: (fn) => isE() && el().onSoulseekClient ? el().onSoulseekClient((_, status) => fn(status)) : () => {},
  // Audio quality (codec / lossless / spectrum check) and "Get it in lossless".
  qualitySummary: () => isE() ? el().qualitySummary() : apiFetch('/quality/summary'),
  qualityList: (opts = {}) => isE() ? el().qualityList(opts) : apiFetch(`/quality/list?${new URLSearchParams(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))}`),
  qualityStatus: () => isE() ? el().qualityStatus() : apiFetch('/quality/status'),
  qualityRead: (opts = {}) => isE() ? el().qualityRead(opts) : apiFetch('/quality/read', { method:'POST', body: opts }),
  qualityCheck: (opts = {}) => isE() ? el().qualityCheck(opts) : apiFetch('/quality/check', { method:'POST', body: opts }),
  qualityCheckOne: (trackId) => isE() ? el().qualityCheckOne(trackId) : apiFetch(`/quality/check/${encodeURIComponent(trackId)}`, { method:'POST' }),
  qualityCancel: () => isE() ? el().qualityCancel() : apiFetch('/quality/cancel', { method:'POST' }),
  qualityBuyLinks: (trackId) => isE() ? el().qualityBuyLinks(trackId) : apiFetch(`/quality/buy/${encodeURIComponent(trackId)}`),
  updaterDownload: () => isE() ? el().updaterDownload() : Promise.resolve({ error: 'Electron only' }),
  getToolsStatus: () => isE() ? el().getToolsStatus() : Promise.resolve({}),
  getYtDlpVersionStatus: () => isE() ? el().getYtDlpVersionStatus() : Promise.resolve({ found: false, error: 'Electron only' }),
  downloadYtDlp: () => isE() ? el().downloadYtDlp() : Promise.resolve({ error: 'Electron only' }),
  downloadFfmpeg: () => isE() ? el().downloadFfmpeg() : Promise.resolve({ error: 'Electron only' }),
  setCustomToolPath: (tool, path) => isE() ? el().setCustomToolPath(tool, path) : Promise.resolve({ error: 'Electron only' }),
  detectTools: () => isE() ? el().detectTools() : Promise.resolve({}),
  onToolsDownloadProgress: (fn) => { if (isE()) return el().onToolsDownloadProgress(fn); return () => {} },
  getRandomTrack: () => isE() ? el().getRandomTrack() : apiFetch('/tracks/random'),
  getTopGenres: () => isE() ? el().getTopGenres() : apiFetch('/tracks/top-genres'),
  getAllGenres: () => isE() ? el().getAllGenres() : apiFetch('/tracks/genres'),
  // The Genres tab: { genres: [{ name, count, artworks }], none } (see electron/genreList.js).
  getGenreSummary: () => isE() ? el().getGenreSummary() : apiFetch('/tracks/genre-summary'),
  historyExport: (uid, format) => isE() ? el().historyExport(uid, format) : apiFetch(`/tracks/history/export?userId=${uid||'guest'}&format=${format||'json'}`),
  register: (d) => isE() ? el().register(d) : apiFetch('/users/register', { method:'POST', body:d }),
  login: (d) => isE() ? el().login(d) : apiFetch('/users/login', { method:'POST', body:d }),
  listUsers: () => isE() ? el().listUsers() : apiFetch('/users'),
  deleteUser: (userId) => isE() ? el().deleteUser(userId) : apiFetch(`/users/${userId}`, { method:'DELETE' }),
  updateProfile: async (d) => {
    const payload = normalizeProfilePayload(d)
    const result = isE()
      ? await el().updateProfile(payload)
      : await apiFetch(`/users/${payload.userId}`, { method:'PUT', body: payload })
    return result?.user || result
  },
  getUserStats: (uid) => isE() ? el().getUserStats(uid) : apiFetch(`/users/${uid}/stats`),
  getUserRecap: (uid) => isE() ? el().getUserRecap(uid) : apiFetch(`/users/${uid || 'guest'}/recap`),
  getListeningRecap: (uid, opts = {}) => isE()
    ? el().getListeningRecap(uid, opts)
    : apiFetch(`/recaps/${uid || 'guest'}?${new URLSearchParams(Object.fromEntries(Object.entries(opts || {}).filter(([, value]) => value !== undefined && value !== null)))}`),
  // One artist's or genre's songs in a recap: opts = periodQuery(period) + { artist } or { genre }.
  getRecapTracks: (uid, opts = {}) => isE()
    ? el().getRecapTracks(uid, opts)
    : apiFetch(`/recaps/${uid || 'guest'}/tracks?${new URLSearchParams(Object.fromEntries(Object.entries(opts || {}).filter(([, value]) => value !== undefined && value !== null)))}`),
  getListeningDays: (uid, opts = {}) => isE() ? el().getListeningDays(uid, opts) : apiFetch(`/recaps/${uid || 'guest'}/days?${new URLSearchParams(Object.fromEntries(Object.entries(opts || {}).filter(([, value]) => value !== undefined && value !== null)))}`),
  // One artist's plays by the user (30 s or more, files and streams), with their most played songs.
  getArtistPlays: (uid, artistId) => isE() ? el().getArtistPlays(uid, artistId) : apiFetch(`/recaps/${uid || 'guest'}/artist/${encodeURIComponent(artistId)}`),
  // One song's plays by the user (30 s or more), files and streams alike.
  getTrackPlays: (uid, trackId) => isE() ? el().getTrackPlays(uid, trackId) : apiFetch(`/recaps/${uid || 'guest'}/track/${encodeURIComponent(trackId)}`),
  getListeningPreferences: (uid) => isE() ? el().getListeningPreferences(uid) : apiFetch(`/recaps/${uid || 'guest'}/preferences`),
  discordSetActivity: (t, p) => { if (isE() && el().discordSetActivity) return el().discordSetActivity(t, p); return Promise.resolve() },
  discordConnect: (id) => isE() ? el().discordConnect(id) : Promise.resolve(false),
  discordDisconnect: () => isE() ? el().discordDisconnect() : Promise.resolve(),
  discordStatus: () => isE() && el().discordStatus ? el().discordStatus() : Promise.resolve({ connected: false }),
  openExternal: (url) => isE() ? el().openExternal(url) : Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer')),
  lastfmConnect: (apiKey, apiSecret, token) => isE() ? el().lastfmConnect(apiKey, apiSecret, token) : apiFetch('/lastfm/connect', { method:'POST', body:{apiKey, apiSecret, token} }),
  lastfmAuthorize: (apiKey) => {
    const url = buildLastfmAuthUrl(apiKey)
    return isE() ? el().openExternal(url) : Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer'))
  },
  lastfmGetArtistInfo: (artist) => isE() ? el().lastfmGetArtistInfo(artist) : apiFetch(`/lastfm/artist/${encodeURIComponent(artist)}`),
  lastfmGetTrackInfo: (artist, track) => isE() ? el().lastfmGetTrackInfo(artist, track) : apiFetch(`/lastfm/track?${new URLSearchParams({artist, track})}`),
  lastfmGetSimilarArtists: (artist, limit) => isE() ? el().lastfmGetSimilarArtists(artist, limit) : apiFetch(`/lastfm/similar/${encodeURIComponent(artist)}?limit=${limit || 5}`),
  lastfmScrobble: (artist, track, album, duration, timestamp) => isE() ? el().lastfmScrobble(artist, track, album, duration, timestamp) : apiFetch('/lastfm/scrobble', { method:'POST', body:{artist, track, album, duration, timestamp} }),
  lastfmDiscovery: (page = 0, force = false) => isE() ? el().lastfmDiscovery(page, force) : apiFetch(`/lastfm/discovery?page=${encodeURIComponent(page)}&force=${force ? '1' : '0'}`),
  lastfmSimilar: (artist, track, limit = 24) => isE() ? el().lastfmSimilar(artist, track, limit) : apiFetch(`/lastfm/similar-music?${new URLSearchParams({ artist, ...(track ? { track } : {}), limit: String(limit) })}`),
  lastfmLoved: (page) => isE() ? el().lastfmLoved(page) : apiFetch(`/lastfm/loved${page ? `?page=${encodeURIComponent(page)}` : ''}`),
  lastfmSetLoved: (artist, track, loved) => isE() ? el().lastfmSetLoved(artist, track, loved) : apiFetch('/lastfm/loved', { method:'POST', body:{ artist, track, loved } }),
  lastfmSyncLikes: (uid, page) => isE() ? el().lastfmSyncLikes(uid || 'guest', page) : apiFetch('/lastfm/sync-likes', { method:'POST', body:{ userId: uid || 'guest', page } }),
  listenbrainzStatus: () => isE() ? el().listenbrainzStatus() : apiFetch('/listenbrainz/status'),
  listenbrainzConnect: (token) => isE() ? el().listenbrainzConnect(token) : apiFetch('/listenbrainz/connect', { method: 'POST', body: { token } }),
  listenbrainzDisconnect: () => isE() ? el().listenbrainzDisconnect() : apiFetch('/listenbrainz/disconnect', { method: 'POST' }),
  listenbrainzSetEnabled: (enabled) => isE() ? el().listenbrainzSetEnabled(enabled) : apiFetch('/listenbrainz/enabled', { method: 'POST', body: { enabled } }),
  listenbrainzNowPlaying: (track) => isE() ? el().listenbrainzNowPlaying(track) : apiFetch('/listenbrainz/now-playing', { method: 'POST', body: { track } }),
  listenbrainzSubmit: (track, listenedAt) => isE() ? el().listenbrainzSubmit(track, listenedAt) : apiFetch('/listenbrainz/submit', { method: 'POST', body: { track, listenedAt } }),
  lastfmUpdateNowPlaying: (artist, track, album, duration) => isE() ? el().lastfmUpdateNowPlaying(artist, track, album, duration) : apiFetch('/lastfm/update-now-playing', { method:'POST', body:{artist, track, album, duration} }),
  onLastfmAuthToken: (fn) => {
    if (isE() && typeof el().onLastfmAuthToken === 'function') {
      return el().onLastfmAuthToken(fn)
    }
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return
      if (event.data?.type !== 'lokal-lastfm-auth-token') return
      fn(event.data.token || '')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  },
  pluginsList: () => isE() ? el().pluginsList() : apiFetch('/plugins'),
  pluginsReload: () => isE() ? el().pluginsReload() : apiFetch('/plugins/reload', { method: 'POST' }),
  pluginsEnable: (pluginId) => isE() ? el().pluginsEnable(pluginId) : apiFetch(`/plugins/${encodeURIComponent(pluginId)}/enable`, { method: 'POST' }),
  pluginsDisable: (pluginId) => isE() ? el().pluginsDisable(pluginId) : apiFetch(`/plugins/${encodeURIComponent(pluginId)}/disable`, { method: 'POST' }),
  pluginsInstallFromFolder: (sourceFolderPath) => isE() ? el().pluginsInstallFromFolder(sourceFolderPath) : apiFetch('/plugins/install-folder', { method: 'POST', body: { sourceFolderPath } }),
  pluginsRemove: (pluginId) => isE() ? el().pluginsRemove(pluginId) : apiFetch(`/plugins/${encodeURIComponent(pluginId)}`, { method: 'DELETE' }),
  onScanProgress: (fn) => { if (isE()) return el().onScanProgress(fn); return () => {} },
  onDownloadProgress: (fn) => { if (isE()) return el().onDownloadProgress(fn); return () => {} },
  getAvatarSrc: (user) => {
    if (!user) return 'fallback_nopfp.png';
    if (user.avatar_path) {
       const version = user.avatar_updated_at ? `?v=${user.avatar_updated_at}` : '';
       return isE() ? `file://${user.avatar_path}${version}` : `${BASE}/avatar/${user.id}${version}`;
    }
    return 'fallback_nopfp.png';
  },
  openLogs: () => isE() ? el().openLogs() : Promise.resolve(),
  showItemInFolder: filePath => isE() && el()?.showItemInFolder ? el().showItemInFolder(filePath) : Promise.resolve({ error: 'Electron only' }),
  log: (level, message) => isE() ? el().log(level, message) : console.log(`[${level}] ${message}`),
  getPerfSettings: () => isE() ? el().getPerfSettings() : Promise.resolve(loadBrowserPerformanceSettings()),
  getRemoteConnectionInfo: () => isE() && el()?.getRemoteConnectionInfo ? el().getRemoteConnectionInfo() : Promise.resolve({ error: 'Electron only' }),
  openExternal: (url) => isE() && el()?.openExternal ? el().openExternal(url) : Promise.resolve(),
  savePerfSettings: (s) => isE() ? el().savePerfSettings(s) : Promise.resolve(saveBrowserPerformanceSettings(s)),
  setMediaKeyPreference: (enabled) => (isE() && typeof el().setMediaKeyPreference === 'function') ? el().setMediaKeyPreference(enabled) : Promise.resolve({ ok: false, enabled: false }),
  relaunchApp: () => isE() ? el().relaunchApp() : Promise.resolve(),
  onPerfSettings: (fn) => { if (isE()) return el().onPerfSettings(fn); return onBrowserPerformanceSettings(fn) },
  updaterInstall: () => isE() ? el().updaterInstall() : Promise.resolve(),
  updaterCheck: () => isE() ? el().updaterCheck() : Promise.resolve(),
  getVersion: () => isE() ? el().getVersion() : Promise.resolve('1.0.0'),
  isWindowsStore: () => isE() && el().isWindowsStore ? el().isWindowsStore() : Promise.resolve(false),
  onUpdaterEvent: (fn) => { if (isE()) return el().onUpdaterEvent(fn); return () => {} },
  // Fill In Genres: starts (or joins) the background lookup; genresStatus reads its progress.
  fetchMissingGenres: () => isE() ? el().fetchMissingGenres() : apiFetch('/tracks/fetch-missing-genres', { method: 'POST' }),
  genresStatus: () => isE() ? el().genresStatus() : apiFetch('/tracks/genres-status'),
  setManualGenre: (data) => isE() ? el().setManualGenre(data) : apiFetch('/tracks/set-manual-genre', { method: 'POST', body: data }),
  
  updateTrack: (id, data) => isE() ? el().updateTrack(id, data) : apiFetch(`/tracks/${id}`, { method: 'PUT', body: data }),
  batchUpdateTracks: (trackIds, operations) => isE() ? el().batchUpdateTracks(trackIds, operations) : apiFetch('/tracks/batch-update', { method: 'POST', body: { trackIds, operations } }),
  updateTrackArtwork: (id, imageData) => isE() ? el().updateTrackArtwork(id, imageData) : apiFetch(`/tracks/${id}/artwork`, { method: 'PUT', body: { imageData } }),
  fetchExternalArtwork: (id, title, artist) => isE() ? el().fetchExternalArtwork(id, title, artist) : apiFetch(`/tracks/${id}/fetch-external-artwork`, { method: 'POST', body: { title, artist } }),
}
