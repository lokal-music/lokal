// Web-mode download routes. The queue is electron/download/manager.js, the
// same one the desktop app uses (in the desktop app both run in one process
// and share it); standalone, the server configures it with plain PATH tools.

const router = require('express').Router()
const fs = require('fs-extra')
const { execFileSync } = require('child_process')
const { getDB, getStorageDir } = require('../../electron/ipc/db')
const { getDownloadManager } = require('../../electron/download/manager')
const { runJsonSearch, mapSearchResult, mapArtistResult } = require('../../electron/download/search')

const found = new Map()
function findBinary(name, versionFlag = '--version') {
  if (found.has(name)) return found.get(name)
  const candidates = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  let hit = null
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, [versionFlag], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
      hit = candidate
      break
    } catch {}
  }
  // Only a hit is remembered, so installing yt-dlp later works without a restart.
  if (hit) found.set(name, hit)
  return hit
}

function manager() {
  return getDownloadManager().configure({
    getDB,
    getStorageDir,
    findTools: () => ({ ytdlp: findBinary('yt-dlp'), ffmpeg: findBinary('ffmpeg', '-version'), ffprobe: findBinary('ffprobe', '-version') }),
    // A fresh link for an addon download, right before it starts.
    resolveAddonUrl: async (provider, id) => (await require('../../electron/online/sources').resolveStream(provider, id, { db: getDB(), force: true, download: true })).url,
    requireFfmpeg: false,
    index: async (filepath, opts) => {
      const { indexSingleFile } = require('../../electron/ipc/scanner')
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
    emit: () => {},
  }, 0)
}

router.get('/search', async (req, res) => {
  const { q, page = 1 } = req.query
  if (!q) return res.json({ results: [], page: 1, hasMore: false })
  const ytdlp = findBinary('yt-dlp')
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp not found', results: [], page: 1, hasMore: false })
  const result = await runJsonSearch(ytdlp, q, mapSearchResult, page, 10)
  res.status(result.error ? 500 : 200).json(result)
})

router.get('/artist-search', async (req, res) => {
  const { q, page = 1 } = req.query
  if (!q) return res.json({ results: [], page: 1, hasMore: false })
  const ytdlp = findBinary('yt-dlp')
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp not found', results: [], page: 1, hasMore: false })
  const primary = await runJsonSearch(ytdlp, `${q} official artist channel`, mapArtistResult, page, 10)
  if (primary.results.length > 0 || primary.error) return res.status(primary.error ? 500 : 200).json(primary)
  const fallback = await runJsonSearch(ytdlp, `${q} artist profile`, mapArtistResult, page, 10)
  res.status(fallback.error ? 500 : 200).json(fallback)
})

// Only what a browser needs to say. Anything that decides where files go
// (outputDir) or which archive file is used stays server-side (CWE-22).
const PLAYLIST_ID = /^[\w.-]{1,120}$/
/** An addon track to download ({ provider: 'a-<key>', id }), checked, or undefined. */
function addonSourceOf(value) {
  if (!value || typeof value !== 'object') return undefined
  const provider = String(value.provider || '')
  const id = typeof value.id === 'string' ? value.id : ''
  return /^a-[0-9a-f]{10}$/.test(provider) && id && id.length <= 300 && !/[\r\n]/.test(id) ? { provider, id } : undefined
}
function enqueue(kind) {
  return (req, res) => {
    const { url, format, quality, title, thumbnail, from, playlistId, replaceTrackId, upgradeTrackId, replaceImported, confirmedImported, manuallySelectedImported, addonSource, tags, expectedDuration } = req.body || {}
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' })
    if (playlistId != null && (!PLAYLIST_ID.test(String(playlistId)) || /^\.+$/.test(String(playlistId)))) {
      return res.status(400).json({ error: 'Invalid playlistId' })
    }
    const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined)
    const opts = { format: text(format, 12), quality: text(String(quality ?? ''), 4) || undefined, title: text(title), thumbnail: text(thumbnail, 1000), from: text(from, 120), playlistId: playlistId ?? undefined }
    // The ghost track (a streamed song) this download replaces once it's in the library.
    if (kind === 'single' && typeof replaceTrackId === 'string' && /^[\w.-]{1,120}$/.test(replaceTrackId)) opts.replaceTrackId = replaceTrackId
    if (kind === 'single' && typeof upgradeTrackId === 'string' && /^[\w.-]{1,120}$/.test(upgradeTrackId)) opts.upgradeTrackId = upgradeTrackId
    // Songs of an imported playlist the file takes the place of.
    if (kind === 'single' && Array.isArray(replaceImported)) opts.replaceImported = replaceImported.filter(id => typeof id === 'string' && /^[\w.-]{1,120}$/.test(id)).slice(0, 20)
    if (kind === 'single' && Array.isArray(confirmedImported)) opts.confirmedImported = confirmedImported.filter(id => opts.replaceImported?.includes(id))
    if (kind === 'single' && Array.isArray(manuallySelectedImported)) opts.manuallySelectedImported = manuallySelectedImported.filter(id => opts.replaceImported?.includes(id))
    // An addon track: a fresh link is asked for each time the job starts.
    if (kind === 'single' && addonSourceOf(addonSource)) opts.addonSource = addonSourceOf(addonSource)
    // What the source said about the song, for a file that comes without tags.
    const duration = Number(expectedDuration)
    if (kind === 'single' && Number.isFinite(duration) && duration > 0 && duration < 36000) opts.expectedDuration = duration
    if (kind === 'single') opts.tags = require('../../electron/download/postprocess').knownTagsOf(tags)
    const result = manager().enqueue(kind, url, opts)
    // Already in the library isn't a failure: the app shows the song as saved.
    res.status(result.error && !result.alreadyInLibrary ? 500 : 200).json(result)
  }
}

