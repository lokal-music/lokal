// Downloader IPC. The queue itself lives in electron/download/manager.js, shared
// with the web server (which runs in this same process), so a download started
// from a remote browser shows up here too, and vice versa.

const { spawn } = require('child_process')
const fs = require('fs-extra')
const { getDB, getStorageDir } = require('./db')
const { findYtDlp, findFfmpeg, findFfprobe } = require('./tools')
const { getDownloadManager } = require('../download/manager')
const { runJsonSearch, mapSearchResult, mapArtistResult } = require('../download/search')
const slskd = require('../download/slskd')
const { playableCopy, probe, playbackCopyFailure } = require('../download/convert')

const searchProcesses = new Set()

function trackProcess(proc) {
  if (!proc) return proc
  searchProcesses.add(proc)
  const cleanup = () => searchProcesses.delete(proc)
  proc.once('close', cleanup)
  proc.once('error', cleanup)
  return proc
}

function terminateProcessTree(proc) {
  if (!proc) return Promise.resolve()
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; clearTimeout(timeout); resolve() } }
    const timeout = setTimeout(finish, 8000)
    proc.once('close', finish)
    proc.once('exit', finish)
    proc.once('error', finish)
    try { proc.kill('SIGTERM') } catch {}
    if (process.platform === 'win32' && proc.pid) {
      try {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true })
        killer.once('close', () => {})
        killer.once('error', () => {})
      } catch {}
    } else {
      try { proc.kill('SIGKILL') } catch {}
    }
  })
}

function getVideoIdsFromArchive(archivePath) {
  const ids = new Set()
  try {
    if (!fs.existsSync(archivePath)) return ids
    for (const line of fs.readFileSync(archivePath, 'utf-8').split(/\r?\n/)) {
      const match = line.match(/([a-zA-Z0-9_-]{11})/)
      if (match) ids.add(match[1])
    }
  } catch {}
  return ids
}

function markPlaylistIncomplete(playlistId, downloadedCount = 0, totalTracks = 0) {
  try {
    getDB().prepare('UPDATE downloaded_playlists SET status = ?, downloaded_count = ?, total_tracks = ?, last_downloaded_at = ? WHERE id = ?')
      .run('incomplete', downloadedCount, totalTracks, Date.now(), playlistId)
  } catch {}
}

function markInterruptedPlaylistsIncomplete() {
  try {
    getDB().prepare('UPDATE downloaded_playlists SET status = ?, last_downloaded_at = ? WHERE status = ?')
      .run('incomplete', Date.now(), 'downloading')
  } catch {}
}

function broadcast(channel, payload) {
  const { BrowserWindow } = require('electron')
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** The desktop side of the shared queue: its tools, its library, its windows. */
function manager() {
  return getDownloadManager().configure({
    getDB,
    getStorageDir,
    findTools: () => ({ ytdlp: findYtDlp(), ffmpeg: findFfmpeg(), ffprobe: findFfprobe() }),
    // A fresh link for an addon download, right before it starts.
    resolveAddonUrl: async (provider, id) => (await require('../online/sources').resolveStream(provider, id, { db: getDB(), force: true, download: true })).url,
    verifyAddonAccess: key => require('../mornye/api').dispatch(getDB(), { action: 'package.verifyAndWait', key }),
    requireFfmpeg: true,
    index: async (filepath, opts) => {
      const { indexSingleFile } = require('./scanner')
      let lastError
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          if (fs.existsSync(filepath)) {
            const result = await indexSingleFile(filepath, opts)
            if (result?.id || result?.error) return result
          }
        } catch (error) { lastError = error }
        await new Promise(r => setTimeout(r, 700))
      }
      return { error: lastError?.message || 'Downloaded file could not be indexed' }
    },
    onLibraryUpdated: (result) => broadcast('library:updated', result),
    // YouTube refused a download: get the latest yt-dlp (unless we already have it).
    updateTools: async () => {
      const { getYtDlpVersionStatus, downloadYtDlp } = require('./tools')
      let status = null
      try { status = await getYtDlpVersionStatus() } catch {}
      if (status?.upToDate === true) return { updated: false, upToDate: true, version: status.installedVersion }
      try {
        await downloadYtDlp(progress => broadcast('tools:downloadProgress', { tool: 'yt-dlp', auto: true, ...progress }))
      } catch (e) {
        broadcast('tools:downloadProgress', { tool: 'yt-dlp', auto: true, status: 'error', message: e.message })
        throw e
      }
      let after = null
      try { after = await getYtDlpVersionStatus() } catch {}
      broadcast('tools:downloadProgress', { tool: 'yt-dlp', auto: true, status: 'done', message: `yt-dlp updated${after?.installedVersion ? ` to ${after.installedVersion}` : ''}. Retrying your downloads.` })
      return { updated: true, version: after?.installedVersion || null }
    },
    downloadMusicVideo: (videoId, opts) => {
      const online = require('./online')
      return require('../online/musicVideoDownloads').downloadVideo(videoId, {
        ...online.streamOptions(),
        ...opts,
        durable: true,
        videosDir: opts?.videosDir || require('../online/musicVideoDownloads').videosDir(),
        onFile: file => require('../online/musicVideoDownloads').rememberVideoFile(getDB(), { ...opts.video, videoId, title: opts.title, artist: opts.artist, trackId: opts.trackId }, file, opts.videoHeight),
        fetchImpl: (url, init) => require('electron').net.fetch(url, init),
      })
    },
    deleteMusicVideo: videoId => require('../online/musicVideoDownloads').deleteVideoFiles(getDB(), videoId),
    emit: (snapshot) => broadcast('downloader:progress', snapshot),
  }, 10)
}

