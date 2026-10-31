// Online results (YouTube Music, SoundCloud) for the desktop app: search,
// keeping songs as ghost tracks, and the lokal-stream://<provider>/<id>
// protocol the player streams from. See electron/online/sources.js.

const crypto = require('node:crypto')
const { BrowserWindow } = require('electron')
const log = require('electron-log')
const { getDB } = require('./db')
const { findYtDlp } = require('./tools')
const { cookieArgs } = require('./ytCookies')
const { runJsonSearch, mapSearchResult } = require('../download/search')
const sources = require('../online/sources')
const { selectedHttpSpatial } = require('../online/httpSpatial')
const genres = require('../online/genres')
const youtube = require('../online/youtube')
const { youtubePlaylistAccountId } = require('../online/youtubePlaylistIdentity')
const { createArtworkResolver } = require('../discoveryArtwork')
const { spelling } = require('../online/spelling')
const { netFetch } = require('../online/netFetch')
const discoveryArtwork = createArtworkResolver({ getDB, isElectron: true, searchArtists: require('./artistMetadata').searchArtistMetadataCandidates, searchSongs: youtube.searchSongs })
let accountSession

const SCHEME = 'lokal-stream'

// Log enough to diagnose addon playback without exposing source URLs, signed
// query parameters or provider track IDs. The short hash still correlates
// resolution, HTTP response and renderer decoder errors for a single track.
function streamDiagnostic(provider, id) {
  const key = sources.addons.keyOfProvider(provider)
  if (!key) return null
  let addonName = key
  try { addonName = sources.addons.list(getDB()).find(addon => addon.key === key)?.name || key } catch {}
  return {
    provider,
    addon: addonName,
    track: crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12),
  }
}

function safeStreamError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try {
        const url = new URL(value)
        return `${url.protocol}//${url.host}/[redacted]`
      } catch { return '[URL redacted]' }
    })
    .slice(0, 400)
}

function logAddonStream(diagnostic, event, details = {}, level = 'info') {
  if (!diagnostic) return
  const message = `[online-stream] ${JSON.stringify({ ...diagnostic, event, ...details })}`
  if (level === 'warn') log.warn(message)
  else log.info(message)
}

/** All settings as { key: value }. */
function settings() {
  try { return Object.fromEntries(getDB().prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])) } catch { return {} }
}

/** Credentials for YouTube Music Innertube requests (including the signed-in desktop session when enabled). */
async function getYouTubeMusicCredentials() {
  try { return accountSession ? await accountSession.credentials() : { cookies: '', fetchImpl: fetch } }
  catch { return { cookies: '', fetchImpl: fetch } }
}

/** yt-dlp and the user's YouTube cookie options, for resolving streams. */
function streamOptions() {
  const all = settings()
  // Only YouTube streams go through yt-dlp with cookies.
  const cookies = cookieArgs(all, { url: 'https://music.youtube.com/' })
  return {
    db: getDB(), quality: all.online_quality === 'saver' ? 'saver' : 'best',
    // Settings -> Playback -> Music Video Quality.
    videoHeight: [1080, 720, 480].includes(Number(all.video_quality)) ? Number(all.video_quality) : 1080,
    ytdlp: findYtDlp(), cookieArgs: cookies.args, cookieBrowser: cookies.usedBrowser,
    // Settings -> Playback -> Fast YouTube Playback (on unless turned off).
    fast: all.yt_fast_engine === '0' ? null : require('../online/youtubeFast'),
  }
}

/** Plain YouTube search through yt-dlp, for when YouTube Music can't be reached. */
async function youtubeFallback(query) {
  const ytdlp = findYtDlp()
  if (!ytdlp) throw new Error('YouTube Music could not be reached, and yt-dlp is not installed.')
  const found = await runJsonSearch(ytdlp, String(query || ''), mapSearchResult, 1, 10)
  return (found.results || []).map(r => ({
    videoId: r.id, title: r.title, artist: r.channel, artists: [r.channel], album: null,
    duration: r.duration || null, thumbnail: r.thumbnail, kind: r.topic ? 'song' : 'video', official: !!r.official, url: r.url,
  }))
}

/** Songs for `query` on a provider ('yt' YouTube Music, 'sc' SoundCloud). */
async function search(query, provider = 'yt', options = {}) {
  try {
    const auth = provider === 'yt' && accountSession ? await accountSession.credentials() : {}
    // Only automatic HTTP add-on fallback gets the short connection deadline.
    // A Morneye package may be staging a real file and must not inherit it.
    const isHttpAddon = sources.addons.keyOfProvider(provider) &&
      sources.addons.searchable(getDB()).some(addon =>
        addon.provider === provider && addon.kind !== 'mornye')
    const addonTimeoutMs = options?.automatic === true && isHttpAddon ? 3000 : undefined
    return await sources.search(sources.providerOf(provider) ? provider : 'yt', query, {
      db: getDB(), ytdlp: findYtDlp(), fetchImpl: auth.fetchImpl,
      fallbackSearch: youtubeFallback, addonTimeoutMs,
    })
  } catch (e) {
    return { error: e.message, results: [] }
  }
}

/** Built-in sources, then the user's enabled addons that can search and stream. */
function providers() {
  return [
    { id: 'yt', label: 'YouTube Music' },
    { id: 'sc', label: 'SoundCloud' },
    { id: 'mono', label: 'Monochrome' },
    ...sources.addons.searchable(getDB()).map(a => {
      const selected = a.kind === 'mornye' && a.qualityOptions?.find(q => q.id === a.settings?.downloadQuality)
      const spatial = !!selected && (
        selected.kind === 'spatial' || /^(?:DOLBY[_ -]?ATMOS|ATMOS|AC-?4)$/i.test(String(selected.id))
      )
      const httpSpatial = a.kind === 'mornye' ? null :
        selectedHttpSpatial({ manifest: { settings: a.settingsSchema }, settings: a.settings })
      return {
        id: a.provider, label: a.name, icon: a.icon, addon: true,
        package: a.kind === 'mornye',
        needsSetup: a.kind === 'mornye' && (!a.access || !a.access.ready),
        filters: a.searchFilters,
        album: a.resources.includes('album'), artist: a.resources.includes('artist'),
        // Only the choice/transport hint reaches the renderer. No credentials,
        // tokens or unredacted settings are exposed.
        playbackQuality: selected?.id || null,
        nativeSpatialPreferred: !!httpSpatial ||
          (spatial && /^(?:DOLBY[_ -]?ATMOS|ATMOS|AC-?4)$/i.test(String(selected.id))),
        nativeSpatialCodec: httpSpatial?.codec ||
          (/^amazon(?:-(?:new|web))?$/i.test(a.id || '') ? 'ac4' : 'eac3-joc'),
      }
    }),
  ]
}