router.post('/', enqueue('single'))
router.post('/playlist', enqueue('playlist'))

const byId = (action) => async (req, res) => {
  const { id } = req.body || {}
  if (!id) return res.status(400).json({ error: 'id is required' })
  const result = await manager()[action](id)
  res.status(result?.error ? 404 : 200).json(result)
}

router.post('/link-info', async (req, res) => {
  const { linkInfo } = require('../../electron/download/linkInfo')
  res.json(await linkInfo(req.body?.url, { ytdlp: findBinary('yt-dlp'), settings: manager().settings() }))
})
router.post('/cancel', byId('cancel'))
router.post('/remove', byId('remove'))
router.post('/retry', byId('retry'))
router.post('/cancel-all', async (req, res) => res.json(await manager().cancelAll()))
router.post('/clear-finished', (req, res) => res.json(manager().clearFinished()))
router.post('/seen', (req, res) => res.json(manager().markSeen()))
router.get('/queue', (req, res) => res.json(manager().list()))

// Soulseek, through the slskd the desktop app runs (signed in from
// Settings). The web API has no accounts, so these only answer this machine
// and the local network, never a request coming in from the internet.
const slskd = require('../../electron/download/slskd')

function isLocalAddress(address) {
  const a = String(address || '').replace(/^::ffff:/i, '').toLowerCase()
  if (a === '::1' || a === 'localhost') return true
  if (/^fe80:|^f[cd][0-9a-f]{2}:/.test(a)) return true // IPv6 link-local / unique-local
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [x, y] = [Number(m[1]), Number(m[2])]
  return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254)
}

router.use('/soulseek', (req, res, next) => {
  if (isLocalAddress(req.socket?.remoteAddress)) return next()
  res.status(403).json({ error: 'Soulseek is only available from this computer or your local network.' })
})