const YTDLP_MISSING = 'yt-dlp not found. Go to Settings -> External Tools to download it automatically or set a custom path.'

function registerDownloaderHandlers(ipcMain) {
  manager().init()

  ipcMain.handle('downloader:search', async (_, query, page = 1) => {
    const ytdlp = findYtDlp()
    if (!ytdlp) return { error: YTDLP_MISSING, results: [], page: 1, hasMore: false }
    return runJsonSearch(ytdlp, query, mapSearchResult, page, 10, trackProcess)
  })

  ipcMain.handle('downloader:searchArtist', async (_, query, page = 1) => {
    const ytdlp = findYtDlp()
    if (!ytdlp) return { error: YTDLP_MISSING, results: [], page: 1, hasMore: false }
    const primary = await runJsonSearch(ytdlp, `${query} official artist channel`, mapArtistResult, page, 10, trackProcess)
    if (primary.results.length > 0 || primary.error) return primary
    return runJsonSearch(ytdlp, `${query} artist profile`, mapArtistResult, page, 10, trackProcess)
  })

  ipcMain.handle('downloader:download', (_, url, opts = {}) => {
    const clean = { ...(opts || {}) }
    // An addon track: a fresh link is asked for each time the job starts.
    const source = clean.addonSource
    const provider = String(source?.provider || '')
    clean.addonSource = /^a-[0-9a-f]{10}$/.test(provider) && typeof source?.id === 'string' && source.id && source.id.length <= 300 && !/[\r\n]/.test(source.id)
      ? { provider, id: source.id } : undefined
    clean.explicitAtmosDownload = clean.addonSource && clean.explicitAtmosDownload === true && clean.addonQuality === 'DOLBY_ATMOS'
    clean.addonQuality = clean.explicitAtmosDownload ? 'DOLBY_ATMOS' : undefined
    // What the source said about the song, for a file that comes without tags.
    clean.tags = require('../download/postprocess').knownTagsOf(clean.tags)
    const expectedDuration = Number(clean.expectedDuration)
    clean.expectedDuration = Number.isFinite(expectedDuration) && expectedDuration > 0 && expectedDuration < 36000
      ? expectedDuration
      : undefined
    // Songs of an imported playlist the file takes the place of.
    clean.replaceImported = Array.isArray(clean.replaceImported)
      ? clean.replaceImported.filter(id => typeof id === 'string' && /^[\w.-]{1,120}$/.test(id)).slice(0, 20)
      : undefined
    clean.confirmedImported = Array.isArray(clean.confirmedImported)
      ? clean.confirmedImported.filter(id => clean.replaceImported?.includes(id)) : undefined
    clean.manuallySelectedImported = Array.isArray(clean.manuallySelectedImported)
      ? clean.manuallySelectedImported.filter(id => clean.replaceImported?.includes(id)) : undefined
    clean.upgradeTrackId = typeof clean.upgradeTrackId === 'string' && /^[\w.-]{1,120}$/.test(clean.upgradeTrackId)
      ? clean.upgradeTrackId : undefined
    return manager().enqueue('single', url, clean)
  })
  ipcMain.handle('downloader:linkInfo', (_, url) => require('../download/linkInfo').linkInfo(url, { ytdlp: findYtDlp(), settings: manager().settings() }))
  ipcMain.handle('downloader:cancel', (_, id) => manager().cancel(id))
  ipcMain.handle('downloader:remove', (_, id) => manager().remove(id))
  ipcMain.handle('downloader:retry', (_, id) => manager().retry(id))
  ipcMain.handle('downloader:cancelAll', () => manager().cancelAll())
  ipcMain.handle('downloader:clearFinished', () => manager().clearFinished())
  ipcMain.handle('downloader:markSeen', () => manager().markSeen())
  ipcMain.handle('downloader:queue', () => manager().list())

  // Files the player can't decode (ALAC...): a cached playable copy. Only for
  // files that are in the library.
  ipcMain.handle('media:playableFile', async (_, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return null
    const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase()
    let known = null
    try { known = getDB().prepare('SELECT file_path FROM tracks WHERE file_path = ? OR REPLACE(file_path, char(92), \'/\') = ?').get(filePath, filePath.replace(/\\/g, '/')) } catch {}
    if (!known || norm(known.file_path) !== norm(filePath)) return null
    const ffmpeg = findFfmpeg()
    const info = await probe(known.file_path)
    const failure = playbackCopyFailure(info, ffmpeg)
    if (failure) return { path: null, error: failure }

    const copy = await playableCopy(known.file_path, { ffmpeg, cacheDir: require('../cache').cacheDir('playback') })
    // FFmpeg was available and the conversion was attempted. Only now should
    // the UI fall back to its generic "Can't play" message.
    return copy
      ? { path: copy, error: null }
      : { path: null, error: 'conversion-failed' }
  })

  // Soulseek, through the slskd Lokal runs (slskdManaged.js).
  const slskdSettings = () => manager().settings()
  slskd.useManaged({
    connect: settings => soulseekClient().ensureRunning(soulseekAccount(settings)),
    current: () => managedSoulseek?.connection || null,
    get downloadsDir() { return soulseekClient().dirs.downloads },
  })
  const wrap = (fn) => async (...args) => { try { return await fn(...args) } catch (e) { return { error: e.message } } }
  ipcMain.handle('soulseek:status', wrap(() => slskd.status(slskdSettings())))
  ipcMain.handle('soulseek:search', wrap((_, text) => slskd.startSearch(slskdSettings(), text)))
  ipcMain.handle('soulseek:results', wrap((_, id) => slskd.searchResults(slskdSettings(), id)))
  ipcMain.handle('soulseek:finishSearch', wrap((_, id) => slskd.finishSearch(slskdSettings(), id)))
  ipcMain.handle('soulseek:stopSearch', wrap((_, id) => slskd.stopSearch(slskdSettings(), id)))
  ipcMain.handle('soulseek:download', (_, file = {}, opts = {}) => enqueueSoulseek(file, opts))
  // Settings → Soulseek: sign in (download and start the client), sign out,
  // and update the client to slskd's latest release.
  ipcMain.handle('soulseek:client', () => soulseekClient().status())
  ipcMain.handle('soulseek:connect', wrap(async () => {
    const settings = slskdSettings()
    await soulseekClient().ensureRunning(soulseekAccount(settings))
    return slskd.status(settings)
  }))
  ipcMain.handle('soulseek:disconnect', wrap(async () => { await managedSoulseek?.stop(); return { ok: true } }))
  ipcMain.handle('soulseek:checkUpdate', wrap(() => soulseekClient().checkUpdate()))
  ipcMain.handle('soulseek:update', wrap(() => soulseekClient().updateClient()))
}