/** IPC: online:search, online:save (keep as ghost tracks), online:prepare (resolve a stream ahead of time, or get why it fails). */
function registerOnlineHandlers(ipcMain) {
  // The fast YouTube engine sets itself up a few seconds after launch, so the
  // first song doesn't wait for it.
  setTimeout(() => { try { if (streamOptions().fast) require('../online/youtubeFast').warm() } catch {} }, 5000).unref?.()
  accountSession ||= require('../online/youtubeSession').createYouTubeSession({ getSettings: settings, saveSettings: values => {
    const stmt = getDB().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    getDB().transaction(() => { for (const [key, value] of Object.entries(values)) stmt.run(key, String(value)) })()
  } })
  // The fast engine asks as the account for a video YouTube won't give signed out.
  require('../online/youtubeFast').setAccount(async () => {
    const credentials = await accountSession.credentials()
    return credentials?.cookies ? credentials : null
  })
  const accountRequest = async work => { const auth = await accountSession.credentials(); return work(auth) }
  sources.pruneOnlineTracks(getDB())
  // Streamed songs' genres (see genres.js): those already played, once the app has settled.
  setTimeout(() => genres.backfillOnlineGenres(getDB()), 20000).unref?.()
  ipcMain.handle('online:search', (_, query, provider, options) => search(query, provider, options))
  ipcMain.handle('online:globalSearch', (_, query, options) => {
    const saved = settings()
    const source = saved.global_catalogue_source === 'spotify' ? 'spotify' : 'apple'
    return require('../online/globalCatalogue').preferredGlobalSearch(query, {
      ...options, source, rawCookie: saved.spotify_sp_dc || '',
    })
  })
  ipcMain.handle('online:save', (_, items) => {
    try {
      const rows = sources.saveOnlineTracks(getDB(), items)
      genres.fillOnlineGenres(getDB(), rows)
      return rows
    } catch (e) { return { error: e.message } }
  })
  ipcMain.handle('online:genre', (_, trackId) => genres.trackGenre(getDB(), trackId).catch(() => null))
  // The sources the search page can switch between: built-in ones, then addons.
  ipcMain.handle('online:providers', () => providers())
  // A misspelt search ("micheal jackson"): the library's spelling, else YouTube Music's.
  ipcMain.handle('online:spelling', (_, query) => spelling(getDB(), query))
  ipcMain.handle('online:artwork', (_, items) => discoveryArtwork(items))
  ipcMain.handle('online:signIn', (event, options) => accountSession.signIn({ mode: options?.mode || 'embedded', onProgress: status => { if (!event.sender.isDestroyed()) event.sender.send('online:signInStatus', status) } }))
  ipcMain.handle('online:cancelSignIn', () => accountSession.cancelSignIn())
  ipcMain.handle('online:disconnect', () => accountSession.disconnect())
  ipcMain.handle('online:catalogue', (_, options) => {
    const viaYouTube = () => accountRequest(({ cookies, fetchImpl }) => youtube.fetchCatalogue(options, cookies, fetchImpl))
    // Releases carry their exact date when Deezer has the artist.
    return (options?.type === 'releases' ? require('../online/releaseDates').releaseCatalogue(options, viaYouTube) : viaYouTube()).catch(e => ({ error: e.message }))
  })
  ipcMain.handle('online:account', (_, force = false) => accountRequest(auth => youtube.fetchAccountData({ ...auth, force: !!force })).catch(e => ({ error: e.message, authenticated: false })))
  ipcMain.handle('online:accountPlaylist', (_, playlistId) => accountRequest(({ cookies, fetchImpl }) => youtube.fetchAccountPlaylist(playlistId, cookies, fetchImpl)).catch(e => ({ error: e.message })))
  const { createSpotifyPlaylistCache } = require('./spotifyPlaylistCache')
  const youtubePlaylistDisk = createSpotifyPlaylistCache(require('path').join(
    require('electron').app.getPath('userData'), 'youtube-playlists-v1.json'))
  const youtubePlaylistPending = new Map()
  const youtubeLibraryResource = async (key, force, loader, empty) => {
    try {
      return await accountRequest(async ({ cookies, fetchImpl }) => {
        // The session's Cookie header changes on normal Music API requests.
        // Cache ownership and the mid-request account check must instead use
        // the persistent sign-in generation and selected account/channel.
        if (!youtube.accountHeaders(cookies || ''))
          return { ...empty, accountId: '', error: 'Sign in to YouTube Music in Integrations.' }
        const accountId = youtubePlaylistAccountId({ cookies }, settings())
        const hit = youtubePlaylistDisk.read(accountId, key)
        const autoUpdate = settings().youtube_playlist_auto_update === '1'
        if (hit && !force) return { ...hit.value, accountId, lastUpdated: hit.at, autoUpdate, refreshDue: youtubePlaylistDisk.due(accountId, key, autoUpdate) }
        const requestKey = `${accountId}:${key}`
        if (youtubePlaylistPending.has(requestKey)) return youtubePlaylistPending.get(requestKey)
        const sameAccount = async () => {
          const current = await accountSession.credentials()
          return !!youtube.accountHeaders(current.cookies || '') &&
            youtubePlaylistAccountId(current, settings()) === accountId
        }
        const task = (async () => {
          try {
            const value = await loader({ cookies, fetchImpl })
            if (value?.error) throw new Error(value.error)
            if (!await sameAccount())
              return { ...empty, accountId: '', error: 'YouTube Music account changed.' }
            youtubePlaylistDisk.save(accountId, key, value)
            return { ...value, accountId, lastUpdated: Date.now(), autoUpdate, refreshDue: false }
          } catch (error) {
            if (!await sameAccount())
              return { ...empty, accountId: '', error: 'YouTube Music account changed.' }
            youtubePlaylistDisk.failed(accountId, key)
            return hit
              ? { ...hit.value, accountId, lastUpdated: hit.at, autoUpdate, error: error.message, refreshDue: false }
              : { ...empty, accountId, error: error.message }
          }
        })().finally(() => youtubePlaylistPending.delete(requestKey))
        youtubePlaylistPending.set(requestKey, task)
        return task
      })
    } catch (error) { return { ...empty, accountId: '', error: error.message } }
  }
  ipcMain.handle('online:libraryPlaylists', (_, force) => youtubeLibraryResource(
    'libraryPlaylists', !!force,
    auth => youtube.fetchLibraryPlaylists(auth).then(playlists => ({ playlists })),
    { playlists: [] },
  ))
  ipcMain.handle('online:libraryPlaylistTracks', (_, id, force) => {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(String(id || '')) || String(id).startsWith('RD'))
      return { tracks: [], error: 'Invalid YouTube Music playlist id.' }
    return youtubeLibraryResource(
      `libraryPlaylist:${id}`, !!force,
      ({ cookies, fetchImpl }) => youtube.fetchMusicPlaylist(id, cookies, fetchImpl, { limit: 1000, timeoutMs: 60000 }),
      { tracks: [] },
    )
  })

  ipcMain.handle('online:radio', (_, videoId) => accountRequest(auth => youtube.fetchRadio(videoId, auth)).catch(() => []))
  ipcMain.handle('online:setAccountLiked', (_, videoId, liked) => accountRequest(({ cookies, fetchImpl }) => youtube.setAccountLiked(videoId, liked, cookies, fetchImpl)).catch(e => ({ error: e.message })))
  // Direct audio link of an addon track, for "Save to library" (the downloader fetches it).
  ipcMain.handle('online:downloadUrl', async (_, provider, id) => {
    const key = sources.addons.keyOfProvider(provider)
    if (key && sources.addons.packageService(getDB()).find(key)) return { package: true, url: `mornye://${key}/${encodeURIComponent(id)}` }
    try { return { url: (await sources.resolveStream(provider, id, { ...streamOptions(), force: true })).url } } catch (e) { return { error: e.message } }
  })
  // Addons' manifests are read again now and then (new resources, settings).
  sources.addons.refreshManifests(getDB()).catch(() => {})
  ipcMain.handle('addons:list', () => { sources.addons.refreshManifests(getDB()).catch(() => {}); return sources.addons.list(getDB()) })
  // An addon's album and artist pages (when its manifest offers them).
  ipcMain.handle('online:addonAlbum', async (_, provider, id) => {
    const key = sources.addons.keyOfProvider(provider)
    if (!key) return { error: 'Not an addon.' }
    try { return await sources.addons.album(getDB(), key, id) } catch (e) { return { error: e.message } }
  })
  ipcMain.handle('online:addonArtist', async (_, provider, id) => {
    const key = sources.addons.keyOfProvider(provider)
    if (!key) return { error: 'Not an addon.' }
    try { return await sources.addons.artist(getDB(), key, id) } catch (e) { return { error: e.message } }
  })
  ipcMain.handle('addons:install', async (_, url) => {
    try { return await sources.addons.install(getDB(), url) } catch (e) { return { error: e.message } }
  })
  const addonRequest = async work => { try { return await work() } catch (e) { return { error: e.message } } }
  ipcMain.handle('addons:remove', (_, key) => addonRequest(() => sources.addons.remove(getDB(), key)))
  ipcMain.handle('addons:setEnabled', (_, key, enabled) => addonRequest(() => sources.addons.setEnabled(getDB(), key, enabled)))
  ipcMain.handle('addons:setSettings', (_, key, values) => addonRequest(() => sources.addons.setSettings(getDB(), key, values)))
  ipcMain.handle('addons:packages', (event, request) => {
    if (event.senderFrame !== event.sender.mainFrame) return { error: 'Addon management requires the main application frame' }
    return addonRequest(() => require('../mornye/api').dispatch(getDB(), request))
  })
  const musicVideoProgress = (event, trackId) => update => {
    try { if (!event.sender.isDestroyed()) event.sender.send('musicVideo:progress', { trackId, ...update }) } catch {}
  }
  ipcMain.handle('musicVideo:find', (event, trackId) => musicVideoFor(trackId, {
    onProgress: musicVideoProgress(event, trackId),
  }).catch(() => null))
  ipcMain.handle('musicVideo:download', (_, trackId) => prepareMusicVideoFor(trackId, { download: true }).catch(e => ({ error: e.message })))
  ipcMain.handle('musicVideo:prepare', (_, trackId) => prepareMusicVideoFor(trackId).catch(e => ({ error: e.message })))
  // Where a video that isn't downloaded is streamed from (see videoStreamBase).
  ipcMain.handle('musicVideo:streamBase', () => videoStreamBase().catch(() => null))
  ipcMain.handle('clipVideo:resolve', (_, link, options) => require('../online/clipVideo').resolveClipVideo(link, {
    fallback: options?.fallback === true,
    ytdlp: findYtDlp(),
    settings: settings(),
    streamBase: videoStreamBase,
  }).catch(error => ({ error: error?.message || String(error) })))
  ipcMain.handle('musicVideo:deleteDownload', async (_, trackId) => {
    try {
      const video = await musicVideoFor(trackId)
      if (!video) throw new Error('No music video found for this song')
      const manager = require('./downloader').manager()
      for (const job of [...manager.jobs.values()]) {
        if (job.kind !== 'music-video' || job.opts.videoId !== video.videoId) continue
        if (['downloading', 'queued'].includes(job.status)) { await manager.cancel(job.id); await manager.waitFor(job.id) }
      }
      const storage = require('../online/musicVideoDownloads')
      const files = [...manager.jobs.values()].filter(job => job.kind === 'music-video' && job.opts.videoId === video.videoId).flatMap(job => [job.song, ...(job.filepaths || [])]).filter(Boolean)
      const local = musicVideoFile(video, { artist: trackArtist(trackId) })
      if (local) files.push(local)
      for (const height of [1080, 720, 480]) {
        const file = storage.peekCachedVideoFile(video.videoId, { cacheDir: require('../cache').cacheDir('musicVideo'), videoHeight: height, touch: false })
        if (file) files.push(file)
      }
      storage.deleteVideoFiles(getDB(), video.videoId, { files })
      for (const job of manager.jobs.values()) {
        if (job.kind === 'music-video' && job.opts.videoId === video.videoId) manager.update(job, { song: null, filepaths: [], removed: true, message: 'Downloaded video deleted' }, { persist: true, force: true })
      }
      return { success: true }
    } catch (error) { return { error: error.message } }
  })
  ipcMain.handle('musicVideo:list', () => listMusicVideos())
  ipcMain.handle('musicVideo:save', async (_, trackId, saved = true) => {
    try {
      const video = await musicVideoFor(trackId)
      if (!video) throw new Error('No music video found for this song')
      ensureVideoLibrary()
      saveMusicVideoOncePerVideo(trackId, video, !!saved)
      return { saved: !!saved }
    } catch (e) { return { error: e.message } }
  })
  // Settings -> Library -> Maintenance: find every library song's music video
  // now, so they open at once later. One song at a time; cancellable.
  let videoIndexJob = null
  // The latest progress, for a window that wasn't listening when it was sent
  // (the Downloads panel after a reload).
  let videoIndexStatus = null
  ipcMain.handle('musicVideo:indexAll', async () => {
    if (videoIndexJob) return { running: true }
    const job = { cancelled: false }
    videoIndexJob = job
    // Every window, so one opened after the job started (the original closed
    // and the app reopened its window) keeps following it.
    const send = (payload) => {
      videoIndexStatus = payload
      for (const win of require('electron').BrowserWindow.getAllWindows()) {
        try { if (!win.webContents.isDestroyed()) win.webContents.send('musicVideo:indexProgress', payload) } catch {}
      }
    }
    try {
      const rows = getDB().prepare("SELECT id, title, artist, duration FROM tracks WHERE title IS NOT NULL AND artist IS NOT NULL AND duration > 30 AND file_path NOT LIKE 'ghost://%' ORDER BY artist, title").all()
      let done = 0
      let found = 0
      for (const row of rows) {
        if (job.cancelled) break
        send({ running: true, done, total: rows.length, found, title: `${row.artist} — ${row.title}` })
        const video = await prepareMusicVideoFor(row.id, { wait: true }).catch(() => null)
        if (video) found++
        done++
      }
      send({ running: false, done, total: rows.length, found, cancelled: job.cancelled })
      return { done, total: rows.length, found, cancelled: job.cancelled }
    } finally { videoIndexJob = null }
  })
  // Videos page: a card's animated preview when the video isn't downloaded.
  ipcMain.handle('musicVideo:animatedPreview', (_, videoId, query, force) =>
    require('../online/videoPreview').animatedPreview(String(videoId || ''), String(query || ''), { force: force === true }).catch(() => null))
  ipcMain.handle('musicVideo:cancelIndex', () => { if (videoIndexJob) videoIndexJob.cancelled = true })
  ipcMain.handle('musicVideo:indexStatus', () => videoIndexStatus)
  ipcMain.handle('online:prepare', async (_, provider, id, force = false, options = {}) => {
    try {
      const key = sources.addons.keyOfProvider(provider)
      if (key && sources.addons.packageService(getDB()).find(key)) return require('../mornye/media').prepare(getDB(), key, id, { force: !!force })
      if (provider === 'yt') await accountSession.credentials()
      // Bound the actual HTTP request, not only the renderer's Promise.race.
      const addonTimeoutMs = key && options?.automatic === true ? 3000 : undefined
      const stream = await sources.resolveStream(provider, id, { ...streamOptions(), force: !!force, addonTimeoutMs })
      return { ok: true, preview: !!stream.preview }
    } catch (e) { return { error: e.message } }
  })
}

