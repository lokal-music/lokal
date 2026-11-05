const express = require('express')
const { getDB } = require('../../electron/ipc/db')
const { getRemoteState, sendRemoteCommand, getRemoteConnectionInfo } = require('../../electron/ipc/remote')
const { smartTracks, playlistRules } = require('../../electron/playlists/smart')

const router = express.Router()

function authorized(req) {
  if (req.linkDevice || require('../../electron/link').getLink()?.auth(req.headers['x-remote-token'])) return true
  const token = String(process.env.REMOTE_TOKEN || '').trim()
  if (!token) return true
  const provided = req.headers['x-remote-token'] || req.query.token || req.body?.token
  return provided === token
}

router.use((req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' })
  next()
})

// Profile and original audio are available only to the individually paired
// phone belonging to the active desktop user, never the legacy shared token.
function pairedUser(req, res) {
  const device = req.linkDevice
  const userId = String(getRemoteState().userId || 'guest')
  if (!device || device.legacy || device.user_id !== userId) {
    res.status(403).json({ error: 'Pair this phone with the active desktop user first.' })
    return null
  }
  return userId
}

function profileFor(userId) {
  return getDB().prepare('SELECT id, username, display_name, avatar_path FROM users WHERE id = ?').get(userId)
}

router.get('/profile', (req, res) => {
  const userId = pairedUser(req, res)
  if (!userId) return
  const user = profileFor(userId)
  let avatarVersion = null
  if (user?.avatar_path) {
    try {
      const stat = require('fs').statSync(user.avatar_path)
      if (stat.isFile() && stat.size <= 5 * 1024 * 1024) avatarVersion = `${stat.mtimeMs}:${stat.size}`
    } catch {}
  }
  res.set('Cache-Control', 'no-store')
  res.json({ profile: user ? {
    id: user.id, username: user.username, displayName: user.display_name,
    hasAvatar: avatarVersion !== null, avatarVersion,
  } : null })
})

router.get('/profile/avatar', (req, res) => {
  const userId = pairedUser(req, res)
  if (!userId) return
  const avatar = profileFor(userId)?.avatar_path
  try {
    const stat = require('fs').statSync(avatar)
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return res.sendStatus(404)
    res.set('Cache-Control', 'private, no-cache')
    res.sendFile(require('path').resolve(avatar))
  } catch { res.sendStatus(404) }
})

router.post('/library/lyrics', async (req, res) => {
  if (!pairedUser(req, res)) return
  const ids = req.body?.ids
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || id.length > 512)) {
    return res.status(400).json({ error: 'Expected up to 50 track IDs' })
  }
  try {
    const { exportedLyrics } = require('../../electron/link/lyricsExport')
    const db = getDB()
    const hasMeta = db.prepare('PRAGMA table_info(lyrics_cache)').all().some(c => c.name === 'meta')
    const select = db.prepare(`SELECT t.id,t.file_path,l.content,l.lyrics_type,l.source,${hasMeta ? 'l.meta' : 'NULL AS meta'}
      FROM tracks t LEFT JOIN lyrics_cache l ON l.track_id=t.id
      WHERE t.id=? AND t.file_path NOT LIKE 'ghost://%'`)
    const items = []
    let bytes = 0
    for (const id of new Set(ids)) {
      const row = select.get(id)
      if (!row) continue
      const lyrics = await exportedLyrics(row)
      if (!lyrics) continue
      const item = { id: String(row.id), lyrics }
      const size = Buffer.byteLength(JSON.stringify(item))
      if (size > 2 * 1024 * 1024 || bytes + size > 4 * 1024 * 1024) continue
      bytes += size
      items.push(item)
    }
    res.set('Cache-Control', 'private, no-store').json({ items })
  } catch (error) {
    console.error('[remote] Lyrics export failed:', error.message)
    res.status(500).json({ error: 'Could not export saved lyrics' })
  }
})

router.get('/files', (req, res) => {
  if (!pairedUser(req, res)) return
  res.json({ originalFiles: true, contentMatching: true, sizeMatching: true,
    uploadOperations: require('../linkUpload').uploadOperationVersion() })
})