// The built-in Soulseek client (slskdManaged.js), made on first use.
let managedSoulseek = null
function soulseekClient() {
  if (!managedSoulseek) {
    const { app, BrowserWindow } = require('electron')
    const { ManagedSlskd } = require('../download/slskdManaged')
    managedSoulseek = new ManagedSlskd({
      baseDir: require('path').join(app.getPath('userData'), 'soulseek'),
      downloadRoot: () => require('../storageLocations').savedRoot('downloads'),
      download: (url, dest, onProgress) => require('./tools').downloadFileWithRetry(url, dest, onProgress, 2, 'Downloading the Soulseek client'),
      onChange: status => BrowserWindow.getAllWindows().forEach(win => { try { win.webContents.send('soulseek:clientStatus', status) } catch {} }),
    })
  }
  return managedSoulseek
}

/** The account the built-in client signs in with, and what it shares back. */
function soulseekAccount(settings = {}) {
  return {
    username: settings.soulseek_username,
    password: settings.soulseek_password,
    shared: settings.soulseek_share_library === '1' && settings.music_folder ? [settings.music_folder] : [],
  }
}

/** One job per file; the url only identifies it (and stops double clicks). */
function enqueueSoulseek(file = {}, opts = {}) {
  if (!file.username || !file.filename) return { error: 'Pick a file from the Soulseek results.' }
  const { name } = slskd.splitRemote(file.filename)
  return manager().enqueue('soulseek', `soulseek://${encodeURIComponent(file.username)}/${encodeURIComponent(file.filename)}`, {
    username: file.username,
    filename: file.filename,
    size: file.size,
    title: opts.title || name.replace(/\.[^.]+$/, ''),
    from: opts.from || `Soulseek · ${file.username}${file.quality ? ` · ${file.quality}` : ''}`,
    // A streamed song this file replaces once it's in the library.
    replaceTrackId: typeof opts.replaceTrackId === 'string' && /^[\w.-]{1,120}$/.test(opts.replaceTrackId) ? opts.replaceTrackId : undefined,
    // "Get it in lossless": the file replaces this track's file.
    upgradeTrackId: typeof opts.upgradeTrackId === 'string' && /^[\w.:-]{1,200}$/.test(opts.upgradeTrackId) ? opts.upgradeTrackId : undefined,
  })
}