/** Where ffmpeg reads a YouTube video's audio from; a retry gets a fresh URL in another format. */
async function youtubeAudio(videoId, attempt = 0) {
  const stream = await youtube.resolveStream(videoId, { ...streamOptions(), quality: attempt ? 'saver' : 'analysis', force: attempt > 0 })
  return { input: stream.url, headers: stream.headers }
}

/** Where ffmpeg reads a track's own audio from, for the music video check. */
function resolvedSourceAudio(provider, id, { resolve = sources.resolveStream, options = streamOptions() } = {}) {
  return async attempt => {
    const stream = await resolve(provider, id, { ...options, force: attempt > 0 })
    return { input: stream.file || stream.url, headers: stream.headers }
  }
}

function songAudioFor(track, canStream, options = {}) {
  const file = String(track?.file_path || '')
  const ref = sources.streamRef(track)
  if (ref && (ref.provider !== 'yt' || canStream)) {
    if (ref.provider === 'yt') return attempt => youtubeAudio(ref.id, attempt)
    // SoundCloud and addon streams are resolved by the shared source layer so
    // the music-video matcher receives the same fresh URL as playback.
    return resolvedSourceAudio(ref.provider, ref.id, options)
  }
  if (file && !file.startsWith('ghost://') && require('fs').existsSync(file)) return async () => ({ input: file, headers: {} })
  return null
}