const soulseek = (fn) => async (req, res) => {
  try { res.json(await fn(req)) } catch (e) { res.status(e.status && e.status >= 400 ? e.status : 502).json({ error: e.message }) }
}
router.get('/soulseek/status', soulseek(() => slskd.status(manager().settings())))
router.post('/soulseek/search', soulseek(req => slskd.startSearch(manager().settings(), req.body?.text)))
router.get('/soulseek/search/:id', soulseek(req => slskd.searchResults(manager().settings(), req.params.id)))
router.put('/soulseek/search/:id', soulseek(req => slskd.finishSearch(manager().settings(), req.params.id)))
router.delete('/soulseek/search/:id', soulseek(req => slskd.stopSearch(manager().settings(), req.params.id)))
router.post('/soulseek/download', (req, res) => {
  const { file = {}, title, from, replaceTrackId, upgradeTrackId } = req.body || {}
  const opts = {
    title: typeof title === 'string' ? title.slice(0, 300) : undefined,
    from: typeof from === 'string' ? from.slice(0, 120) : undefined,
    // "Get it in lossless": the file replaces this track's file.
    upgradeTrackId: typeof upgradeTrackId === 'string' && /^[\w.:-]{1,200}$/.test(upgradeTrackId) ? upgradeTrackId : undefined,
  }
  if (typeof file.username !== 'string' || typeof file.filename !== 'string' || !file.username || !file.filename) return res.status(400).json({ error: 'Pick a file from the Soulseek results.' })
  const { name } = slskd.splitRemote(file.filename)
  const result = manager().enqueue('soulseek', `soulseek://${encodeURIComponent(file.username)}/${encodeURIComponent(file.filename)}`, {
    username: file.username, filename: file.filename, size: file.size,
    title: opts.title || name.replace(/\.[^.]+$/, ''),
    from: opts.from || `Soulseek · ${file.username}${file.quality ? ` · ${file.quality}` : ''}`,
    // A streamed song this file replaces once it's in the library.
    replaceTrackId: typeof replaceTrackId === 'string' && /^[\w.-]{1,120}$/.test(replaceTrackId) ? replaceTrackId : undefined,
    upgradeTrackId: opts.upgradeTrackId,
  })
  res.status(result.error ? 500 : 200).json(result)
})

router.get('/playlists', (req, res) => {
  const db = getDB()
  res.json(db.prepare('SELECT * FROM downloaded_playlists ORDER BY COALESCE(last_downloaded_at, created_at) DESC').all())
})

router.delete('/playlist', (req, res) => {
  const { playlistId } = req.body || {}
  if (!playlistId) return res.status(400).json({ error: 'playlistId is required' })
  const db = getDB()
  const playlist = db.prepare('SELECT * FROM downloaded_playlists WHERE id = ?').get(playlistId)
  if (playlist?.archive_path) {
    try { fs.unlinkSync(playlist.archive_path) } catch {}
  }
  db.prepare('DELETE FROM downloaded_playlists WHERE id = ?').run(playlistId)
  res.json({ success: true })
})

router.post('/playlist/redownload', async (req, res) => {
  const { playlistId } = req.body || {}
  if (!playlistId) return res.status(400).json({ error: 'playlistId is required' })
  const db = getDB()
  const playlist = db.prepare('SELECT * FROM downloaded_playlists WHERE id = ?').get(playlistId)
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' })
  const running = manager().hasPlaylistRunning(playlistId, playlist.url)
  if (running) await manager().remove(running.id)
  if (playlist.archive_path && fs.existsSync(playlist.archive_path)) {
    try { fs.unlinkSync(playlist.archive_path) } catch {}
  }
  db.prepare('DELETE FROM downloaded_playlists WHERE id = ?').run(playlistId)
  const result = manager().enqueue('playlist', playlist.url, { playlistId, title: playlist.title, from: 'Re-download' })
  res.status(result.error ? 500 : 200).json(result)
})

router.get('/playlist/archive-ids', (req, res) => {
  const { playlistId } = req.query
  if (!playlistId) return res.status(400).json({ error: 'playlistId is required' })
  const db = getDB()
  const playlist = db.prepare('SELECT archive_path FROM downloaded_playlists WHERE id = ?').get(playlistId)
  if (!playlist?.archive_path || !fs.existsSync(playlist.archive_path)) return res.json([])
  const ids = fs.readFileSync(playlist.archive_path, 'utf-8')
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/([a-zA-Z0-9_-]{11})/)
      return match ? match[1] : null
    })
    .filter(Boolean)
  res.json(Array.from(new Set(ids)))
})

router.post('/playlist/remove-archive', (req, res) => {
  const { playlistId, videoId } = req.body || {}
  if (!playlistId || !videoId) return res.status(400).json({ error: 'playlistId and videoId are required' })
  const db = getDB()
  const playlist = db.prepare('SELECT archive_path FROM downloaded_playlists WHERE id = ?').get(playlistId)
  if (!playlist?.archive_path) return res.status(404).json({ error: 'Playlist not found' })

  try {
    if (fs.existsSync(playlist.archive_path)) {
      const content = fs.readFileSync(playlist.archive_path, 'utf-8')
      const next = content
        .split(/\r?\n/)
        .filter(line => line && !line.includes(videoId))
        .join('\n')
      fs.writeFileSync(playlist.archive_path, next)
    }
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Shared with the online routes (streaming with the same yt-dlp).
router.findBinary = findBinary
router.manager = manager

module.exports = router