function registerExtraDownloaderHandlers(ipcMain) {
  ipcMain.handle('downloader:downloadPlaylist', (_, url, opts = {}) => manager().enqueue('playlist', url, opts || {}))
}

function queueMusicVideo(video, options = {}) {
  return manager().enqueue('music-video', `https://www.youtube.com/watch?v=${video.videoId}`, {
    videoId: video.videoId,
    title: video.title || 'Music video',
    from: 'Music Video',
    thumbnail: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`,
    durable: true,
    videosDir: options.videosDir || require('../online/musicVideoDownloads').videosDir(),
    videoHeight: options.videoHeight,
    artist: options.artist || video.artist || video.artists?.[0],
    trackId: options.trackId,
    video,
  })
}

function waitForDownload(id) { return manager().waitFor(id) }

function registerPlaylistArchiveHandlers(ipcMain) {
  ipcMain.handle('downloader:getDownloadedPlaylists', () => {
    return getDB().prepare('SELECT * FROM downloaded_playlists ORDER BY COALESCE(last_downloaded_at, created_at) DESC').all()
  })

  ipcMain.handle('downloader:deleteDownloadedPlaylist', (_, playlistId) => {
    const db = getDB()
    const playlist = db.prepare('SELECT * FROM downloaded_playlists WHERE id = ?').get(playlistId)
    if (playlist?.archive_path) {
      try { fs.unlinkSync(playlist.archive_path) } catch {}
    }
    db.prepare('DELETE FROM downloaded_playlists WHERE id = ?').run(playlistId)
    return { success: true }
  })

  ipcMain.handle('downloader:redownloadPlaylist', async (_, playlistId) => {
    const db = getDB()
    const playlist = db.prepare('SELECT * FROM downloaded_playlists WHERE id = ?').get(playlistId)
    if (!playlist) return { error: 'Playlist not found' }
    const running = manager().hasPlaylistRunning(playlistId, playlist.url)
    if (running) await manager().remove(running.id)
    if (playlist.archive_path && fs.existsSync(playlist.archive_path)) {
      try { fs.unlinkSync(playlist.archive_path) } catch {}
    }
    db.prepare('DELETE FROM downloaded_playlists WHERE id = ?').run(playlistId)
    return manager().enqueue('playlist', playlist.url, { playlistId, title: playlist.title, from: 'Re-download' })
  })

  ipcMain.handle('downloader:getPlaylistArchiveIds', (_, playlistId) => {
    const playlist = getDB().prepare('SELECT archive_path FROM downloaded_playlists WHERE id = ?').get(playlistId)
    if (!playlist?.archive_path) return []
    return Array.from(getVideoIdsFromArchive(playlist.archive_path))
  })

  ipcMain.handle('downloader:removeFromPlaylistArchive', (_, playlistId, videoId) => {
    const playlist = getDB().prepare('SELECT archive_path FROM downloaded_playlists WHERE id = ?').get(playlistId)
    if (!playlist?.archive_path) return { error: 'Playlist not found' }
    try {
      if (fs.existsSync(playlist.archive_path)) {
        const next = fs.readFileSync(playlist.archive_path, 'utf-8')
          .split(/\r?\n/)
          .filter(line => line && !line.includes(videoId))
          .join('\n')
        fs.writeFileSync(playlist.archive_path, next)
      }
      return { success: true }
    } catch (error) {
      return { error: error.message }
    }
  })
}

module.exports = {
  registerDownloaderHandlers,
  enqueueSoulseek,
  registerExtraDownloaderHandlers,
  registerPlaylistArchiveHandlers,
  manager,
  terminateProcessTree,
  markInterruptedPlaylistsIncomplete,
  markPlaylistIncomplete,
  // yt-dlp is about to be replaced: running downloads stop and wait in line.
  stopActiveDownloadsForToolUpdate: async () => {
    const downloads = await manager().suspend()
    await Promise.all([...searchProcesses].map(proc => terminateProcessTree(proc)))
    return { success: true, count: downloads.count, ids: downloads.ids }
  },
  resumeDownloadsAfterToolUpdate: () => manager().resume(),
  queueMusicVideo,
  waitForDownload,
  shutdownActiveDownloads: () => {
    manager().shutdown()
    managedSoulseek?.stop().catch(() => {})
    for (const proc of searchProcesses) terminateProcessTree(proc)
    searchProcesses.clear()
  },
}