/** The official music video for a track (see online/musicVideo.js), or null. */
async function musicVideoFor(trackId, { onProgress } = {}) {
  const track = getDB().prepare('SELECT id, title, artist, duration, file_path FROM tracks WHERE id = ?').get(trackId)
  if (!track) return null
  const cacheFile = musicVideoMetadataFile()
  const matcher = require('../online/musicVideo')
  ensureVideoLibrary()
  const known = matcher.knownMusicVideos([track], { cacheFile, findFile: musicVideoFile })[0]?.video
  if (known) return known
  for (const row of getDB().prepare('SELECT video_json FROM downloaded_music_videos').all()) {
    try { const video = JSON.parse(row.video_json); if (video.trackId === trackId && (video.motion === 'verified' || musicVideoFile(video, track))) return video } catch {}
  }
  try {
    const saved = JSON.parse(getDB().prepare('SELECT video_json FROM saved_music_videos WHERE track_id = ?').get(trackId)?.video_json || 'null')
    if (/^[\w-]{11}$/.test(String(saved?.videoId || '')) && (saved.motion === 'verified' || musicVideoFile(saved, track))) return saved
  } catch {}
  if (accountSession) await accountSession.credentials().catch(() => {})
  const { findFfmpeg } = require('./tools')
  const options = streamOptions()
  // The fast engine plays YouTube without yt-dlp (and falls back to it when there).
  const canStream = !!options.ytdlp || !!options.fast
  const ytdlpSearch = query => runJsonSearch(options.ytdlp, query, entry => ({
    ...entry,
    id: entry.id,
    videoId: entry.id,
    artist: entry.channel || entry.uploader || '',
    artists: [entry.channel || entry.uploader || ''].filter(Boolean),
    kind: 'video',
    official: /(?:official\s+(?:music\s+)?video|VEVO$)/i.test(`${entry.title || ''} ${entry.channel || entry.uploader || ''}`),
    url: `https://www.youtube.com/watch?v=${entry.id}`,
  }), 1, 10, undefined, { timeoutMs: 15000 })
  // youtube.com's own search first (a request, under a second); yt-dlp's when
  // that fails or finds nothing (a page YouTube laid out differently).
  const fastSearch = async query => {
    let found
    try {
      found = (await require('../online/videoPreview').searchVideos(query)).slice(0, 10).map(entry => ({
        ...entry,
        videoId: entry.id,
        artist: entry.channel,
        artists: [entry.channel].filter(Boolean),
        kind: 'video',
        official: /(?:official\s+(?:music\s+)?video|VEVO$)/i.test(`${entry.title} ${entry.channel}`),
      }))
    } catch (error) {
      require('electron-log').info(`YouTube fast engine (video): search through yt-dlp (${String(error?.message || error).slice(0, 200)})`)
      if (!options.ytdlp) throw error
      return ytdlpSearch(query)
    }
    if (found.length || !options.ytdlp) return found
    require('electron-log').info('YouTube fast engine (video): search through yt-dlp (youtube.com found nothing)')
    return ytdlpSearch(query)
  }
  const video = await matcher.findMusicVideo(track, {
    ffmpeg: findFfmpeg(),
    onProgress,
    songAudio: songAudioFor(track, canStream),
    videoAudio: canStream ? youtubeAudio : null,
    visualMotion: item => matcher.validateVisualMotion(findFfmpeg(), async () => {
      const storage = require('../online/musicVideoDownloads')
      const file = storage.recordedVideoFile(getDB(), item.videoId, options.videoHeight) || storage.peekCachedVideoFile(item.videoId, { cacheDir: require('../cache').cacheDir('musicVideo'), videoHeight: options.videoHeight, touch: false })
      if (file) return { input: file, headers: {} }
      if (!canStream) return null
      const media = await youtube.resolveStream(item.videoId, { ...options, quality: 'video' })
      return { input: media.url, headers: media.headers }
    }, item.duration || track.duration),
    youtubeSearch: options.fast ? fastSearch : options.ytdlp ? ytdlpSearch : null,
    cacheFile,
    log: message => require('electron-log').info(message),
  })
  return video
}