// A blocked filesystem or disconnected phone must not leave a preview running
// indefinitely. Checks also stop further stat/hash work after the response ends.
async function boundedFileCheck(res, work, milliseconds) {
  let expired = false
  const check = () => {
    if (expired || res.destroyed) throw new Error('File comparison stopped')
  }
  let timer
  try {
    return await Promise.race([
      work(check),
      new Promise((_, reject) => { timer = setTimeout(() => {
        expired = true
        reject(new Error('File comparison timed out'))
      }, milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

router.post('/files/sizes', async (req, res) => {
  if (!pairedUser(req, res)) return
  const sizes = req.body?.sizes
  if (!Array.isArray(sizes) || sizes.length > 2048 || sizes.some(size =>
    !Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024 * 1024)) {
    return res.status(400).json({ error: 'Expected up to 2048 file sizes' })
  }
  try {
    const { candidateOriginalSizes } = require('../phoneFileMatch')
    const candidates = await boundedFileCheck(res, check => candidateOriginalSizes(getDB(), sizes, { check }), 15000)
    if (!res.destroyed) res.set('Cache-Control', 'private, no-store').json({ sizes: candidates })
  } catch {
    if (!res.destroyed) res.status(503).json({ error: 'Desktop file-size check did not finish. Reconnect and retry.' })
  }
})

router.post('/files/match', async (req, res) => {
  if (!pairedUser(req, res)) return
  const items = req.body?.items
  if (!Array.isArray(items) || items.length > 32 || items.some(item =>
    !item || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 1024 * 1024 * 1024 ||
    typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))) {
    return res.status(400).json({ error: 'Expected up to 32 audio fingerprints' })
  }
  try {
    const { resolvePhoneFiles } = require('../phoneFileMatch')
    const matches = await boundedFileCheck(res, check => resolvePhoneFiles(getDB(), items, { check }), 25000)
    // Preview must not probe metadata or rebuild artwork before responding.
    if (!res.destroyed) res.set('Cache-Control', 'private, no-store').json({ matches })
  } catch {
    if (!res.destroyed) res.status(503).json({ error: 'Desktop content check did not finish. Reconnect and retry.' })
  }
})

router.get('/files/operations', (req,res) => {
  if (!pairedUser(req,res)) return
  res.set('Cache-Control','private, no-store').json({protocolVersion:1,
    uploadOperations:require('../linkUpload').uploadOperationVersion()})
})
router.get('/files/operations/:operationId', (req,res) => {
  if (!pairedUser(req,res)) return
  return require('../linkUpload').phoneUploadStatus(req,res)
})
router.post('/files/operations/:operationId/cancel', (req,res) => {
  if (!pairedUser(req,res)) return
  return require('../linkUpload').cancelPhoneUpload(req,res)
})

router.get('/files/:trackId', (req, res) => {
  if (!pairedUser(req, res)) return
  const track = getDB().prepare('SELECT file_path, file_hash FROM tracks WHERE id = ?').get(req.params.trackId)
  if (!track || track.file_path.startsWith('ghost://')) return res.sendStatus(404)
  try {
    const stat = require('fs').statSync(track.file_path)
    if (!stat.isFile()) return res.sendStatus(404)
    // Unlike /api/stream, this never substitutes a playback transcode.
    res.set('Cache-Control', 'private, no-store')
    if (/^[a-fA-F0-9]{64}$/.test(track.file_hash || '')) res.set('X-Content-SHA256', track.file_hash)
    res.type('application/octet-stream').sendFile(require('path').resolve(track.file_path))
  } catch { res.sendStatus(404) }
})

function queryText(value) {
  return String(value || '').trim().slice(0, 100)
}

function pagination(req, fallback = 30, maxLimit = 50) {
  return {
    limit: Math.max(1, Math.min(maxLimit, parseInt(req.query.limit, 10) || fallback)),
    offset: Math.max(0, Math.min(100000, parseInt(req.query.offset, 10) || 0)),
  }
}

function safeLike(value) {
  return `%${String(value || '')}%`
}

function compactTrack(track) {
  if (!track) return null
  return {
    id: track.id,
    title: track.title || 'Unknown track',
    artist: track.artist || 'Unknown artist',
    album: track.album || '',
    album_artist: track.album_artist || '',
    genre: track.genre || '',
    genres: track.genres || null,
    duration: Number(track.duration) || 0,
    bitrate: Number(track.bitrate) || null,
    sample_rate: Number(track.sample_rate) || null,
    bit_depth: Number(track.bit_depth) || null,
    year: Number(track.year) || null,
    track_num: Number(track.track_num) || null,
    play_count: Number(track.play_count) || 0,
    liked: !!(track.user_liked ?? track.liked),
    hasArtwork: !!track.artwork_path,
    file_hash: track.file_hash || null,
    fileType: require('path').extname(track.file_path || '').slice(1).toLowerCase() || 'bin',
  }
}

function compactTracks(rows) {
  return (Array.isArray(rows) ? rows : []).map(compactTrack).filter(Boolean)
}

function userTrackQuery(uid = 'guest') {
  const quotedUid = `'${String(uid).replace(/'/g, "''")}'`
  return `EXISTS (SELECT 1 FROM user_likes ul WHERE ul.user_id = ${quotedUid} AND ul.track_id = t.id)`
}

router.get('/state', (req, res) => res.json(getRemoteState()))

router.post('/command', async (req, res) => {
  const action = req.body?.action
  const value = req.body?.value
  if (!action) return res.status(400).json({ error: 'Missing action' })
  const result = await sendRemoteCommand({ action, value, ts: Date.now() })
  if (result?.error) return res.status(503).json(result)
  return res.json(result || { ok: true })
})

router.get('/connection', (req, res) => res.json(getRemoteConnectionInfo()))

// All collection endpoints sit below /api/remote and inherit the same
// REMOTE_TOKEN check as transport commands.
// A history-only mobile play may have no matching desktop audio. Retain its
// album thumbnail independently of the music file, without accepting a path,
// URL, remote token, or unbounded image from the phone. Existing real PC
// recordings and their covers are never modified by this route.
router.post('/history/artwork', async (req, res) => {
  const userId = pairedUser(req, res)
  if (!userId) return
  const key = req.body?.track_key
  const encoded = req.body?.image_base64
  if (typeof key !== 'string' || !key.trim() || key.length > 1500 ||
      typeof encoded !== 'string' || encoded.length > 240000 ||
      !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) {
    return res.status(400).json({ error: 'Invalid linked artwork.' })
  }
  const db = getDB()
  const recorded = db.prepare(
    'SELECT 1 FROM history_events WHERE user_id=? AND device_id=? AND track_key=? LIMIT 1'
  ).get(userId, req.linkDevice.id, key)
  if (!recorded) return res.status(404).json({ error: 'Unknown mobile play.' })
  const id = 'link_' + require('../../electron/link/store').hash(key)
  const row = db.prepare('SELECT file_path,artwork_path FROM tracks WHERE id=?').get(id)
  if (!row || !String(row.file_path).startsWith('ghost://link/')) {
    // The history event already resolved to a real desktop recording (or its
    // placeholder was promoted to one). Mark the cover transfer complete,
    // rather than making the phone decode and retry it every sync.
    return res.json({ ok: true, noPlaceholder: true })
  }
  const fs = require('fs')
  if (row.artwork_path && fs.existsSync(row.artwork_path)) {
    return res.json({ ok: true, alreadyPresent: true })
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length < 20 || bytes.length > 180000 ||
      !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    return res.status(415).json({ error: 'Expected a bounded JPEG thumbnail.' })
  }
  try {
    const root = require('path').join(require('../../electron/ipc/db').getStorageDir(), 'artwork')
    const artwork = await require('../../electron/artwork/thumb').writeCover(
      root, id + '-mobile-history', bytes
    )
    db.prepare("UPDATE tracks SET artwork_path=?,download_source='mobile' WHERE id=? AND file_path LIKE 'ghost://link/%'")
      .run(artwork,id)
    require('../../electron/ipc/remote').events.emit('library', { type: 'mobile-history-artwork' })
    return res.set('Cache-Control', 'private, no-store').json({ ok: true })
  } catch (error) {
    return res.status(500).json({ error: 'Could not save mobile artwork.' })
  }
})

// Phone originals may use a separate cover.jpg rather than an embedded
// picture. Accept artwork only for an audio file copied from that phone, and
// never replace an existing image from a real file or an owner's manual edit.
router.post('/files/:trackId/artwork', async (req, res) => {
  if (!pairedUser(req, res)) return
  const trackId = String(req.params.trackId || '')
  if (!trackId || trackId.length > 256) {
    return res.status(400).json({ error: 'Invalid copied track.' })
  }
  const db = getDB()
  const row = db.prepare(
    "SELECT file_path,artwork_path,download_source FROM tracks WHERE id=?"
  ).get(trackId)
  if (!row || row.download_source !== 'mobile' ||
      String(row.file_path || '').startsWith('ghost://')) {
    return res.status(404).json({ error: 'Unknown copied phone recording.' })
  }
  const fs = require('fs')
  if (row.artwork_path && fs.existsSync(row.artwork_path)) {
    return res.json({ ok: true, alreadyPresent: true })
  }
  const encoded = req.body?.image_base64
  if (typeof encoded !== 'string' || encoded.length > 240000 ||
      !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) {
    return res.status(400).json({ error: 'Invalid linked artwork.' })
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length < 20 || bytes.length > 180000 ||
      !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    return res.status(415).json({ error: 'Expected a bounded JPEG thumbnail.' })
  }
  try {
    const root = require('path').join(require('../../electron/ipc/db').getStorageDir(), 'artwork')
    const name = 'mobile-copy-' + require('../../electron/link/store').hash(trackId)
    const artwork = await require('../../electron/artwork/thumb').writeCover(
      root, name, bytes
    )
    db.prepare("UPDATE tracks SET artwork_path=? WHERE id=? AND download_source='mobile' AND (artwork_path IS NULL OR artwork_path='')")
      .run(artwork, trackId)
    require('../../electron/ipc/remote').events.emit('library', { type: 'mobile-copy-artwork' })
    return res.set('Cache-Control', 'private, no-store').json({ ok: true })
  } catch {
    return res.status(500).json({ error: 'Could not save copied-phone artwork.' })
  }
})

// The paired phone imports in batches; using the remote UI's 50-row cap
// made a 5,500-track library require 110 HTTP round trips.
router.get('/library/file-size/:trackId', async (req, res) => {
  if (!pairedUser(req, res)) return
  const trackId = String(req.params.trackId || '')
  if (!trackId || trackId.length > 512) return res.status(400).json({ error: 'Invalid track ID' })
  const track = getDB().prepare("SELECT file_path FROM tracks WHERE id=? AND file_path NOT LIKE 'ghost://%'").get(trackId)
  if (!track?.file_path) return res.status(404).json({ bytes: null })
  try {
    const stat = await require('fs').promises.stat(track.file_path)
    return res.set('Cache-Control', 'private, no-store').json({
      bytes: stat.isFile() && stat.size > 0 ? stat.size : null
    })
  } catch {
    return res.set('Cache-Control', 'private, no-store').json({ bytes: null })
  }
})

router.get('/library/tracks', (req, res) => {
  const db = getDB()
  const q = queryText(req.query.q)
  const { limit, offset } = pagination(req, 50, 250)
  const uid = String(getRemoteState().userId || 'guest').slice(0, 200)
  const where = ["t.file_path NOT LIKE 'ghost://%'"]
  const params = []
  if (q) {
    const like = safeLike(q)
    where.push("(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ? OR t.album_artist LIKE ?)")
    params.push(like, like, like, like)
  }
  const clause = where.join(' AND ')
  const rows = db.prepare(`
    SELECT t.*, CASE WHEN ${userTrackQuery(uid)} THEN 1 ELSE 0 END AS user_liked
    FROM tracks t WHERE ${clause}
    ORDER BY t.title COLLATE NOCASE, t.artist COLLATE NOCASE LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  const total = db.prepare(`SELECT COUNT(*) AS total FROM tracks t WHERE ${clause}`).get(...params)?.total || 0
  return res.json({ items: compactTracks(rows), total, limit, offset, hasMore: offset + rows.length < total })
})

router.get('/library/albums', (req, res) => {
  const db = getDB()
  const q = queryText(req.query.q)
  const { limit, offset } = pagination(req)
  const where = ["t.album IS NOT NULL", "TRIM(t.album) <> ''", "t.file_path NOT LIKE 'ghost://%'"]
  const params = []
  if (q) {
    const like = safeLike(q)
    where.push("(t.album LIKE ? OR t.album_artist LIKE ? OR t.artist LIKE ?)")
    params.push(like, like, like)
  }
  const whereSql = where.join(' AND ')
  const groupSql = `
    FROM tracks t WHERE ${whereSql}
    GROUP BY LOWER(t.album), LOWER(COALESCE(NULLIF(t.album_artist, ''), t.artist))
  `
  const rows = db.prepare(`
    SELECT t.album AS title, COALESCE(NULLIF(t.album_artist, ''), t.artist) AS artist,
      MAX(t.year) AS year, COUNT(*) AS track_count,
      (SELECT x.id FROM tracks x
        WHERE LOWER(x.album) = LOWER(t.album)
          AND LOWER(COALESCE(NULLIF(x.album_artist, ''), x.artist)) = LOWER(COALESCE(NULLIF(t.album_artist, ''), t.artist))
          AND x.file_path NOT LIKE 'ghost://%' AND NULLIF(x.artwork_path, '') IS NOT NULL
        ORDER BY COALESCE(x.track_num, 999999), x.title LIMIT 1) AS coverTrackId
    ${groupSql}
    ORDER BY MAX(t.year) DESC, t.album COLLATE NOCASE LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  const total = db.prepare(`SELECT COUNT(*) AS total FROM (SELECT 1 ${groupSql})`).get(...params)?.total || 0
  return res.json({ items: rows.map(row => ({ ...row, track_count: Number(row.track_count) || 0 })), total, limit, offset, hasMore: offset + rows.length < total })
})

router.get('/library/album-tracks', (req, res) => {
  const title = queryText(req.query.title)
  const artist = queryText(req.query.artist)
  if (!title) return res.status(400).json({ error: 'Album title is required' })
  const rows = getDB().prepare(`
    SELECT t.*, CASE WHEN ${userTrackQuery(String(getRemoteState().userId || 'guest').slice(0, 200))} THEN 1 ELSE 0 END AS user_liked
    FROM tracks t
    WHERE LOWER(t.album) = LOWER(?) AND LOWER(COALESCE(NULLIF(t.album_artist, ''), t.artist)) = LOWER(?)
      AND t.file_path NOT LIKE 'ghost://%'
    ORDER BY COALESCE(t.track_num, 999999), t.title COLLATE NOCASE
  `).all(title, artist)
  return res.json({ items: compactTracks(rows), total: rows.length })
})

router.get('/library/artists', (req, res) => {
  const db = getDB()
  const q = queryText(req.query.q)
  const { limit, offset } = pagination(req)
  const where = ["t.file_path NOT LIKE 'ghost://%'"]
  const params = []
  if (q) { where.push("a.name LIKE ?"); params.push(safeLike(q)) }
  const whereSql = where.join(' AND ')
  const fromSql = `
    FROM artists a JOIN artist_track_links atl ON atl.artist_id = a.id
    JOIN tracks t ON t.id = atl.track_id
    WHERE ${whereSql}
    GROUP BY a.id HAVING COUNT(DISTINCT t.id) > 0
  `
  const rows = db.prepare(`
    SELECT a.id, a.name, COUNT(DISTINCT t.id) AS track_count,
      (SELECT x.id FROM artist_track_links xlink JOIN tracks x ON x.id = xlink.track_id
       WHERE xlink.artist_id = a.id AND x.file_path NOT LIKE 'ghost://%' AND NULLIF(x.artwork_path, '') IS NOT NULL
       ORDER BY COALESCE(x.track_num, 999999), x.title LIMIT 1) AS coverTrackId
    ${fromSql} ORDER BY a.name COLLATE NOCASE LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  const total = db.prepare(`SELECT COUNT(*) AS total FROM (SELECT a.id ${fromSql})`).get(...params)?.total || 0
  return res.json({ items: rows.map(row => ({ ...row, track_count: Number(row.track_count) || 0 })), total, limit, offset, hasMore: offset + rows.length < total })
})

router.get('/library/artist-tracks', (req, res) => {
  const artistId = queryText(req.query.id)
  const uid = String(getRemoteState().userId || 'guest').slice(0, 200)
  if (!artistId) return res.status(400).json({ error: 'Artist id is required' })
  const rows = getDB().prepare(`
    SELECT t.*, CASE WHEN ${userTrackQuery(uid)} THEN 1 ELSE 0 END AS user_liked
    FROM tracks t JOIN artist_track_links atl ON atl.track_id = t.id
    WHERE atl.artist_id = ? AND t.file_path NOT LIKE 'ghost://%'
    ORDER BY t.album COLLATE NOCASE, COALESCE(t.track_num, 999999), t.title COLLATE NOCASE
  `).all(artistId)
  return res.json({ items: compactTracks(rows), total: rows.length })
})

router.get('/library/playlists', (req, res) => {
  const db = getDB()
  const uid = String(getRemoteState().userId || 'guest').slice(0, 200)
  const q = queryText(req.query.q)
  const { limit, offset } = pagination(req)
  const where = ['p.user_id = ?']
  const params = [uid]
  if (q) { where.push("p.name LIKE ?"); params.push(safeLike(q)) }
  const whereSql = where.join(' AND ')
  const rows = db.prepare(`
    SELECT p.id, p.name, p.description, p.user_id, p.smart_rules,
      (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
      (SELECT t.id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
       WHERE pt.playlist_id = p.id AND NULLIF(t.artwork_path, '') IS NOT NULL ORDER BY pt.position, link_track_key(t.artist,t.title,t.duration) LIMIT 1) AS coverTrackId
    FROM playlists p WHERE ${whereSql}
    ORDER BY p.name COLLATE NOCASE LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  const total = db.prepare(`SELECT COUNT(*) AS total FROM playlists p WHERE ${whereSql}`).get(...params)?.total || 0
  const items = rows.map(({ smart_rules, ...row }) => {
    const rules = playlistRules({ smart_rules })
    if (!rules) return { ...row, track_count: Number(row.track_count) || 0, smart: !!smart_rules }
    const smartItems = smartTracks(db, smart_rules, row.user_id)
    const coverTrack = smartItems.find(track => track?.artwork_path)
    return {
      ...row,
      track_count: smartItems.length,
      coverTrackId: coverTrack?.id || null,
      smart: true,
    }
  })
  return res.json({ items, total, limit, offset, hasMore: offset + rows.length < total })
})

router.get('/library/playlist-tracks', (req, res) => {
  const db = getDB()
  const playlistId = queryText(req.query.id)
  const uid = String(getRemoteState().userId || 'guest').slice(0, 200)
  if (!playlistId) return res.status(400).json({ error: 'Playlist id is required' })
  const playlist = db.prepare('SELECT id, user_id, smart_rules FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, uid)
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' })
  const tracks = playlistRules(playlist)
    ? smartTracks(db, playlist.smart_rules, playlist.user_id)
    : db.prepare(`
        SELECT t.* FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id
        WHERE pt.playlist_id = ? ORDER BY pt.position, link_track_key(t.artist,t.title,t.duration)
      `).all(playlistId)
  const ids = (Array.isArray(tracks) ? tracks : []).map(track => track?.id).filter(Boolean)
  if (!ids.length) return res.json({ items: [], total: 0 })
  const inClause = ids.map(() => '?').join(',')
  const existing = db.prepare(`
    SELECT t.*, CASE WHEN ${userTrackQuery(uid)} THEN 1 ELSE 0 END AS user_liked
    FROM tracks t WHERE t.id IN (${inClause})
  `).all(...ids)
  const byId = new Map(existing.map(track => [track.id, track]))
  const ordered = ids.map(id => byId.get(id)).filter(Boolean)
  return res.json({ items: compactTracks(ordered), total: ordered.length })
})

router.get('/library/liked', (req, res) => {
  const db = getDB()
  const uid = String(getRemoteState().userId || 'guest').slice(0, 200)
  // Move older streamed-song likes onto their local copies before listing;
  // otherwise excluding the ghost hides a song the user has liked.
  require('../../electron/online/sources').foldStreamedLikes(db, uid)
  const { limit, offset } = pagination(req)
  const q = queryText(req.query.q)
  const where = ['ul.user_id = ?', "t.file_path NOT LIKE 'ghost://%'"]
  const params = [uid]
  if (q) {
    const like = safeLike(q)
    where.push("(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)")
    params.push(like, like, like)
  }
  const clause = where.join(' AND ')
  const rows = db.prepare(`
    SELECT t.*, 1 AS user_liked FROM user_likes ul JOIN tracks t ON t.id = ul.track_id
    WHERE ${clause} ORDER BY ul.liked_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  const total = db.prepare(`
    SELECT COUNT(*) AS total FROM user_likes ul JOIN tracks t ON t.id = ul.track_id WHERE ${clause}
  `).get(...params)?.total || 0
  return res.json({ items: compactTracks(rows), total, limit, offset, hasMore: offset + rows.length < total })
})

router.get('/connection', (req, res) => res.json(getRemoteConnectionInfo()))

module.exports = router