function musicVideoMetadataFile() {
  return require('path').join(require('electron').app.getPath('userData'), 'music-videos.json')
}

function ensureVideoLibrary() {
  getDB().exec('CREATE TABLE IF NOT EXISTS saved_music_videos (track_id TEXT PRIMARY KEY, added_at INTEGER NOT NULL, video_json TEXT NOT NULL)')
  require('../online/musicVideoDownloads').ensureDownloadsTable(getDB())
}

function musicVideoFile(video, track = {}) {
  const storage = require('../online/musicVideoDownloads')
  const height = storage.heightOf(settings().video_quality)
  const recorded = storage.recordedVideoFile(getDB(), video.videoId, height)
  if (recorded) return recorded
  for (const videoHeight of new Set([height, 1080, 720, 480])) {
    for (const artist of new Set([track.artist, video.artist].filter(Boolean))) {
      const file = storage.peekDurableVideoFile(video.videoId, { artist, videoHeight })
      if (file) return file
    }
    const legacy = storage.peekCachedVideoFile(video.videoId, { cacheDir: require('../cache').cacheDir('musicVideo'), videoHeight, touch: false })
    if (legacy) return legacy
  }
  return null
}

function pruneDuplicateSavedMusicVideos() {
  const db = getDB()
  // Keep a live library row in preference to an orphan left by a deleted track.
  const rows = db.prepare("SELECT s.track_id, s.added_at, s.video_json FROM saved_music_videos s LEFT JOIN tracks t ON t.id = s.track_id ORDER BY CASE WHEN t.id IS NULL THEN 1 ELSE 0 END, s.added_at ASC, s.track_id ASC").all()
  const seen = new Set()
  const remove = []
  for (const row of rows) {
    try {
      const videoId = String(JSON.parse(row.video_json)?.videoId || '')
      if (!/^[\w-]{11}$/.test(videoId)) continue
      if (seen.has(videoId)) remove.push(row.track_id)
      else seen.add(videoId)
    } catch {}
  }
  if (remove.length) {
    const del = db.prepare('DELETE FROM saved_music_videos WHERE track_id = ?')
    db.transaction(() => { for (const trackId of remove) del.run(trackId) })()
  }
}

function saveMusicVideoOncePerVideo(trackId, video, saved) {
  const db = getDB()
  const rows = db.prepare('SELECT track_id, video_json FROM saved_music_videos').all()
  const write = db.transaction(() => {
    // A YouTube ID denotes one video, regardless of how many local track
    // copies led to it. Saving/unsaving the card updates that video once.
    for (const row of rows) {
      try {
        if (JSON.parse(row.video_json)?.videoId === video.videoId) {
          db.prepare('DELETE FROM saved_music_videos WHERE track_id = ?').run(row.track_id)
        }
      } catch {}
    }
    if (saved) {
      db.prepare('INSERT OR REPLACE INTO saved_music_videos (track_id, added_at, video_json) VALUES (?, ?, ?)').run(trackId, Date.now(), JSON.stringify(video))
    }
  })
  write()
}

function listMusicVideos() {
  ensureVideoLibrary()
  pruneDuplicateSavedMusicVideos()
  const tracks = getDB().prepare('SELECT * FROM tracks ORDER BY artist, title').all()
  const saved = new Map(getDB().prepare('SELECT track_id, video_json FROM saved_music_videos').all().map(row => [row.track_id, row.video_json]))
  const known = new Map(require('../online/musicVideo').knownMusicVideos(tracks, { cacheFile: musicVideoMetadataFile(), findFile: musicVideoFile }).map(item => [item.track.id, item]))
  for (const row of getDB().prepare('SELECT video_json FROM downloaded_music_videos').all()) {
    try {
      const video = JSON.parse(row.video_json)
      const track = tracks.find(track => track.id === video.trackId)
      if (track && !known.has(track.id)) known.set(track.id, { track, video })
    } catch {}
  }
  // Saved videos keep their metadata even when discovery expires or the file
  // is evicted. Disk-cache membership isn't library membership.
  for (const track of tracks) {
    if (known.has(track.id) || !saved.has(track.id)) continue
    try {
      const video = JSON.parse(saved.get(track.id))
      if (/^[\w-]{11}$/.test(String(video?.videoId || ''))) known.set(track.id, { track, video })
    } catch {}
  }
  const matcher = require('../online/musicVideo')
  const items = [...known.values()]
    .sort((a, b) => String(a.track.artist || '').localeCompare(String(b.track.artist || '')) || String(a.track.title || '').localeCompare(String(b.track.title || '')))
    .map(({ track, video }) => {
      const file = musicVideoFile(video, track)
      return {
        track, video: { ...video, file, thumbnail: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg` },
        saved: saved.has(track.id), downloaded: !!file,
      }
    })
  return matcher.dedupeMusicVideoItems(items)
}

async function prepareMusicVideoFor(trackId, { wait = false, download = false } = {}) {
  const video = await musicVideoFor(trackId)
  if (!video) return null
  const { peekDurableVideoFile, recordedVideoFile, heightOf } = require('../online/musicVideoDownloads')
  const options = { videoHeight: heightOf(settings().video_quality), artist: trackArtist(trackId) || video.artist, title: video.title, trackId }
  const file = musicVideoFile(video, { artist: options.artist })
  const durable = recordedVideoFile(getDB(), video.videoId, options.videoHeight) || peekDurableVideoFile(video.videoId, options)
  if (durable || (file && !download)) return { ...video, file: durable || file }
  if (!download) {
    const manager = require('./downloader').manager()
    const active = [...manager.jobs.values()].find(job => job.kind === 'music-video' && job.opts.videoId === video.videoId && ['queued', 'downloading'].includes(job.status))
    return { ...video, file: null, ...(active ? { downloadId: active.id } : { needsDownload: true }) }
  }
  const { queueMusicVideo, waitForDownload } = require('./downloader')
  const queued = queueMusicVideo(video, options)
  if (queued.error) throw new Error(queued.error)
  if (!wait) return { ...video, downloadId: queued.downloadId }
  const job = await waitForDownload(queued.downloadId)
  const downloaded = peekDurableVideoFile(video.videoId, options)
  if (!downloaded || job?.status !== 'done') throw new Error(job?.error || 'Could not download the music video')
  return { ...video, file: downloaded }
}

function trackArtist(trackId) {
  try { return getDB().prepare('SELECT artist FROM tracks WHERE id = ?').get(trackId)?.artist } catch { return null }
}

/** Must run before the app is ready: lets <audio> stream (and seek) from lokal-stream://. */
function registerStreamScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } }])
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges']
const VIDEO_CHUNK = 1024 * 1024 // a piece: what YouTube's own player asks for at a time
const VIDEO_CACHE_PIECES = 64 // pieces kept in memory (64 MB), shared by every stream of a video
const VIDEO_CHUNK_TIMEOUT_MS = 30000

// Why a video's stream last failed (shown to the player, which only sees a read error).
const videoErrors = new Map() // videoId -> message
function videoLog(id, message) {
  try { require('electron-log').info(`Music video stream: ${id}: ${message}`) } catch {}
}
function videoFailed(id, message) {
  if (videoErrors.size > 50) videoErrors.delete(videoErrors.keys().next().value)
  videoErrors.set(id, message)
  try { require('electron-log').info(`Music video stream: ${id}: ${message}`) } catch {}
}

/** At most `want` bytes of a response, then the connection let go. */
async function readUpTo(res, want) {
  const reader = res.body.getReader()
  const parts = []
  let size = 0
  while (size < want) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.length
  }
  if (size >= want) reader.cancel().catch(() => {})
  return Buffer.concat(parts.map(part => Buffer.from(part))).subarray(0, want)
}

/**
 * One piece of a music video, read whole: { body, from, to, total, mime, engine }.
 * YouTube is asked for the range as such, then (refused) open-ended, reading
 * only what's needed; still refused, with a fresh link the same two ways.
 * The error says what each try got.
 */
// The size of the file each video is being played from: every piece must
// come from that same file (a fresh link to another format, yt-dlp's after
// the fast engine's, would hand the player two files: "data source error").
const videoFiles = new Map() // videoId -> total bytes
// A video at one quality is one file: `${videoId}@${height}`.
const videoFileKey = (id, height) => `${id}@${height}`

function videoFile(file, total) {
  const before = videoFiles.get(file)
  if (before === total) return
  // Another file for the video: the pieces kept from the old one are no use.
  if (before) for (const key of [...videoPieces.keys()]) if (key.startsWith(`${file}:`)) videoPieces.delete(key)
  if (videoFiles.size > 50 && !videoFiles.has(file)) videoFiles.delete(videoFiles.keys().next().value)
  videoFiles.set(file, total)
}

// Pieces fetched, aligned to VIDEO_CHUNK and kept (least recently used out):
// the player jumps back and forth while it opens a video (its index, the
// frame at the song's time, back) and each jump is a new request; served
// from here, a jump to somewhere already fetched answers at once, and two
// streams wanting the same piece fetch it once. Keyed by video and quality
// (another quality is another file). A piece still being fetched counts the
// streams waiting for it; when none does any more (they were dropped: a
// seek, the video closed), its fetch is stopped rather than left running.
const videoPieces = new Map() // `${file}:${index}` -> { job, waiters, stop, done }

function videoPiece(id, height, index, fetchImpl) {
  const key = `${videoFileKey(id, height)}:${index}`
  const kept = videoPieces.get(key)
  if (kept) { videoPieces.delete(key); videoPieces.set(key, kept); return { key, entry: kept } }
  const from = index * VIDEO_CHUNK
  const to = from + VIDEO_CHUNK - 1
  const stop = new AbortController()
  const entry = { waiters: 0, stop, done: false }
  entry.job = videoChunk(id, from, to, fetchImpl, false, stop.signal, height).catch(error => {
    if (stop.signal.aborted) throw error
    try { require('electron-log').info(`Music video stream: ${id}: ${error.message}; trying a fresh link`) } catch {}
    return videoChunk(id, from, to, fetchImpl, true, stop.signal, height)
  })
  entry.job.then(() => { entry.done = true }, () => { if (videoPieces.get(key) === entry) videoPieces.delete(key) })
  videoPieces.set(key, entry)
  while (videoPieces.size > VIDEO_CACHE_PIECES) videoPieces.delete(videoPieces.keys().next().value)
  return { key, entry }
}

/** The piece holding byte `at` of the video; `signal`: the stream asking was dropped. */
async function videoBytesAt(id, height, at, fetchImpl, signal = null) {
  const { key, entry } = videoPiece(id, height, Math.floor(at / VIDEO_CHUNK), fetchImpl)
  let piece
  if (entry.done) piece = await entry.job
  else {
    entry.waiters++
    let left = false
    const leave = () => {
      left = true
      entry.waiters--
      if (!entry.done && entry.waiters <= 0) {
        entry.stop.abort()
        if (videoPieces.get(key) === entry) videoPieces.delete(key)
      }
    }
    signal?.addEventListener('abort', leave, { once: true })
    try { piece = await entry.job } finally {
      signal?.removeEventListener('abort', leave)
      if (!left) entry.waiters--
    }
  }
  if (at >= piece.from && at <= piece.to) return piece
  // A short piece (YouTube sent less than asked): the rest of it, on its own.
  return videoChunk(id, at, Math.floor(at / VIDEO_CHUNK) * VIDEO_CHUNK + VIDEO_CHUNK - 1, fetchImpl, false, signal, height)
}

async function videoChunk(id, from, to, fetchImpl, force = false, stop = null, height = streamOptions().videoHeight) {
  const file = videoFileKey(id, height)
  const upstream = new AbortController()
  const timer = setTimeout(() => upstream.abort(), VIDEO_CHUNK_TIMEOUT_MS)
  const abort = () => upstream.abort()
  stop?.addEventListener('abort', abort, { once: true })
  const at = `${(from / 1048576).toFixed(1)} MB in`
  const tried = []
  try {
    // The link in hand, then a fresh one from the same engine (the same
    // format, so the same file); another engine's only before the video has
    // started (from 0), when changing file is still possible.
    const links = [...(force ? [] : [{}]), { force: true, keepFast: true }, ...(from === 0 ? [{ force: true }] : [])]
    let previous = null
    for (const link of links) {
      const stream = await youtube.resolveStream(id, { ...streamOptions(), videoHeight: height, quality: 'video', ...link })
      if (previous === stream.url) continue
      previous = stream.url
      const engine = stream.engine || 'yt-dlp'
      // Why this isn't the fast engine's link (said with what YouTube refused).
      const fastWhy = engine !== 'youtubei' && youtube.fastFailure(id, 'video')
      if (fastWhy && !tried.some(entry => entry.startsWith('fast engine:'))) tried.push(`fast engine: ${fastWhy}`)
      // Through Electron (as songs stream), open-ended if a range is refused,
      // then through Node (as downloads fetch).
      for (const { open, via } of [{ open: false, via: 'app' }, { open: true, via: 'app' }, { open: false, via: 'node' }]) {
        let res
        try {
          const get = via === 'node' ? (...args) => fetch(...args) : fetchImpl
          res = await get(stream.url, { headers: { ...stream.headers, Range: `bytes=${from}-${open ? '' : to}` }, signal: upstream.signal })
        } catch (error) {
          throw new Error(upstream.signal.aborted ? `YouTube took too long, ${at}` : `Couldn't reach YouTube ${at} (${error.message})`)
        }
        const span = String(res.headers.get('content-range') || '').match(/bytes (\d+)-(\d+)\/(\d+)/)
        const whole = res.status === 200 && from === 0 // a server that ignored the range
        if ((res.status === 206 && span) || whole) {
          let body
          try { body = await readUpTo(res, to - from + 1) } catch {
            throw new Error(upstream.signal.aborted ? `YouTube took too long, ${at} (${engine} link)` : `YouTube cut the video off ${at} (${engine} link)`)
          }
          if (!body.length) throw new Error(`YouTube sent nothing ${at} (${engine} link)`)
          const total = span ? Number(span[3]) : Number(res.headers.get('content-length')) || body.length
          const begin = span ? Number(span[1]) : 0
          const playing = videoFiles.get(file)
          if (from > 0 && playing && playing !== total) {
            tried.push(`another file (${total} bytes, not ${playing}), ${engine} link`)
            break
          }
          if (from === 0 || !playing) videoFile(file, total)
          if (tried.length || via === 'node') videoLog(id, `${at}: got it ${open ? 'open-ended' : 'as a range'}${via === 'node' ? ' through Node' : ''} (${engine} link) after: ${tried.join('; ') || 'nothing'}`)
          return { body, from: begin, to: begin + body.length - 1, total, mime: res.headers.get('content-type') || stream.mime, engine }
        }
        try { await res.body?.cancel?.() } catch {}
        tried.push(`HTTP ${res.status} ${open ? 'open range' : 'range'}${via === 'node' ? ' via Node' : ''}, ${engine} link`)
        if (![400, 403, 416].includes(res.status)) break
      }
    }
    throw new Error(`YouTube refused the video ${at} (${tried.join('; ')})`)
  } finally { clearTimeout(timer); stop?.removeEventListener('abort', abort) }
}

/**
 * A music video's picture (lokal-stream://ytv/<id>). The player sees one
 * ordinary stream of what it asked for; behind it, YouTube is asked for 1 MB
 * pieces (what its own player asks for: an open-ended range is refused or
 * slowed), the next one only as the player reads, kept a while for the next
 * request (videoPiece). Each piece is read whole, so a stream the player
 * drops or stops reading (the video closed, paused, a seek) never holds a
 * connection: those used to pile up on the video's server (Chromium allows
 * six per server) until it stopped loading.
 */
async function videoStream(id, range, fetchImpl) {
  const asked = String(range || '').match(/^bytes=(\d+)-(\d*)$/)
  const start = asked ? Number(asked[1]) : 0
  // One quality for the whole stream (a change in Settings applies from the next one).
  const height = streamOptions().videoHeight
  // Set when the player drops this stream: a piece it was waiting for stops
  // unless another stream wants it too.
  const dropped = new AbortController()
  let first
  try { first = await videoBytesAt(id, height, start, fetchImpl) } catch (error) { videoFailed(id, error.message); throw error }
  videoErrors.delete(id)
  const last = Math.min(asked && asked[2] ? Number(asked[2]) : Infinity, first.total - 1)
  videoLog(id, `asked ${range || 'the whole file'}; serving ${start}-${last} of ${first.total} bytes (${first.mime}, ${first.engine} link)`)
  let next = start
  let cancelled = false
  const send = (controller, piece) => {
    const part = piece.body.subarray(next - piece.from, Math.min(piece.to, last) - piece.from + 1)
    // A copy: the kept piece is served again to the next request for it,
    // and what's handed to the player may be taken over (transferred) or
    // read from its whole buffer rather than this slice of it.
    controller.enqueue(new Uint8Array(part))
    next += part.length
    if (next > last) controller.close()
  }
  const body = new ReadableStream({
    start(controller) { send(controller, first) },
    async pull(controller) {
      if (cancelled || next > last) return
      try {
        const piece = await videoBytesAt(id, height, next, fetchImpl, dropped.signal)
        if (!cancelled) send(controller, piece)
      } catch (error) {
        if (cancelled) return
        videoFailed(id, error.message)
        controller.error(error)
      }
    },
    cancel() {
      cancelled = true
      dropped.abort()
      // How far the player got before dropping it (0, or a piece's worth, says what it didn't take).
      videoLog(id, `stream from ${start} dropped after ${next - start} bytes`)
    },
  }, { highWaterMark: 0 })
  return new Response(body, {
    status: 206,
    headers: { 'content-type': first.mime, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${last}/${first.total}`, 'content-length': String(last - start + 1) },
  })
}

// Music videos over plain HTTP, from a server of their own on this machine
// only (127.0.0.1, a random port, a random token in every address). The
// player's loader trusts HTTP for jumping around a file: from the custom
// lokal-stream:// scheme it took the first piece of every stream after a
// jump and dropped it, asked for the same bytes again, and gave up ("data
// source error"). Same streams behind it (videoStream); lokal-stream://ytv/
// stays for when this server can't start.
let videoServer = null // Promise<base address, e.g. http://127.0.0.1:PORT/TOKEN>
const VIDEO_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range, x-lokal-why', 'access-control-expose-headers': 'content-range, content-length, accept-ranges' }

function videoStreamBase() {
  if (videoServer) return videoServer
  const token = require('crypto').randomBytes(16).toString('hex')
  const fetchImpl = (u, init) => require('electron').net.fetch(u, init)
  const server = require('http').createServer(async (req, res) => {
    const found = String(req.url || '').match(/^\/([0-9a-f]{32})\/ytv\/([\w-]{11})(?:\?.*)?$/)
    if (!found || found[1] !== token) { res.writeHead(404); res.end(); return }
    if (req.method === 'OPTIONS') { res.writeHead(204, VIDEO_CORS); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, VIDEO_CORS); res.end(); return }
    const id = found[2]
    const why = req.headers['x-lokal-why']
    if (why) {
      videoLog(id, `the player stopped: ${String(why).slice(0, 300)}${videoErrors.get(id) ? '' : ' (no request failed)'}`)
      res.writeHead(200, { ...VIDEO_CORS, 'content-type': 'text/plain' })
      res.end(videoErrors.get(id) || '')
      return
    }
    let reader = null
    res.on('close', () => { if (!res.writableEnded) reader?.cancel().catch(() => {}) })
    try {
      const answer = await videoStream(id, req.headers.range, fetchImpl)
      res.writeHead(answer.status, { ...VIDEO_CORS, ...Object.fromEntries(answer.headers) })
      if (req.method === 'HEAD' || res.destroyed) { answer.body?.cancel().catch(() => {}); res.end(); return }
      reader = answer.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done || res.destroyed) break
        // Waiting for the player to take more: whichever comes first, the
        // other listener goes (left behind, they piled up on a long video:
        // MaxListenersExceededWarning).
        if (!res.write(value)) {
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve() }
            res.once('drain', done)
            res.once('close', done)
          })
        }
      }
      res.end()
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { ...VIDEO_CORS, 'content-type': 'text/plain' })
      res.end(String(error?.message || error))
    }
  })
  videoServer = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/${token}`))
  })
  videoServer.catch(() => { videoServer = null })
  return videoServer
}

// Progress is scoped to a provider/id and one protocol request, so the
// renderer can discard prefetches, outdated failures and earlier sources.
let streamLoadRequest = 0
function emitStreamStartup(data) {
  for (const win of BrowserWindow?.getAllWindows?.() || []) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('online:streamStartup', data)
      }
    } catch {}
  }
}

/** lokal-stream://<provider>/<id>: a song's audio (YouTube, SoundCloud), with Range support for seeking; ytv: a music video's picture. */
function registerStreamProtocol(protocol, net) {
  protocol.handle(SCHEME, async (request) => {
    let provider = ''
    let id = ''
    let diagnostic = null
    let upstream = null
    const startedAt = Date.now()
    try {
      const url = new URL(request.url)
      provider = url.hostname
      id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      diagnostic = streamDiagnostic(provider, id)
    } catch {}
    try {
      if (provider === 'cover') {
        // Full-resolution artwork uses the database's trusted track path, never a caller-supplied filesystem path.
        const picture = await require('../artwork/fullCover').fullCoverForTrack(getDB(), id)
        return picture
          ? new Response(picture.bytes, { status: 200, headers: { 'content-type': picture.mime, 'cache-control': 'private, max-age=3600' } })
          : new Response('No full artwork', { status: 404 })
      }
      if (provider === 'yt' && accountSession) await accountSession.credentials()
      if (provider === 'ytv') {
        // The player asking why the video's stream failed.
        const why = request.headers.get('x-lokal-why')
        if (why) {
          // The player's own error, for the log next to the requests above it.
          videoLog(id, `the player stopped: ${why.slice(0, 300)}${videoErrors.get(id) ? '' : ' (no request failed)'}`)
          return new Response(videoErrors.get(id) || '', { status: 200, headers: { 'content-type': 'text/plain' } })
        }
        return await videoStream(id, request.headers.get('Range'), (u, init) => net.fetch(u, init))
      }
      // Electron doesn't fire request.signal when the player drops a stream
      // (next song, seek); it cancels the response body. The request to the
      // media server must be aborted then, or its connection stays open: after
      // six (Chromium's limit per server) every new stream from that server
      // waits forever, and songs stop playing until Lokal restarts.
      upstream = new AbortController()
      request.signal?.addEventListener?.('abort', () => upstream.abort(), { once: true })
      // net.fetch cannot return manual redirect responses (it rejects with
      // "Redirect was cancelled"). Addons must be fetched one hop at a time so
      // fetchChecked can validate every redirect target before requesting it.
      const fetchImpl = sources.addons.keyOfProvider(provider)
        ? (u, init) => netFetch(net, u, init)
        : (u, init) => net.fetch(u, init)
      const range = request.headers.get('Range')
      const loadRequest = ++streamLoadRequest
      const report = (phase, extra = {}) => emitStreamStartup({ provider, id, request: loadRequest, phase, ...extra })
      // Media element Range reads and seek retries share the same source key.
      // Only the renderer's currently selected source can show these events.
      report('resolving')
      logAddonStream(diagnostic, 'request', { method: request.method, range: range || null })
      const { res, mime } = await sources.fetchStream(provider, id, {
        ...streamOptions(), range, signal: upstream.signal, fetchImpl,
        onPhase: phase => report(phase),
      })
      const headers = new Headers()
      for (const name of PASS_HEADERS) { const v = res.headers.get(name); if (v) headers.set(name, v) }
      const upstreamType = res.headers.get('content-type')
      const contentType = sources.streamContentType(upstreamType, mime)
      if (contentType) headers.set('content-type', contentType)
      logAddonStream(diagnostic, 'response', {
        status: res.status,
        range: range || null,
        upstreamType: upstreamType || null,
        mime: mime || null,
        contentType: contentType || null,
        contentLength: res.headers.get('content-length') || null,
        contentRange: res.headers.get('content-range') || null,
        acceptRanges: res.headers.get('accept-ranges') || null,
        durationMs: Date.now() - startedAt,
      }, res.ok ? 'info' : 'warn')
      report(res.ok ? 'headers' : 'error', { status: res.status })
      const total = Number(res.headers.get('content-length'))
      const sourceBody = sources.cancellableBody(
        res.body, () => upstream.abort(),
        res.ok ? bytes => report('receiving', { loaded: bytes, total: total > 0 ? total : null }) : undefined,
      )
      return new Response(sourceBody, { status: res.status, headers })
    } catch (e) {
      const cancelled = !!upstream?.signal.aborted
      logAddonStream(diagnostic, cancelled ? 'cancelled' : 'failure', {
        stage: e?.streamStage || 'resolve-or-media-fetch',
        durationMs: Date.now() - startedAt,
        error: safeStreamError(e),
      }, cancelled ? 'info' : 'warn')
      return new Response(String(e.message || e), { status: 502, headers: { 'content-type': 'text/plain' } })
    }
  })
}

/** A music video's picture for another device (casting): the same stream the player gets. */
function musicVideoStream(id, range) {
  return videoStream(id, range, (u, init) => require('electron').net.fetch(u, init))
}

module.exports = { registerOnlineHandlers, registerStreamScheme, registerStreamProtocol, search, streamOptions, providers, songAudioFor, resolvedSourceAudio, listMusicVideos, prepareMusicVideoFor, musicVideoStream, getYouTubeMusicCredentials }
