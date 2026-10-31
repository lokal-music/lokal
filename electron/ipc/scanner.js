const { mergeDuplicates, mergeAllDuplicates } = require('./mergeDuplicates')
const path = require('path')
const fs = require('fs-extra')
const fsp = require('node:fs/promises')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const { downloadImageWithTimeout } = require('../artworkDownload')
const artistRoles = require('../artistRoles')
const mm = require('../musicMetadata')
const quality = require('../quality')
const { findAudioEditionDuplicate } = require('../quality/editionDuplicates')
const addedDate = require('../addedDate')
const artistSplit = require('../artistSplit')
const { getArtistNamePreference, artistNamePreferenceNeedsRescan, rememberArtistNamePreferenceAfterScan } = require('../artistMetadataPreference')
const { getLibraryFolders, resolveLibraryFolderTarget, getTrackRowsUnderFolder, renameLibraryFolders } = require('../libraryFolder')
const { findFolderArtworkAsync, cacheFolderArtwork, folderOriginalCandidates, hasFolderOriginal, isNetworkArtworkPath, isCachedFolderArtwork } = require('../networkArtwork')
const { getDB, getStorageDir, importAppData, resetAppData } = require('./db')
const { ipcMain } = require('electron')
const { emitPluginHook } = require('./plugins')
const { applyPendingImportedMetadataToTrack, resolveGhostsByIsrc } = require('./playlists')
const { moveToTrash, removeTrackFiles, forgetDownloads } = require('./trackFiles')
const { smartTracks, smartPreview, normalizeRules, playlistRules } = require('../playlists/smart')
const { deduplicatePlaylist } = require('../playlists/deduplicate')
const { fetchCoverData } = require('../playlists/remoteCover')
const { cacheArtistMetadata, refreshArtistMetadata, startRefreshAll, refreshAllStatus, cancelRefreshAll, searchArtistMetadataCandidates, applyArtistMetadataSelection, clearArtistImageOverride } = require('./artistMetadata')
const { recordListeningEvent } = require('./recaps')
const { normalizeArtwork, writeEmbeddedArtwork } = require('../fileArtwork')
const { artistIdFromName, findArtistById, migrateUnknownArtist, resolveArtistId, trackArtistLinks } = require('../artistId')

const DEFAULT_MUSIC_PATH = 'C:\\Users\\sipbuu\\Music'
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.aac', '.opus', '.wma', '.alac', '.ape'])
const { isPreparedStemClipName } = require('../automix/stem-clip')
// Same secrets as the web server's SECRET_KEYS (server/routes/settings.js):
// masked by settings:get, left out of settings:exportAll, kept on import.
const SECRET_SETTING_KEYS = new Set(['soulseek_api_key', 'soulseek_password', 'spicylyrics_api_key', 'spotify_sp_dc', 'apple_music_user_token', 'listenbrainz_token', 'lastfm_api_secret', 'lastfm_session_key', 'yt_cookie_header'])
const SECRET_SETTING_PLACEHOLDER = '••••••••'
const DRUM_KIT_PATTERNS = /\b(kick|snare|808|hi[- ]?hat|hihat|rimshot|clap|crash|cymbal|drum( kit| loop| sample)?|sample pack|loop kit|one[- ]?shot|fx[- ]?sound|bass[- ]?drum|perc(ussion)?|stem[s]?|acapella)\b/i

function getMinDuration() {
  try {
    const db = getDB()
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'min_duration'").get()
    const value = setting?.value
    if (value !== undefined && value !== null && value !== '') {
      const parsed = parseInt(value, 10)
      if (!isNaN(parsed) && parsed >= 0) {
        return parsed
      }
    }
  } catch {}
  return 0
}

let scanStatus = { scanning: false, total: 0, done: 0, errors: 0, skipped: 0 }
let mainWindow = null

function emit(channel, data) {
  if (mainWindow) mainWindow.webContents.send(channel, data)
}

function hashFile(fp, stat) {
  return crypto.createHash('sha256').update(fp + stat.size + stat.mtimeMs).digest('hex').slice(0, 16)
}

function getKeepCommaArtists() {
  const keepComma = new Set([
    'tyler, the creator', 'earth, wind & fire', 'crosby, stills & nash',
    'crosby, stills, nash & young', 'simon & garfunkel', 'emerson, lake & palmer',
    'syd barrett', 'pete & bas', 'pe & ne',
  ])
  try {
    const db = getDB()
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()
    if (setting?.value) {
      const userDefined = JSON.parse(setting.value)
      userDefined.forEach(a => keepComma.add(a.toLowerCase().trim()))
    }
  } catch {}
  return keepComma
}

function splitArtists(raw, keepComma = null) {
  if (!raw) return []
  const db = getDB()
  artistSplit.applySplitWordsFrom(db)
  const keep = keepComma || getKeepCommaArtists()
  return artistSplit.splitArtists(raw, artistSplit.keepCommaSet([...keep]))
}
// Tracks whose artist links were changed by hand (Manage > rename, merge,
// delete): their links no longer follow the artist text, on purpose, so the
// re-link pass leaves them alone. Editing the song's artist, or its file
// changing, re-parses the links and lifts this again.
function ensureLinkLocks(db) {
  db.exec('CREATE TABLE IF NOT EXISTS artist_link_locks (track_id TEXT PRIMARY KEY)')
}
function lockArtistLinks(db, artistId) {
  ensureLinkLocks(db)
  db.prepare('INSERT OR IGNORE INTO artist_link_locks (track_id) SELECT track_id FROM artist_track_links WHERE artist_id = ?').run(artistId)
}
function artistLinksLocked(db, trackId) {
  try { return Boolean(db.prepare('SELECT 1 FROM artist_link_locks WHERE track_id = ?').get(trackId)) } catch { return false }
}
function unlockArtistLinks(db, trackId) {
  try { db.prepare('DELETE FROM artist_link_locks WHERE track_id = ?').run(trackId) } catch {}
}

// Bump when splitArtists changes how it reads names, so the next scan re-links
// the library once (see relinkArtistsIfNeeded).
// 3: version 2 also linked streamed (ghost://) tracks; this undoes that.
// 4: artist ids keep non-Latin letters (every Japanese name was "a-unknown").
const ARTIST_SPLITTER_VERSION = 5

/**
 * Brings every track's artist links in line with splitArtists (e.g. after it
 * learned that "h x m x d" is one artist, not h, m and d), then drops the
 * artists left without tracks. A rescan skips unchanged files, so this is
 * what fixes songs already in the library. Only tracks whose links differ
 * are touched. Streamed songs (ghost:// tracks) are never linked to artists,
 * so an artist's page and count only ever mean songs in the library.
 */
function relinkArtists(db = getDB()) {
  const keepComma = getKeepCommaArtists()
  ensureLinkLocks(db)
  migrateUnknownArtist(db)
  const tracks = db.prepare("SELECT id, artist FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND id NOT IN (SELECT track_id FROM artist_link_locks)").all()
  const linked = new Map()
  for (const row of db.prepare('SELECT track_id, artist_id FROM artist_track_links').all()) {
    if (!linked.has(row.track_id)) linked.set(row.track_id, new Set())
    linked.get(row.track_id).add(row.artist_id)
  }
  const byExactName = db.prepare('SELECT id FROM artists WHERE name = ? LIMIT 1')
  const byName = db.prepare('SELECT id FROM artists WHERE name = ? COLLATE NOCASE LIMIT 1')
  const byId = db.prepare('SELECT id FROM artists WHERE id = ?')
  const unlink = db.prepare('DELETE FROM artist_track_links WHERE track_id = ?')
  const addArtist = db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)')
  const rename = db.prepare('UPDATE OR IGNORE artists SET name = ? WHERE id = ? AND name <> ?')
  const link = db.prepare('INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)')
  const resolved = new Map()
  // The artist row a name belongs to: the one already carrying that name
  // (names are unique, so its id may not be the slug of this spelling), else
  // the one with its slug ("A.B" and "A B"), else a new row. Null only if no
  // row could be made, so a link never points at a missing artist.
  const artistIdFor = (name) => {
    const key = name.toLowerCase()
    if (resolved.has(key)) return resolved.get(key)
    const slugId = artistIdFromName(name)
    let id = byExactName.get(name)?.id || byName.get(name)?.id
    if (!id) {
      addArtist.run(slugId, name)
      id = byId.get(slugId)?.id || null
    }
    resolved.set(key, id)
    return id
  }
  let changed = 0
  db.transaction(() => {
    // Links to streamed songs, or to songs no longer in the library.
    changed += db.prepare(`DELETE FROM artist_track_links WHERE track_id NOT IN (SELECT id FROM tracks WHERE file_path NOT LIKE 'ghost://%')`).run().changes || 0
    for (const track of tracks) {
      const names = splitArtists(track.artist, keepComma)
      const want = new Map()
      for (const name of names) {
        const id = artistIdFor(name)
        if (id && !want.has(id)) want.set(id, name)
      }
      const have = linked.get(track.id) || new Set()
      if (want.size === have.size && [...want.keys()].every(id => have.has(id))) continue
      unlink.run(track.id)
      for (const [id, name] of want) {
        // Same artist spelled differently ("ARTIST" -> "Artist"): the row
        // takes this track's spelling, as a scan would.
        if (byName.get(name)?.id === id) rename.run(name, id, name)
        link.run(id, track.id)
      }
      changed++
    }
    if (changed) db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM artist_track_links)').run()
  })()
  return changed
}

/**
 * relinkArtists, but only when the splitter or the keep-comma list changed
 * since the last pass, so a routine scan doesn't walk every track.
 */
function relinkArtistsIfNeeded(db = getDB()) {
  const keepComma = db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()?.value || '[]'
  const splitWords = JSON.stringify(artistSplit.applySplitWordsFrom(db))
  const fingerprint = `${ARTIST_SPLITTER_VERSION}:${keepComma}:${splitWords}`
  const last = db.prepare("SELECT value FROM settings WHERE key = 'artist_relink_fingerprint'").get()?.value
  if (last === fingerprint) return 0
  const changed = relinkArtists(db)
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('artist_relink_fingerprint', ?)").run(fingerprint)
  return changed
}

async function extractArtwork(metadata, trackId, fallbackArtwork = null) {
  const pic = metadata.common.picture?.[0]
  if (pic) {
    // Lists and player controls use small WebP thumbnails. Fullscreen views
    // read the embedded original from the audio file only when needed.
    return require('../artwork/thumb').writeCover(path.join(getStorageDir(), 'artwork'), trackId, pic.data)
  }
  return fallbackArtwork || null
}

// `failures` collects folders that could not be read, so a scan can tell it
// missed files instead of looking complete.
async function walkDir(dir, files = [], failures = null) {
  // SMB/WebDAV mounts may take seconds to reply or disappear mid-scan.
  // Never perform directory enumeration synchronously in Electron's main
  // thread, and avoid a recursive JS stack on deeply nested NAS libraries.
  const { withTimeout } = require('./networkLibrary')
  const pending = [dir]
  const visited = new Set()
  while (pending.length) {
    const current = pending.pop()
    if (visited.has(current)) continue
    visited.add(current)
    let entries
    try {
      entries = await withTimeout(fsp.readdir)(current, { withFileTypes: true })
    } catch (error) {
      failures?.push(current)
      console.warn('[scanner] Folder enumeration failed:', current, error.message)
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile() && !isPreparedStemClipName(entry.name) &&
          AUDIO_EXTS.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  return files
}

function isDrumKit(title, album, genre) {
  if (DRUM_KIT_PATTERNS.test(title)) return true
  if (album && DRUM_KIT_PATTERNS.test(album)) return true
  if (genre && /drum|percussion|sample|sfx/i.test(genre)) return true
  return false
}

function getSkipDrumKit() {
  try {
    const db = getDB()
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'skip_drumkit_pattern'").get()
    return setting?.value === '1'
  } catch {}
  return false
}

function preferCleanDownloadMetadata() {
  try {
    const db = getDB()
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'clean_download_metadata'").get()
    return setting?.value !== '0'
  } catch {}
  return true
}

function isKnownCommaArtist(name) {
  if (!name) return false
  const lower = name.toLowerCase().trim()
  const keepCommaArtists = getKeepCommaArtists()
  for (const known of keepCommaArtists) {
    if (lower === known) return true
  }
  return false
}

function scoreArtistCandidate(name, rawArtist) {
  if (!name) return -Infinity
  if (isKnownCommaArtist(name)) return 1000 - name.length
  const commaParts = name.split(/\s*,\s*/).filter(Boolean)
  let score = 0
  score += commaParts.length === 1 ? 40 : 0
  score -= Math.max(0, commaParts.length - 1) * 18
  score -= Math.max(0, name.length - 24) * 0.35
  if (!/\s+(?:feat\.|ft\.|featuring)\s+/i.test(name)) score += 4
  if (!/\s+(?:&|x|vs\.?)\s+/i.test(name)) score += 2
  if (name.toLowerCase() === (rawArtist || '').toLowerCase()) score += 3
  return score
}

// `preference` ('0' / '1') pins the choice for a whole scan; without it the
// live setting is read.
function pickPreferredArtist(common, preference = null) {
  const rawArtist = (common.artist || common.albumartist || '').trim()
  if (!rawArtist) return null
  const clean = preference == null ? preferCleanDownloadMetadata() : preference !== '0'
  if (!clean || isKnownCommaArtist(rawArtist)) return rawArtist

  const rawParts = rawArtist.split(/\s*,\s*/).map(part => part.trim()).filter(Boolean)
  const candidates = []
  if (common.albumartist?.trim()) candidates.push(common.albumartist.trim())
  if (Array.isArray(common.artists)) {
    for (const artist of common.artists) {
      if (artist?.trim()) candidates.push(artist.trim())
    }
  }
  candidates.push(rawArtist)

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))]
  let best = uniqueCandidates[0] || rawArtist
  let bestScore = scoreArtistCandidate(best, rawArtist)
  for (const candidate of uniqueCandidates.slice(1)) {
    const score = scoreArtistCandidate(candidate, rawArtist)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  if (rawParts.length >= 3) {
    if (best && best !== rawArtist) return best
    return rawParts[0]
  }

  if (best && best !== rawArtist && bestScore >= scoreArtistCandidate(rawArtist, rawArtist) + 10) {
    return best
  }

  return rawArtist
}

function extractTitleFromFilename(filePath) {
  const basename = path.basename(filePath, path.extname(filePath))
  const cleaned = basename
    .replace(/^\d+[\s._-]*/, '')
    .replace(/[\[\(]\d+[\]\)]/, '')
    .replace(/\s*[-_]\s*$/, '')
    .trim()
  if (cleaned.length > 2) return cleaned
  return null
}

function extractArtistFromFolder(filePath) {
  const folderName = path.basename(path.dirname(filePath))
  if (!folderName || folderName === '.' || folderName === path.sep) return null
  const cleaned = folderName.trim()
  return cleaned.length > 0 ? cleaned : null
}

function bindValues(values) {
  return values.map(value => value === undefined ? null : value)
}

function dbValue(value) {
  if (value === undefined || Number.isNaN(value)) return null
  if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null).join(', ')
  if (typeof value === 'object' && value !== null) return String(value)
  return value
}

function trackParams(item, trackId = item?.id) {
  return {
    id: dbValue(trackId),
    file_path: dbValue(item?.file_path),
    file_hash: dbValue(item?.file_hash),
    title: dbValue(item?.title),
    artist: dbValue(item?.artist),
    album: dbValue(item?.album),
    album_artist: dbValue(item?.album_artist),
    track_num: dbValue(item?.track_num),
    year: dbValue(item?.year),
    genre: dbValue(item?.genre),
    duration: dbValue(item?.duration),
    artwork_path: dbValue(item?.artwork_path),
    bitrate: dbValue(item?.bitrate),
    last_modified: dbValue(item?.last_modified),
    replaygain: dbValue(item?.replaygain),
  }
}

function configuredMusicFolders(db = getDB()) {
  const plural = db.prepare("SELECT value FROM settings WHERE key = 'music_folders'").get()?.value
  let values = []
  try { values = Array.isArray(JSON.parse(plural || 'null')) ? JSON.parse(plural) : [] } catch {}
  if (!values.length) {
    const legacy = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value
    if (legacy) values = [legacy]
  }
  const seen = new Set()
  return values.filter(value => typeof value === 'string' && value.trim()).map(value => path.resolve(value.trim())).filter(value => {
    if (seen.has(value.toLowerCase())) return false
    seen.add(value.toLowerCase())
    return true
  })
}

async function scanFolders(folderPaths = []) {
  const db = getDB()
  const folders = []
  const onlineFolders = []
  const offlineFolders = []
  const previous = new Set(configuredMusicFolders(db).map(root => root.toLowerCase()))
  const seen = new Set()
  for (const value of Array.isArray(folderPaths) ? folderPaths : []) {
    if (typeof value !== 'string' || !value.trim()) continue
    const full = path.resolve(value.trim())
    if (seen.has(full.toLowerCase())) continue
    let available = false
    try {
      available = (await require('./networkLibrary')
        .withTimeout(fsp.stat)(full)).isDirectory()
    } catch {}
    if (!available && !previous.has(full.toLowerCase())) continue
    seen.add(full.toLowerCase())
    folders.push(full)
    if (available) onlineFolders.push(full)
    else offlineFolders.push(full)
  }
  if (!folders.length) return { error: 'Choose at least one existing music folder', folders: configuredMusicFolders(db) }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folders', ?)").run(JSON.stringify(folders))
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folder', ?)").run(folders[0])
  // Snapshot the preference once for all roots; otherwise the first root could
  // save the checkpoint and make later roots skip their unchanged files.
  const artistNamePreference = getArtistNamePreference(db)
  const forceArtistNameRefresh = artistNamePreferenceNeedsRescan(db, artistNamePreference)
  const results = []
  for (const folder of onlineFolders) {
    results.push(await scanFolder(folder, {
      saveRoot: false,
      watch: false,
      forceArtistNameRefresh,
      persistArtistNamePreference: false,
      artistNamePreference,
    }))
  }
  // Persist only after all roots scan without file errors, so a failed rescan
  // is retried next time.
  rememberArtistNamePreferenceAfterScan(db, artistNamePreference, results)
  // Scanning a folder must not replace the selected root list or leave only
  // the last folder watched.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folders', ?)").run(JSON.stringify(folders))
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folder', ?)").run(folders[0])
  try { require('../libraryWatcher').watchLibraryRoots(onlineFolders) } catch (error) { console.warn('[scanner] Library watchers not started:', error.message) }
  // Retain offline mounted shares so a temporary NAS outage cannot silently
  // erase the configured roots. Reconnect and rescan when the host returns.
  return { folders, offlineFolders, results, status: scanStatus }
}

function scansEveryRoot(db, folderPath) {
  const roots = configuredMusicFolders(db).map(root => path.resolve(root).toLowerCase())
  return roots.every(root => root === path.resolve(folderPath).toLowerCase())
}

async function scanFolder(folderPath, {
  saveRoot = true,
  watch = true,
  forceArtistNameRefresh = null,
  persistArtistNamePreference = true,
  artistNamePreference = null,
  onInventory = null,
} = {}) {
  const db = getDB()
  // Artist text depends on this preference as well as file metadata/mtime.
  const scanPreference = artistNamePreference ?? getArtistNamePreference(db)
  const refreshArtistNames = forceArtistNameRefresh == null
    ? artistNamePreferenceNeedsRescan(db, scanPreference)
    : Boolean(forceArtistNameRefresh)
  try { db.exec("ALTER TABLE tracks ADD COLUMN replaygain TEXT") } catch {}
  scanStatus = { scanning: true, total: 0, done: 0, errors: 0, skipped: 0 }
  try {
    const relinked = relinkArtistsIfNeeded(db)
    if (relinked) console.log(`[scanFolder] Re-linked artists for ${relinked} track(s)`)
  } catch (e) { console.warn('[scanFolder] Artist re-link skipped:', e.message) }
  const walkFailures = []
  const files = await walkDir(folderPath, [], walkFailures)
  // Watcher reconciliation needs the exact same snapshot. Walking a NAS
  // twice adds avoidable I/O and can observe a different set of files if the
  // mount disconnects between the two enumerations.
  if (typeof onInventory === 'function') onInventory(files, walkFailures)
  scanStatus.errors += walkFailures.length
  scanStatus.total = files.length
  const PROGRESS_INTERVAL_MS = 100
  const PROGRESS_EVERY_FILES = 20
  let lastProgressAt = 0
  const emitProgress = (force = false, complete = false) => {
    const now = Date.now()
    if (!force && scanStatus.done % PROGRESS_EVERY_FILES !== 0 && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
    lastProgressAt = now
    emit('scanner:progress', { ...scanStatus, ...(complete ? { complete: true } : {}) })
  }
  if (saveRoot) {
    const folder = path.resolve(folderPath)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folder', ?)").run(folder)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('music_folders', ?)").run(JSON.stringify([folder]))
  }
  if (watch && saveRoot) {
    try { require('../libraryWatcher').watchLibraryRoots(configuredMusicFolders(db)) } catch (e) { console.warn('[scanner] Library watcher not started:', e.message) }
  }

  const linkArtist = db.prepare(`INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)`)
  const findExistingTrackByPath = db.prepare('SELECT id FROM tracks WHERE file_path = ?')
  const insertTrack = db.prepare(`
    INSERT INTO tracks
    (id, file_path, file_hash, title, artist, album, album_artist, track_num, year, genre, duration, artwork_path, bitrate, last_modified, replaygain)
    VALUES (@id, @file_path, @file_hash, @title, @artist, @album, @album_artist, @track_num, @year, @genre, @duration, @artwork_path, @bitrate, @last_modified, @replaygain)
  `)
  const updateTrackByPath = db.prepare(`
    UPDATE tracks
    SET file_hash = @file_hash, title = @title, artist = @artist, album = @album, album_artist = @album_artist, track_num = @track_num, year = @year, genre = @genre, duration = @duration, artwork_path = @artwork_path, bitrate = @bitrate, last_modified = @last_modified, replaygain = @replaygain
    WHERE file_path = @file_path
  `)

  const insertBatchTransaction = db.transaction((items) => {
    for (const item of items) {
      const existing = findExistingTrackByPath.get(item.file_path)
      const trackId = existing?.id || item.id
      item.id = trackId
      const params = trackParams(item, trackId)
      if (existing) {
        updateTrackByPath.run(params)
      } else {
        insertTrack.run(params)
      }
      addedDate.applyToRow(db, trackId, item.added)
      if (item.quality) quality.saveFields(db, trackId, item.quality, { fileChanged: true })
      db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId)
      unlockArtistLinks(db, trackId)
      const artistNames = splitArtists(item.artist)
      for (const name of artistNames) {
        const aid = resolveArtistId(db, name)
        try {
          linkArtist.run(aid, trackId)
        } catch (linkErr) {
          console.warn(`[scanFolder] Failed to link artist ${aid} to track ${trackId}:`, linkErr.message)
        }
      }
      applyPendingImportedMetadataToTrack(db, trackId)
      resolveGhostsByIsrc(db, trackId)
    }
  })
  const insertBatch = async (items) => {
    insertBatchTransaction(items)
    // New entries without a LOKAL_ADDED tag take the library's date and write
    // it into the file. Existing entries are deliberately not re-dated.
    const toStamp = items.filter(item => item.isNew && item.added == null).map(item => item.file_path)
    if (toStamp.length) {
      const stamped = await addedDate.stampAddedDates(db, toStamp)
      if (stamped.failed) console.warn(`[scanFolder] Date-added tag write failed for ${stamped.failed} file(s)`)
    }
    // Run hook calls together for this bounded DB batch, rather than making
    // each indexed track wait for the previous plugin round-trip.
    await Promise.all(items.map(item => emitPluginHook('onTrackIndexed', {
      id: item.id,
      title: item.title,
      artist: item.artist,
      album: item.album,
      genre: item.genre,
      duration: item.duration,
      filePath: item.file_path,
    })))
  }

  // Only network roots need durable folder-image copies. Local folders keep
  // their existing full-resolution cover.jpg / folder.png path, even after the
  // SMB/WebDAV support is enabled. Connected mounted shares are recorded by
  // the network-library handler; UNC paths are detected independently.
  let networkRoots = []
  try {
    const json = db.prepare("SELECT value FROM settings WHERE key = 'network_music_folders'").get()?.value
    const saved = JSON.parse(json || '[]')
    if (Array.isArray(saved)) networkRoots = saved.filter(value => typeof value === 'string')
  } catch {}
  const BATCH = 20
  let batch = []
  const folderArtworkCache = new Map()
  const durableFolderArtworkCache = new Map()
  const getFolderArtwork = (filePath) => {
    const folderPath = path.dirname(filePath)
    if (!folderArtworkCache.has(folderPath)) {
      folderArtworkCache.set(folderPath, findFolderArtworkAsync(folderPath))
    }
    return folderArtworkCache.get(folderPath)
  }
  const getDurableFolderArtwork = (sourcePath) => {
    if (!sourcePath) return null
    if (!durableFolderArtworkCache.has(sourcePath)) {
      durableFolderArtworkCache.set(sourcePath, cacheFolderArtwork(
        sourcePath, path.join(getStorageDir(), 'artwork')))
    }
    return durableFolderArtworkCache.get(sourcePath)
  }

  for (const filePath of files) {
    try {
      const stat = await require('./networkLibrary').withTimeout(fsp.stat)(filePath)
      const trackId = 't-' + hashFile(filePath, stat)
      const existing = db.prepare('SELECT id, last_modified, artwork_path FROM tracks WHERE file_path = ?').get(filePath)
      const networkArtwork = isNetworkArtworkPath(filePath, networkRoots)
      // A refresh re-reads unchanged files, but not ones whose artist the user
      // changed by hand (rename/merge/delete lock their links).
      const refreshThis = refreshArtistNames && !(existing && artistLinksLocked(db, existing.id))
      const existingArtwork = existing?.artwork_path ? path.resolve(existing.artwork_path) : null
      const storedArtworkDir = path.resolve(getStorageDir(), 'artwork')
      // Only stat app-owned artwork synchronously. A legacy UNC path can hang
      // the Electron main thread when its NAS stops responding.
      const hasCachedArtwork = existingArtwork &&
        path.dirname(existingArtwork) === storedArtworkDir &&
        fs.existsSync(existingArtwork)
      if (!refreshThis && existing && existing.last_modified === stat.mtimeMs &&
          hasCachedArtwork && !isCachedFolderArtwork(existingArtwork)) {
        // Valid app-owned embedded art takes precedence over folder art.
        // No need to re-enumerate the remote directory for every album on
        // every refresh just to rediscover a cover that will not be used.
        scanStatus.done++; emitProgress(); continue
      }
      const folderArtwork = await getFolderArtwork(filePath)
      if (!refreshThis && existing && existing.last_modified === stat.mtimeMs) {
        const hasCurrentFolderArtwork = folderArtwork && existingArtwork === path.resolve(folderArtwork)
        const noArtworkToUpdate = !existingArtwork && !folderArtwork
        if (hasCurrentFolderArtwork) {
          if (networkArtwork) {
            // Previously indexed network folders may still point at a share
            // that disappears after disconnect. Make a durable copy once.
            const durable = await getDurableFolderArtwork(folderArtwork)
            if (durable) {
              db.prepare('UPDATE tracks SET artwork_path = ? WHERE file_path = ?')
                .run(durable, filePath)
            }
          }
          // Local folder art is already its full original: never downgrade it.
          scanStatus.done++; emitProgress(); continue
        }
        if (hasCachedArtwork || noArtworkToUpdate) {
          // Upgrade already indexed local songs that were incorrectly routed
          // through the NAS 150px thumbnail cache. This is a lightweight DB
          // update; no audio file rescan or metadata rewrite is needed.
          if (!networkArtwork && hasCachedArtwork && folderArtwork &&
              isCachedFolderArtwork(existingArtwork)) {
            db.prepare('UPDATE tracks SET artwork_path = ? WHERE file_path = ?')
              .run(folderArtwork, filePath)
          } else if (networkArtwork && hasCachedArtwork && folderArtwork &&
              folderOriginalCandidates(existingArtwork).length &&
              !hasFolderOriginal(existingArtwork)) {
            // Network thumbnails created before this fix have no full-size
            // companion; repair it once on a reachable share.
            const durable = await getDurableFolderArtwork(folderArtwork)
            if (durable && durable !== existing.artwork_path) {
              db.prepare('UPDATE tracks SET artwork_path = ? WHERE file_path = ?')
                .run(durable, filePath)
            }
          }
          scanStatus.done++; emitProgress(); continue
        }
      }
      // Promise.race cannot cancel a stalled NAS read or its tokenizer.
      // A reusable worker is terminated on timeout, retaining random access.
      const meta = await require('./scannerMetadata')
        .parseWithDeadline(filePath, { duration: true, skipCovers: false }, 20000)
      const c = meta.common
      const rawTitle = c.title?.trim()
      const rawArtist = pickPreferredArtist(c, scanPreference)
      const title = rawTitle || extractTitleFromFilename(filePath)
      const artist = rawArtist || extractArtistFromFolder(filePath)
      const duration = meta.format.duration || 0
      if (!title || !artist) { console.log(`[scanFolder] Skipped: ${filePath} - Could not derive both title and artist`); scanStatus.skipped++; scanStatus.done++; emitProgress(); continue }
      if (!rawTitle && title) console.log(`[scanFolder] Fallback title from filename: ${filePath} -> "${title}"`)
      if (!rawArtist && artist) console.log(`[scanFolder] Fallback artist from folder: ${filePath} -> "${artist}"`)
      const minDuration = getMinDuration()
      if (duration < minDuration) { console.log(`[scanFolder] Skipped: ${filePath} - Too short (${duration}s)`); scanStatus.skipped++; scanStatus.done++; emitProgress(); continue }
      if (getSkipDrumKit() && isDrumKit(title, c.album, c.genre?.[0])) { console.log(`[scanFolder] Skipped: ${filePath} - Drumkit pattern detected`); scanStatus.skipped++; scanStatus.done++; emitProgress(); continue }
      // Prefer an app-owned copy of the folder cover: UNC/WebDAV paths may
      // disappear when the NAS sleeps. Preserve any existing readable artwork
      // when transient server failures prevent a new extraction.
      const localFolderArtwork = meta.common.picture?.length
        ? null : networkArtwork
          ? await getDurableFolderArtwork(folderArtwork)
          : folderArtwork
      let previousArtwork = null
      if (existingArtwork) {
        if (networkArtwork && isNetworkArtworkPath(existingArtwork, networkRoots)) {
          // Legacy database rows may still point directly at remote cover
          // files. Check them asynchronously with a deadline, not existsSync.
          try {
            const info = await require('./networkLibrary').withTimeout(fsp.stat)(existingArtwork)
            if (info.isFile()) previousArtwork = existingArtwork
          } catch {}
        } else if (fs.existsSync(existingArtwork)) {
          previousArtwork = existingArtwork
        }
      }
      const artwork = await extractArtwork(
        meta, trackId, localFolderArtwork || previousArtwork || folderArtwork)
      const replaygain = c.replaygain_track_gain || null
      const audioQuality = quality.qualityFields(meta)
      audioQuality.atmos_verified = await quality.probeAtmosFile(filePath, { codec: audioQuality.codec })
      batch.push({ id: trackId, file_path: filePath, file_hash: trackId, title, artist, album: c.album?.trim() || 'Unknown Album', album_artist: c.albumartist?.trim() || null, track_num: c.track?.no || null, year: c.year || null, genre: c.genre?.[0] || null, duration, artwork_path: artwork, bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null, last_modified: stat.mtimeMs, replaygain, quality: audioQuality, added: addedDate.fromMeta(meta), isNew: !existing })
      if (batch.length >= BATCH) { await insertBatch(batch); batch = [] }
    } catch { scanStatus.errors++ }
    scanStatus.done++; emitProgress()
  }
  if (batch.length > 0) await insertBatch(batch)
  scanStatus.scanning = false; emitProgress(true, true)
  // The checkpoint covers the whole library, so a scan of one root (a watcher
  // or an incremental update) must not save it while other roots are stale.
  if (persistArtistNamePreference && scansEveryRoot(db, folderPath)) {
    rememberArtistNamePreferenceAfterScan(db, scanPreference, scanStatus)
  }
  return scanStatus
}

function addArtistFallback(db, artist) {
  if (artist.image_path) return artist
  const firstTrack = db.prepare(`SELECT t.artwork_path FROM tracks t JOIN artist_track_links atl ON atl.track_id = t.id WHERE atl.artist_id = ? AND t.artwork_path IS NOT NULL ORDER BY t.play_count DESC LIMIT 1`).get(artist.id)
  return { ...artist, image_path: firstTrack?.artwork_path || null }
}

const { searchLyricsEntries } = require('../lyrics/librarySearch')

/**
 * Library > Source: where songs came from. 'local' is the music folder's own
 * files (never downloaded in Lokal), 'addon' any addon, and 'yt', 'sc',
 * 'soulseek', 'web' those downloads. Anything else: no filter.
 */
function sourceFilter(source) {
  if (source === 'local') return { sql: 'download_source IS NULL', params: [] }
  if (source === 'addon') return { sql: "download_source LIKE 'a-%'", params: [] }
  if (['yt', 'sc', 'mono', 'soulseek', 'web', 'mobile'].includes(source)) return { sql: 'download_source = ?', params: [source] }
  return null
}

/**
 * Library > Genre: songs with that genre, as their main genre or one of
 * their genres ("J-Pop, City Pop"), ignoring case. Nothing given: no filter.
 */
function genreFilter(genre) {
  const value = String(genre || '').trim()
  if (!value) return null
  if (value === '__none__') return { sql: "lokal_has_genre(genre, genres, '') = 1", params: [] }
  return { sql: 'lokal_has_genre(genre, genres, ?) = 1', params: [value] }
}

/** Profile numbers for a user (the desktop app and the web server share it). */
function userStats(db, userId) {
  const uid = userId || 'guest'
  try { db.exec('ALTER TABLE play_history ADD COLUMN seconds_played INTEGER DEFAULT 0') } catch {}
  const totalPlays = db.prepare(`SELECT COUNT(*) as c FROM play_history WHERE user_id = ? AND COALESCE(seconds_played, 999) >= 30`).get(uid)?.c || 0
  const totalSecs = db.prepare(`SELECT SUM(COALESCE(seconds_played, 0)) as s FROM play_history WHERE user_id = ?`).get(uid)?.s || 0
  const topArtists = db.prepare(`SELECT t.artist, COUNT(*) as plays FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ph.user_id = ? AND COALESCE(ph.seconds_played, 999) >= 30 GROUP BY t.artist ORDER BY plays DESC LIMIT 5`).all(uid)
  const topTracks = db.prepare(`SELECT t.*, COUNT(*) as plays FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ph.user_id = ? AND COALESCE(ph.seconds_played, 999) >= 30 GROUP BY t.id ORDER BY plays DESC LIMIT 5`).all(uid)
  const topGenres = db.prepare(`SELECT t.genre, COUNT(*) as plays FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ph.user_id = ? AND t.genre IS NOT NULL AND COALESCE(ph.seconds_played, 999) >= 30 GROUP BY t.genre ORDER BY plays DESC LIMIT 5`).all(uid)
  const likedCount = db.prepare('SELECT COUNT(*) as c FROM user_likes WHERE user_id = ?').get(uid)?.c || 0
  const weeklyPlays = db.prepare(`SELECT COUNT(*) as c FROM play_history WHERE user_id = ? AND played_at > unixepoch() - 604800 AND COALESCE(seconds_played, 999) >= 30`).get(uid)?.c || 0
  return { totalPlays, totalMinutes: Math.round(totalSecs / 60), topArtists, topTracks, topGenres, likedCount, weeklyPlays }
}

function getArtistsPage(db, opts = {}) {
  const limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 60))
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0)
  const rawSearch = typeof opts.search === 'string' ? opts.search.trim() : ''
  const sort = opts.sort === 'tracks' ? 'tracks' : 'name'
  const mainOnly = opts.mainOnly === true || opts.mainOnly === '1'
  const params = []
  const conditions = []
  const groupBy = 'GROUP BY a.id'
  const having = 'HAVING COUNT(DISTINCT t.id) > 0'
  const orderBy = sort === 'tracks' ? 'ORDER BY track_count DESC, a.name ASC' : 'ORDER BY a.name ASC'

  if (rawSearch) {
    conditions.push('a.name LIKE ?')
    params.push('%' + rawSearch + '%')
  }
  if (opts.followed === true || opts.followed === '1') {
    const followed = require('../followedArtistIds').followedCondition(db)
    conditions.push(followed.sql)
    params.push(followed.param)
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const baseSql = [
    'FROM artists a',
    'LEFT JOIN artist_track_links atl ON atl.artist_id = a.id',
    "LEFT JOIN tracks t ON t.id = atl.track_id AND t.file_path NOT LIKE 'ghost://%'",
  ].join('\n')
  const selectSql = [
    'SELECT a.*, COUNT(DISTINCT t.id) as track_count',
    baseSql, where, groupBy, having, orderBy,
  ].filter(Boolean).join('\n')

  let rows
  let total
  if (mainOnly) {
    const mainIds = artistRoles.mainOnlyArtistIds(db)
    const eligible = db.prepare(selectSql).all(...params).filter(artist => mainIds.has(String(artist.id)))
    total = eligible.length
    rows = eligible.slice(offset, offset + limit)
  } else {
    rows = db.prepare(selectSql + '\nLIMIT ? OFFSET ?').all(...params, limit, offset)
    total = db.prepare([
      'SELECT COUNT(*) as total FROM (',
      'SELECT a.id', baseSql, where, groupBy, having,
      ') grouped_artists',
    ].filter(Boolean).join('\n')).get(...params)?.total || 0
  }

  return {
    items: rows.map(artist => addArtistFallback(db, artist)),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  }
}

function scoreTrack(track) {
  let score = 0
  if (track.bitrate) score += track.bitrate / 100
  if (track.artwork_path) score += 10
  if (track.album) score += 5
  if (track.year) score += 3
  if (track.genre) score += 2
  return score
}

function normalizeAlbumTracks(tracks = []) {
  const total = Array.isArray(tracks) ? tracks.length : 0
  const validNumbered = tracks.filter((track) => {
    const value = Number(track?.track_num)
    return Number.isInteger(value) && value > 0 && value !== 63
  })
  const useTrackNumbers = validNumbered.length >= Math.max(2, Math.ceil(total * 0.4))

  const sorted = [...tracks].sort((left, right) => {
    const leftTrack = Number(left?.track_num)
    const rightTrack = Number(right?.track_num)
    const leftValid = Number.isInteger(leftTrack) && leftTrack > 0 && leftTrack !== 63
    const rightValid = Number.isInteger(rightTrack) && rightTrack > 0 && rightTrack !== 63

    if (useTrackNumbers && leftValid !== rightValid) return leftValid ? -1 : 1
    if (useTrackNumbers && leftValid && rightValid && leftTrack !== rightTrack) return leftTrack - rightTrack

    const titleCompare = String(left?.title || '').localeCompare(String(right?.title || ''), undefined, { sensitivity: 'base' })
    if (titleCompare !== 0) return titleCompare
    return String(left?.file_path || '').localeCompare(String(right?.file_path || ''), undefined, { sensitivity: 'base' })
  })

  return sorted.map((track, index) => {
    const trackNum = Number(track?.track_num)
    const valid = Number.isInteger(trackNum) && trackNum > 0 && trackNum !== 63
    return {
      ...track,
      display_track_num: useTrackNumbers && valid ? trackNum : index + 1,
    }
  })
}

function splitGenreValues(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)
}

function scoreRelatedTrack(baseTrack, candidate) {
  let score = 0
  const sameArtist = candidate.artist && baseTrack.artist && candidate.artist.toLowerCase() === baseTrack.artist.toLowerCase()
  if (sameArtist) score += 14
  if (candidate.album && baseTrack.album && candidate.album.toLowerCase() === baseTrack.album.toLowerCase()) score += sameArtist ? 4 : 2
  const baseGenres = splitGenreValues(baseTrack.genres || baseTrack.genre)
  const candidateGenres = new Set(splitGenreValues(candidate.genres || candidate.genre))
  let sharedGenres = 0
  for (const genre of baseGenres) {
    if (candidateGenres.has(genre)) {
      sharedGenres += 1
      score += sameArtist ? 2.5 : 3.5
    }
  }
  const numericFields = ['danceability', 'energy', 'valence', 'acousticness', 'instrumentalness', 'liveness', 'speechiness']
  let strongFeatureMatches = 0
  for (const field of numericFields) {
    const left = Number(baseTrack[field])
    const right = Number(candidate[field])
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue
    const diff = Math.abs(left - right)
    if (diff <= 0.08) strongFeatureMatches += 1
    score += Math.max(0, 2.5 - diff * 10)
  }
  const tempoA = Number(baseTrack.tempo)
  const tempoB = Number(candidate.tempo)
  if (Number.isFinite(tempoA) && Number.isFinite(tempoB)) {
    score += Math.max(0, 2 - Math.abs(tempoA - tempoB) / 15)
  }
  if (!sameArtist && sharedGenres > 0 && strongFeatureMatches >= 2) score += 4
  if (baseTrack.explicit && candidate.explicit) score += 0.5
  return score
}

function classifyAlbumRow(row) {
  const trackCount = Number(row?.release_track_count ?? row?.track_count ?? 0)
  if (trackCount <= 1) return 'single'
  if (trackCount <= 6) return 'ep'
  return 'album'
}

function enrichAlbumRows(rows = []) {
  return rows.map(({ cover, ...row }) => {
    // cover = "<track number>\t<artwork path>\t<track id>" (see albumRowsQuery).
    const [, artworkPath = null, artworkTrackId = null] = String(cover || '').split('\t')
    return { ...row, artwork_path: artworkPath, artwork_track_id: artworkTrackId, release_type: classifyAlbumRow(row) }
  })
}

function normalizeAlbumIdentity(input) {
  if (input && typeof input === 'object') {
    return {
      title: String(input.title || input.album || '').trim(),
      albumArtist: String(input.album_artist || input.albumArtist || '').trim(),
    }
  }
  return { title: String(input || '').trim(), albumArtist: '' }
}

function albumRowsQuery(where = '', groupPrefix = '') {
  return `
    SELECT
      album as title,
      COALESCE(NULLIF(album_artist, ''), artist) as album_artist,
      -- The cover: the first track (by number) that has one. A bare
      -- artwork_path took whichever row SQLite picked (with MAX(added_at),
      -- the newest track), so an album whose newest song had no embedded
      -- cover showed none even when its other songs had one.
      MIN(CASE WHEN NULLIF(artwork_path, '') IS NOT NULL
        THEN printf('%06d', COALESCE(track_num, 999999)) || char(9) || artwork_path || char(9) || id END) as cover,
      MAX(year) as year,
      MAX(added_at) as added_at,
      COUNT(*) as track_count,
      GROUP_CONCAT(DISTINCT artist) as artists
    FROM tracks ${groupPrefix}
    WHERE file_path NOT LIKE 'ghost://%'
      AND album IS NOT NULL
      ${where}
    GROUP BY LOWER(album), LOWER(COALESCE(NULLIF(album_artist, ''), artist))
  `
}

function normalizeDuplicateText(value, type = 'title') {
  let normalized = String(value || '').toLowerCase()
    .replace(/\[[^\]]*\]|\([^\)]*\)/g, ' ')
    .replace(/\s+(feat\.|ft\.|featuring)\s+.*$/i, ' ')
  if (type === 'title') {
    normalized = normalized.replace(/\b(remaster(ed)?|radio edit|clean|explicit|album version|single version|extended mix|original mix|bonus track|deluxe)\b/g, ' ')
  }
  return normalized.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenizeDuplicateText(value, type = 'title') {
  return normalizeDuplicateText(value, type).split(' ').filter(Boolean)
}

function overlapScore(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) return 0
  const left = new Set(leftTokens)
  const right = new Set(rightTokens)
  let shared = 0
  for (const token of left) {
    if (right.has(token)) shared += 1
  }
  return shared / Math.max(1, Math.min(left.size, right.size))
}

function durationSimilarity(leftDuration, rightDuration) {
  const diff = Math.abs(Number(leftDuration || 0) - Number(rightDuration || 0))
  if (diff > 4) return 0
  return Math.max(0, 1 - diff / 4)
}

function possibleDuplicateMatch(left, right) {
  const titleScore = overlapScore(left.titleTokens, right.titleTokens)
  const artistScore = overlapScore(left.artistTokens, right.artistTokens)
  const durationScore = durationSimilarity(left.duration, right.duration)
  const exactNormalized = left.normalizedTitle === right.normalizedTitle && left.normalizedArtist === right.normalizedArtist
  if (exactNormalized) return null
  const combined = titleScore * 0.45 + artistScore * 0.45 + durationScore * 0.1
  const isMatch = durationScore > 0 && artistScore >= 0.72 && (titleScore >= 0.58 || combined >= 0.74)
  if (!isMatch) return null
  return {
    titleScore,
    artistScore,
    durationDiff: Math.abs(Number(left.duration || 0) - Number(right.duration || 0)),
    combined,
  }
}

function buildPossibleDuplicateGroups(tracks = []) {
  if (!Array.isArray(tracks) || tracks.length < 2) return []
  // Ghosts retain streaming/history metadata, not another music file. They
  // must not be offered as duplicate files or as suggested keep candidates.
  const enriched = tracks.filter(track =>
    typeof track?.file_path === 'string' && track.file_path.trim() &&
    !/^ghost:\/\//i.test(track.file_path.trim())
  ).map(track => {
    const titleTokens = tokenizeDuplicateText(track.title, 'title')
    const artistTokens = tokenizeDuplicateText(track.artist, 'artist')
    return {
      ...track,
      qualityScore: scoreTrack(track),
      normalizedTitle: normalizeDuplicateText(track.title, 'title'),
      normalizedArtist: normalizeDuplicateText(track.artist, 'artist'),
      titleTokens,
      artistTokens,
      artistKey: artistTokens[0] || '',
      durationBucket: Math.round(Number(track.duration || 0) / 2),
    }
  }).filter(track => track.artistKey && track.titleTokens.length)
    .map((track, index) => ({ ...track, index }))

  const buckets = new Map()
  for (const track of enriched) {
    const bucketKey = `${track.artistKey}:${track.durationBucket}`
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, [])
    buckets.get(bucketKey).push(track)
  }

  const parent = enriched.map((_, index) => index)
  const find = (value) => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]]
      value = parent[value]
    }
    return value
  }
  const union = (left, right) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }

  const pairMeta = new Map()
  const seenPairs = new Set()
  for (const track of enriched) {
    for (let offset = -1; offset <= 1; offset += 1) {
      const bucketKey = `${track.artistKey}:${track.durationBucket + offset}`
      const candidates = buckets.get(bucketKey) || []
      for (const candidate of candidates) {
        if (candidate.index <= track.index) continue
        const pairKey = `${track.index}:${candidate.index}`
        if (seenPairs.has(pairKey)) continue
        seenPairs.add(pairKey)
        const match = possibleDuplicateMatch(track, candidate)
        if (!match) continue
        union(track.index, candidate.index)
        pairMeta.set(pairKey, match)
      }
    }
  }

  const grouped = new Map()
  for (const track of enriched) {
    const root = find(track.index)
    if (!grouped.has(root)) grouped.set(root, [])
    grouped.get(root).push(track)
  }

  return [...grouped.values()]
    .filter(group => group.length > 1)
    .map((group, index) => {
      const sortedTracks = [...group].sort((left, right) => right.qualityScore - left.qualityScore)
      const scores = []
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const key = `${Math.min(group[i].index, group[j].index)}:${Math.max(group[i].index, group[j].index)}`
          const meta = pairMeta.get(key)
          if (meta) scores.push(meta)
        }
      }
      const avg = scores.length ? scores.reduce((sum, item) => sum + item.combined, 0) / scores.length : 0
      const bestTitle = scores.length ? Math.max(...scores.map(item => item.titleScore)) : 0
      const bestArtist = scores.length ? Math.max(...scores.map(item => item.artistScore)) : 0
      const maxDurationDiff = scores.length ? Math.max(...scores.map(item => item.durationDiff)) : 0
      return {
        id: `possible-${index}-${sortedTracks[0].id}`,
        confidence: Math.round(avg * 100),
        suggestedKeepId: sortedTracks[0].id,
        summary: `Title ${(bestTitle * 100).toFixed(0)}% · Artist ${(bestArtist * 100).toFixed(0)}% · Δ ${maxDurationDiff.toFixed(1)}s`,
        tracks: sortedTracks.map(track => ({
          ...track,
          qualityScore: undefined,
          normalizedTitle: undefined,
          normalizedArtist: undefined,
          titleTokens: undefined,
          artistTokens: undefined,
          artistKey: undefined,
          durationBucket: undefined,
          index: undefined,
        })),
      }
    })
    .sort((left, right) => right.confidence - left.confidence)
}

function applyBatchField(currentValue, operation) {
  if (!operation || operation.mode === 'ignore') return { changed: false, value: currentValue }
  if (operation.mode === 'clear') return { changed: currentValue !== null && currentValue !== '', value: null }
  if (operation.mode === 'removeText') {
    const currentText = String(currentValue ?? '')
    const needle = String(operation.value ?? '')
    if (!needle) return { changed: false, value: currentValue }
    const nextText = currentText.split(needle).join('').trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'keepAfterText') {
    const currentText = String(currentValue ?? '')
    const needle = String(operation.value ?? '')
    if (!needle) return { changed: false, value: currentValue }
    const index = currentText.indexOf(needle)
    if (index === -1) return { changed: false, value: currentValue }
    const nextText = currentText.slice(index + needle.length).trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'keepBeforeText') {
    const currentText = String(currentValue ?? '')
    const needle = String(operation.value ?? '')
    if (!needle) return { changed: false, value: currentValue }
    const index = currentText.indexOf(needle)
    if (index === -1) return { changed: false, value: currentValue }
    const nextText = currentText.slice(0, index).trim()
    return { changed: nextText !== currentText, value: nextText || null }
  }
  if (operation.mode === 'fillMissing') {
    const missing = currentValue === null || currentValue === undefined || String(currentValue) === ''
    return missing ? { changed: true, value: operation.value ?? null } : { changed: false, value: currentValue }
  }
  if (operation.mode === 'replace') {
    const nextValue = operation.value ?? null
    return { changed: currentValue !== nextValue, value: nextValue }
  }
  return { changed: false, value: currentValue }
}

function normalizeGenresForBatch(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .join(', ') || null
}

function firstGenreForBatch(value) {
  return normalizeGenresForBatch(value)?.split(',').map(part => part.trim()).filter(Boolean)[0] || null
}

function clearLyricsStateForTrack(db, trackId, filePath = null) {
  db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId)
  db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(trackId)
  if (filePath) {
    try { db.prepare('DELETE FROM lyrics_cache WHERE file_path = ?').run(filePath) } catch {}
  }
}

function collectAllGenres(db) {
  // Match desktop suggestions to the cleaned Genres page and filters.
  const { genres } = require('../genreList').genreSummary(db)
  return genres.map(item => item.name).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
}

async function applyBatchTrackUpdates(db, trackIds = [], operations = {}) {
  if (!Array.isArray(trackIds) || !trackIds.length) return []
  const ids = [...new Set(trackIds.filter(Boolean))]
  const tracks = ids.map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean)
  if (!tracks.length) return []

  const artworkOp = operations.artwork
  const artworkPaths = new Map()
  if (artworkOp?.mode === 'replace' && artworkOp?.value) {
    const normalized = await normalizeArtwork(artworkOp.value)
    for (const track of tracks) {
      const nextArtPath = await require('../artwork/thumb').writeCover(
        path.join(getStorageDir(), 'artwork'), String(track.id), normalized, { overwrite: true }
      )
      artworkPaths.set(track.id, nextArtPath)
    }
  }

  const patch = db.transaction(() => {
    const updatedIds = []
    for (const track of tracks) {
      const updates = []
      const params = []
      const nextValues = {}
      const fields = ['title', 'artist', 'album', 'album_artist', 'track_num', 'year', 'genre', 'genres', 'record_label', 'explicit', 'instrumental']
      for (const field of fields) {
        const result = applyBatchField(track[field], operations[field])
        if (result.changed) {
          updates.push(`${field} = ?`)
          params.push(result.value)
          nextValues[field] = result.value
        }
      }
      const hasGenreUpdate = Object.prototype.hasOwnProperty.call(nextValues, 'genre')
      const hasGenresUpdate = Object.prototype.hasOwnProperty.call(nextValues, 'genres')
      if (hasGenreUpdate || hasGenresUpdate) {
        const normalizedGenres = hasGenresUpdate
          ? normalizeGenresForBatch(nextValues.genres)
          : normalizeGenresForBatch(track.genres || nextValues.genre || track.genre)
        const primaryGenre = hasGenreUpdate
          ? (nextValues.genre || firstGenreForBatch(normalizedGenres))
          : firstGenreForBatch(normalizedGenres)

        delete nextValues.genre
        delete nextValues.genres
        updates.push('genre = ?')
        params.push(primaryGenre || null)
        nextValues.genre = primaryGenre || null
        updates.push('genres = ?')
        params.push(normalizedGenres)
        nextValues.genres = normalizedGenres
      }
      if (artworkOp?.mode === 'clear' && track.artwork_path) {
        updates.push('artwork_path = ?')
        params.push(null)
      } else if (artworkOp?.mode === 'replace' && artworkOp?.value) {
        updates.push('artwork_path = ?')
        params.push(artworkPaths.get(track.id) || path.join(getStorageDir(), 'artwork', `${track.id}.jpg`))
      }
      if (!updates.length) continue
      params.push(track.id)
      db.prepare(`UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`).run(...params)
      updatedIds.push(track.id)

      if (nextValues.instrumental === 1) {
        clearLyricsStateForTrack(db, track.id, track.file_path)
      }

      if (Object.prototype.hasOwnProperty.call(nextValues, 'artist')) {
        db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(track.id)
        unlockArtistLinks(db, track.id)
        const artistNames = splitArtists(nextValues.artist)
        for (const name of artistNames) {
          const artistId = resolveArtistId(db, name)
          db.prepare('INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)').run(artistId, track.id)
        }
      }
    }
    db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM artist_track_links)').run()
    return updatedIds
  })

  const updatedIds = patch()
  return updatedIds.map(id => db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)).filter(Boolean)
}

function toDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const ext = path.extname(filePath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
}

async function writePlaylistCover(playlistId, imageData) {
  if (!imageData) return null
  const base64 = String(imageData).split(',')[1] || ''
  const mime = String(imageData).match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/i)?.[1] || 'image/jpeg'
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
  const coverPath = path.join(getStorageDir(), 'artwork', `playlist-${playlistId}.${ext}`)
  await fs.writeFile(coverPath, Buffer.from(base64, 'base64'))
  return coverPath
}

function exportAppData() {
  const db = getDB()
  const theme = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()?.value || 'dark'
  let themeOverrides = {}
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'theme_overrides'").get()?.value
    themeOverrides = raw ? JSON.parse(raw) : {}
  } catch {}
  const users = db.prepare('SELECT id, username, display_name, avatar_path, bio, created_at, password_hash FROM users ORDER BY created_at DESC').all().map((user) => ({
    ...user,
    avatar_data: toDataUrl(user.avatar_path),
  }))
  return {
    exported_at: Date.now(),
    version: 1,
    theme,
    theme_overrides: themeOverrides,
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().filter(row => !SECRET_SETTING_KEYS.has(row.key)).map(row => [row.key, row.value])),
    users,
    user_settings: db.prepare('SELECT user_id, key, value FROM user_settings ORDER BY user_id, key').all(),
    playlists: db.prepare('SELECT * FROM playlists ORDER BY created_at DESC').all().map((playlist) => ({
      ...playlist,
      cover_data: toDataUrl(playlist.cover_path),
    })),
    playlist_tracks: db.prepare('SELECT * FROM playlist_tracks ORDER BY playlist_id, position, id').all(),
    user_likes: db.prepare('SELECT * FROM user_likes ORDER BY user_id, liked_at DESC').all(),
    play_history: db.prepare('SELECT * FROM play_history ORDER BY played_at DESC').all(),
    listening_events: db.prepare('SELECT * FROM listening_events ORDER BY created_at DESC').all(),
    artists: db.prepare('SELECT * FROM artists ORDER BY name').all(),
    artist_track_links: db.prepare('SELECT * FROM artist_track_links ORDER BY artist_id, track_id').all(),
    tracks: db.prepare('SELECT * FROM tracks ORDER BY added_at DESC').all(),
  }
}

function registerScannerHandlers(ipcMain) {
  const { BrowserWindow } = require('electron')
  try { require('../genreList').registerGenreFunctions(getDB()) } catch (error) { console.warn('[scanner] Genre filters unavailable:', error.message) }
  ipcMain.handle('scanner:scan', async (e, folder) => { mainWindow = BrowserWindow.fromWebContents(e.sender); return scanFolder(folder || DEFAULT_MUSIC_PATH) })
  ipcMain.handle('scanner:scanFolders', async (e, folders) => { mainWindow = BrowserWindow.fromWebContents(e.sender); return scanFolders(folders) })
  ipcMain.handle('scanner:connectNetworkShare', async (e, input) => {
    const { probeNetworkLibraryLocation } = require('../networkShare')
    const { folder } = await probeNetworkLibraryLocation(input)
    const roots = configuredMusicFolders()
    if (!roots.some(root => root.toLowerCase() === folder.toLowerCase())) roots.push(folder)
    mainWindow = BrowserWindow.fromWebContents(e.sender)
    return scanFolders(roots)
  })
  ipcMain.handle('scanner:status', () => scanStatus)
  ipcMain.handle('scanner:artworkRepairStatus', () => require('../artwork/repairDownloads').artworkRepairStatus())
  ipcMain.handle('scanner:artworkRepairCancel', () => require('../artwork/repairDownloads').cancelArtworkRepair())
  ipcMain.handle('scanner:artworkRepair', (event) =>
    require('../artwork/repairDownloads').repairLowQualityDownloads({
      db: getDB(),
      artworkDir: path.join(getStorageDir(), 'artwork'),
      onProgress: (status) => {
        if (!event.sender.isDestroyed()) event.sender.send('scanner:artworkRepairProgress', status)
      },
    }))

  ipcMain.handle('scanner:getTrackFileSize', (_, trackId) => {
    const filePath = getDB().prepare('SELECT file_path FROM tracks WHERE id = ?').get(String(trackId || ''))?.file_path
    if (!filePath || String(filePath).startsWith('ghost://')) return { bytes: null }
    try {
      const stat = fs.statSync(filePath)
      return { bytes: stat.isFile() ? stat.size : null }
    } catch { return { bytes: null } }
  })
  ipcMain.handle('scanner:getLibraryFolders', (_, relativePath, search, rootPath) => getLibraryFolders(getDB(), relativePath, search, rootPath))

  ipcMain.handle('scanner:renameLibraryFolders', (e, changes, rootPath) => {
    try {
      const result = renameLibraryFolders(getDB(), changes, rootPath)
      try { e.sender.send('library:changed', { operation: 'folders-renamed', changes: result.renamed }) } catch {}
      return result
    } catch (error) {
      return { error: error?.message || 'Could not rename folders' }
    }
  })
  ipcMain.handle('scanner:deleteLibraryFolders', async (e, relativePaths, rootPath) => {
    const db = getDB()
    if (!Array.isArray(relativePaths) || relativePaths.length < 1 || relativePaths.length > 300) {
      return { error: 'Select between 1 and 300 folders to delete', deleted: [], failed: [] }
    }
    let targets
    try {
      targets = relativePaths.map(relativePath => resolveLibraryFolderTarget(db, relativePath, rootPath))
      const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
      if (new Set(targets.map(target => pathKey(target.targetPath))).size !== targets.length) {
        throw new Error('A folder was selected more than once')
      }
      if (new Set(targets.map(target => pathKey(target.parentPath))).size !== 1) {
        throw new Error('Select folders from the same directory')
      }
    } catch (error) {
      return { error: error?.message || 'Could not validate folders', deleted: [], failed: [] }
    }

    const prepared = targets.map(target => ({ target, rows: getTrackRowsUnderFolder(db, target.targetPath) }))
    const deleted = []
    const failed = []
    for (const item of prepared) {
      try {
        await moveToTrash(item.target.targetPath)
        deleted.push(item)
      } catch (error) {
        failed.push({ path: item.target.relativePath, error: error?.message || 'Could not move folder to Trash' })
      }
    }

    const ids = [...new Set(deleted.flatMap(item => item.rows.map(row => row.id)).filter(Boolean))]
    if (ids.length) {
      try {
        const removeRows = db.transaction(trackIds => {
          for (const trackId of trackIds) {
            db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId)
            db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(trackId)
            db.prepare('DELETE FROM user_likes WHERE track_id = ?').run(trackId)
            db.prepare('DELETE FROM play_history WHERE track_id = ?').run(trackId)
            try { db.prepare('DELETE FROM listening_events WHERE track_id = ?').run(trackId) } catch {}
            db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId)
            try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(trackId) } catch {}
            db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)
          }
        })
        removeRows(ids)
        forgetDownloads(ids)
      } catch (error) {
        return {
          success: false,
          deleted: deleted.map(item => item.target.relativePath),
          failed: [...failed, { path: '', error: 'Folder moved to Trash, but library cleanup failed: ' + (error?.message || 'unknown error') }],
        }
      }
    }
    try {
      e.sender.send('library:changed', { operation: 'folders-deleted', paths: deleted.map(item => item.target.relativePath) })
    } catch {}
    return { success: failed.length === 0, deleted: deleted.map(item => item.target.relativePath), failed }
  })
  ipcMain.handle('scanner:getGenreSummary', () => { const db = getDB(); require('../genreList').registerGenreFunctions(db); return require('../genreList').genreSummary(db) })
  ipcMain.handle('scanner:resolveFileToPlay', async (_, filePath) => {
    const db = getDB()
    const existing = db.prepare("SELECT * FROM tracks WHERE file_path = ?").get(filePath)
    if (existing) return { success: true, track: existing }
    const result = await indexSingleFile(filePath)
    if (result?.id) {
      const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(result.id)
      if (track) return { success: true, track }
    }
    return { success: false, error: result?.error || 'Could not index file' }
  })
  ipcMain.handle('scanner:getMissingTracks', () => {
    const db = getDB()
    return db.prepare("SELECT id, title, artist, album, duration, source_ref, file_path FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND file_path IS NOT NULL").all()
      .filter(track => !fs.existsSync(track.file_path))
      .map(track => ({ ...track, missing: true }))
  })
  ipcMain.handle('scanner:getTracks', (_, opts = {}) => {
    const db = getDB()
    const where = []; const params = []
    // Songs with errors include streamed ones whose playback failed.
    const files = require('../trackErrors').truthy(opts.problems) ? null : require('../libraryTracks').trackFileFilter(opts.includeGhosts)
    if (files) where.push(files)
    if (opts.id) { where.push('id = ?'); params.push(opts.id) }
    if (Array.isArray(opts.ids) && opts.ids.length) {
      const ids = [...new Set(opts.ids.map(id => String(id || '').trim()).filter(Boolean))].slice(0, 5000)
      if (ids.length) { where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids) }
    }
    if (opts.artistName) { where.push('artist = ?'); params.push(opts.artistName) }
    if (opts.artistId) { where.push('id IN (SELECT track_id FROM artist_track_links WHERE artist_id = ?)'); params.push(opts.artistId) }
    const search = String(opts.search || '').trim()
    if (search) {
      const { wordsMatch, TRACK_COLUMNS } = require('../librarySearch')
      const match = wordsMatch(search, TRACK_COLUMNS)
      if (match) { where.push(match.sql); params.push(...match.params) }
    }
    const source = sourceFilter(opts.source)
    if (source) { where.push(source.sql); params.push(...source.params) }
    const genre = genreFilter(opts.genre)
    if (genre) { where.push(genre.sql); params.push(...genre.params) }
    const quality = opts.quality ? require('../quality').tierFilter(db, opts.quality) : null
    if (quality) { where.push(quality.sql); params.push(...quality.params) }
    if (opts.format) {
      const match = String(opts.format).match(/^(16|24|32)-(\d{5,6})$/)
      if (match) { where.push('bit_depth = ? AND sample_rate = ?'); params.push(Number(match[1]), Number(match[2])) }
    }
    return require('../trackErrors').listTracks(db, opts, { where, params, exists: fs.existsSync })
  })
  ipcMain.handle('tracks:reportError', (_, trackId, message) => { try { return require('../trackErrors').recordTrackError(getDB(), trackId, message) } catch { return false } })
  ipcMain.handle('tracks:clearError', (_, trackId) => { try { return require('../trackErrors').clearTrackError(getDB(), trackId) } catch { return false } })
  ipcMain.handle('scanner:getArtists', () => {
    const db = getDB()
    const artists = db.prepare(`SELECT a.*, COUNT(DISTINCT atl.track_id) as track_count FROM artists a LEFT JOIN artist_track_links atl ON atl.artist_id = a.id LEFT JOIN tracks t ON t.id = atl.track_id AND t.file_path NOT LIKE 'ghost://%' GROUP BY a.id HAVING COUNT(DISTINCT t.id) > 0 ORDER BY a.name`).all()
    return artists.map(artist => addArtistFallback(db, artist))
  })
  ipcMain.handle('scanner:getArtistsPage', (_, opts = {}) => {
    const db = getDB()
    return getArtistsPage(db, opts)
  })
  ipcMain.handle('scanner:getArtist', (_, id) => {
    const db = getDB()
    let artist = findArtistById(db, id)
    if (!artist) return null
    const tracks = db.prepare(`SELECT t.* FROM tracks t JOIN artist_track_links atl ON atl.track_id = t.id WHERE atl.artist_id = ? AND t.file_path NOT LIKE 'ghost://%' ORDER BY t.album, t.track_num, t.title`).all(artist.id)
    const topTracks = db.prepare(`SELECT t.* FROM tracks t JOIN artist_track_links atl ON atl.track_id = t.id WHERE atl.artist_id = ? AND t.file_path NOT LIKE 'ghost://%' ORDER BY t.play_count DESC LIMIT 5`).all(artist.id)
    const albums = enrichAlbumRows(db.prepare(`
      SELECT
        t.album as title,
        COALESCE(NULLIF(t.album_artist, ''), t.artist) as album_artist,
        t.year,
        t.artwork_path,
        COUNT(*) as track_count,
        (SELECT COUNT(*) FROM tracks full_release
          WHERE LOWER(full_release.album) = LOWER(t.album)
            AND LOWER(COALESCE(NULLIF(full_release.album_artist, ''), full_release.artist)) = LOWER(COALESCE(NULLIF(t.album_artist, ''), t.artist))
            AND full_release.file_path NOT LIKE 'ghost://%') as release_track_count,
        GROUP_CONCAT(DISTINCT t.artist) as artists
      FROM tracks t
      JOIN artist_track_links atl ON atl.track_id = t.id
      WHERE atl.artist_id = ?
        AND t.file_path NOT LIKE 'ghost://%'
        AND t.album IS NOT NULL
      GROUP BY LOWER(t.album), LOWER(COALESCE(NULLIF(t.album_artist, ''), t.artist))
      ORDER BY t.year DESC, t.album ASC
    `).all(artist.id)).map(album => ({ ...album, is_main_artist: artistRoles.isMainArtistRelease(artist.name, album, tracks, db) }))
    const artistWithFallback = addArtistFallback(db, artist)
    return { ...artistWithFallback, tracks, topTracks, albums }
  })
  ipcMain.handle('artist:refreshMetadata', async (_, artistId, opts = {}) => {
    const db = getDB()
    const artist = findArtistById(db, artistId)
    if (!artist) return null
    const force = opts?.force === true
    if (!force) {
      const enabled = db.prepare("SELECT value FROM settings WHERE key = 'auto_fetch_artist_metadata'").get()?.value === '1'
      if (!enabled) return addArtistFallback(db, artist)
    }
    // overwrite: replace what was fetched before (Manage > Lookup > auto match);
    // otherwise only what's missing is filled in.
    if (opts?.overwrite === true) {
      await refreshArtistMetadata(db, artist, { source: opts.source })
      return addArtistFallback(db, findArtistById(db, artistId) || artist)
    }
    const refreshed = await cacheArtistMetadata(db, artist, opts || {})
    return addArtistFallback(db, refreshed)
  })
  ipcMain.handle('artists:refreshAllMetadata', (_, opts = {}) => startRefreshAll(getDB(), { source: opts?.source }))
  ipcMain.handle('artists:refreshAllStatus', () => refreshAllStatus())
  ipcMain.handle('artists:refreshAllCancel', () => cancelRefreshAll())
  ipcMain.handle('artist:searchMetadata', async (_, query, opts = {}) => searchArtistMetadataCandidates(query, opts || {}))
  ipcMain.handle('artist:applyMetadataSelection', async (_, artistId, selection, mode) => {
    const db = getDB()
    const updated = await applyArtistMetadataSelection(db, artistId, selection, { mode })
    return updated ? addArtistFallback(db, updated) : null
  })
  ipcMain.handle('artist:clearImageOverride', (_, artistId) => {
    const db = getDB()
    const updated = clearArtistImageOverride(db, artistId)
    return updated ? addArtistFallback(db, updated) : null
  })
  ipcMain.handle('scanner:getAlbumTracks', (_, albumInput) => {
    const album = normalizeAlbumIdentity(albumInput)
    if (!album.title) return []
    const params = [album.title]
    let sql = "SELECT * FROM tracks WHERE album = ? AND file_path NOT LIKE 'ghost://%'"
    if (album.albumArtist) {
      sql += " AND LOWER(COALESCE(NULLIF(album_artist, ''), artist)) = LOWER(?)"
      params.push(album.albumArtist)
    }
    const tracks = getDB().prepare(sql).all(...params)
    return normalizeAlbumTracks(tracks)
  })
  ipcMain.handle('scanner:search', (_, q) => {
    const db = getDB()
    // Every word in one of the fields, in any order (electron/librarySearch.js).
    const { searchTracks, searchArtists } = require('../librarySearch')
    const tracks = searchTracks(db, q, 40)
    const artistsWithFallback = searchArtists(db, q, tracks).map(artist => addArtistFallback(db, artist))
    return { artists: artistsWithFallback, tracks }
  })
  ipcMain.handle('scanner:searchLyrics', (_, q) => {
    return searchLyricsEntries(getDB(), q)
  })
  // A streamed song you already have is that song: see toggleSongLike.
  ipcMain.handle('scanner:toggleLike', (_, trackId, userId) => require('../online/sources').toggleSongLike(getDB(), userId || 'guest', trackId))
  ipcMain.handle('scanner:setLike', (_, trackId, userId, liked) => require('../online/sources').setSongLike(getDB(), userId || 'guest', trackId, !!liked))
  ipcMain.handle('scanner:getLikedTracks', (_, userId) => {
    const db = getDB()
    const { songIds, foldStreamedLikes } = require('../online/sources')
    foldStreamedLikes(db, userId || 'guest')
    // also_ids: the other ids each song goes by, so its heart shows everywhere.
    return db.prepare(`SELECT t.* FROM tracks t JOIN user_likes ul ON ul.track_id = t.id WHERE ul.user_id = ? ORDER BY ul.liked_at DESC`).all(userId || 'guest')
      .map(t => ({ ...t, also_ids: songIds(db, t.id).filter(id => id !== t.id) }))
  })
  ipcMain.handle('scanner:incrementPlay', (_, trackId, userId) => { const db = getDB(); const uid = userId || 'guest'; db.prepare('UPDATE tracks SET play_count = play_count + 1 WHERE id = ?').run(trackId); db.prepare('INSERT INTO play_history (user_id, track_id) VALUES (?, ?)').run(uid, trackId) })
  ipcMain.handle('scanner:getHistory', (_, userId, limit) => getDB().prepare(`SELECT t.*, ph.played_at FROM tracks t JOIN play_history ph ON ph.track_id = t.id WHERE ph.user_id = ? ORDER BY ph.played_at DESC LIMIT ?`).all(userId || 'guest', limit || 30))
  ipcMain.handle('scanner:getSuggestions', (_, userId) => {
    const db = getDB(); const uid = userId || 'guest'
    const liked = db.prepare(`SELECT t.genre, t.artist FROM tracks t JOIN user_likes ul ON ul.track_id = t.id WHERE ul.user_id = ? LIMIT 20`).all(uid)
    const genres = [...new Set(liked.map(t => t.genre).filter(Boolean))]
    const artists = [...new Set(liked.map(t => t.artist).filter(Boolean))]
    if (!genres.length && !artists.length) return db.prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' ORDER BY RANDOM() LIMIT 20").all()
    return db.prepare(`SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND (genre IN (${genres.map(() => '?').join(',') || "''"}) OR artist IN (${artists.map(() => '?').join(',') || "''"})) ORDER BY RANDOM() LIMIT 20`).all(...genres, ...artists)
  })
  ipcMain.handle('scanner:getPlaylists', (_, userId) => getDB().prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY name').all(userId || 'guest'))
  ipcMain.handle('scanner:createPlaylist', (_, name, userId, description) => {
    const db = getDB()
    const id = 'pl-' + Date.now()
    const uid = userId || 'guest'
    db.prepare('INSERT INTO playlists (id, name, user_id, description, cover_path) VALUES (?, ?, ?, ?, ?)').run(id, name, uid, description || null, null)
    return db.prepare('SELECT * FROM playlists WHERE id = ?').get(id)
  })
  ipcMain.handle('scanner:updatePlaylist', async (_, plId, data) => {
    const db = getDB()
    const existing = db.prepare('SELECT * FROM playlists WHERE id = ?').get(plId)
    if (!existing) return { error: 'Playlist not found' }
    if (data.name !== undefined) db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(data.name, plId)
    if (data.description !== undefined) db.prepare('UPDATE playlists SET description = ? WHERE id = ?').run(data.description, plId)
    // Smart playlist rules (null: a regular playlist again).
    if (data.smartRules !== undefined) {
      const rules = data.smartRules === null ? null : normalizeRules(data.smartRules)
      db.prepare('UPDATE playlists SET smart_rules = ? WHERE id = ?').run(rules ? JSON.stringify(rules) : null, plId)
    }
    // coverURL: a cover from the web (a saved YouTube Music mix's).
    const coverData = data.coverData || (data.coverURL ? await fetchCoverData(data.coverURL) : null)
    if (coverData) {
      if (existing.cover_path && fs.existsSync(existing.cover_path)) {
        try { fs.removeSync(existing.cover_path) } catch {}
      }
      const coverPath = await writePlaylistCover(plId, coverData)
      db.prepare('UPDATE playlists SET cover_path = ? WHERE id = ?').run(coverPath, plId)
    }
    if (data.clearCover) {
      if (existing.cover_path && fs.existsSync(existing.cover_path)) {
        try { fs.removeSync(existing.cover_path) } catch {}
      }
      db.prepare('UPDATE playlists SET cover_path = ? WHERE id = ?').run(null, plId)
    }
    return db.prepare('SELECT * FROM playlists WHERE id = ?').get(plId)
  })
  ipcMain.handle('scanner:addToPlaylist', (_, plId, trackId, userId) => { 
    const db = getDB() 
    const uid = userId || 'guest'
    const max = db.prepare('SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id = ?').get(plId)
    // A streamed song you already have: the playlist gets the library copy.
    const id = require('../online/sources').libraryTrackId(db, trackId)
    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(plId, id, (max?.m || 0) + 1, uid, Date.now()) 
  })
  ipcMain.handle('scanner:removeFromPlaylist', (_, plId, rowId) => {
    
    getDB().prepare('DELETE FROM playlist_tracks WHERE id = ?').run(rowId)
  })
  ipcMain.handle('scanner:getPlaylistTracks', (_, plId) => {
    const db = getDB()
    const playlist = db.prepare('SELECT user_id, smart_rules FROM playlists WHERE id = ?').get(plId)
    if (playlistRules(playlist)) return smartTracks(db, playlist.smart_rules, playlist.user_id)
    return db.prepare(`SELECT t.*, pt.id as playlist_track_id, pt.added_by, pt.added_at FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id WHERE pt.playlist_id = ? ORDER BY pt.position, link_track_key(t.artist,t.title,t.duration)`).all(plId)
  })
  ipcMain.handle('playlist:smartPreview', (_, rules, userId) => {
    try { return smartPreview(getDB(), rules, userId) } catch (e) { return { error: e.message } }
  })
  ipcMain.handle('scanner:deletePlaylist', (_, plId) => {
    const db = getDB()
    const playlist = db.prepare('SELECT cover_path FROM playlists WHERE id = ?').get(plId)
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(plId)
    db.prepare('DELETE FROM playlists WHERE id = ?').run(plId)
    if (playlist?.cover_path && fs.existsSync(playlist.cover_path)) {
      try { fs.removeSync(playlist.cover_path) } catch {}
    }
  })
  ipcMain.handle('scanner:reorderPlaylist', (_, plId, trackIds) => {
    const db = getDB()
    if (!Array.isArray(trackIds)) return { error: 'trackIds must be an array' }
    const stmt = db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?')
    trackIds.forEach((trackId, index) => {
      stmt.run(index + 1, plId, trackId)
    })
    return { ok: true }
  })
  ipcMain.handle('scanner:deduplicatePlaylist', (_, plId) => deduplicatePlaylist(getDB(), plId))
  ipcMain.handle('artist:updateBio', (_, artistId, bio) => getDB().prepare('UPDATE artists SET bio = ?, bio_source = ?, bio_fetched_at = ? WHERE id = ?').run(bio, 'manual', Date.now(), artistId))
  ipcMain.handle('artist:setImage', async (_, artistId, imageData) => { const buf = Buffer.from(imageData.split(',')[1], 'base64'); const imgPath = path.join(getStorageDir(), 'artwork', `artist-${artistId}.jpg`); await fs.writeFile(imgPath, buf); getDB().prepare('UPDATE artists SET image_path = ?, image_source = ?, image_fetched_at = ? WHERE id = ?').run(imgPath, 'manual', Date.now(), artistId); return imgPath })
  ipcMain.handle('artist:forTrack', (_, trackId) => trackArtistLinks(getDB(), trackId))
  ipcMain.handle('artist:rename', (_, artistId, newName) => { const db = getDB(); lockArtistLinks(db, artistId); const newId = artistIdFromName(newName); db.prepare('UPDATE tracks SET artist = ? WHERE artist = (SELECT name FROM artists WHERE id = ?)').run(newName, artistId); db.prepare('UPDATE artists SET id = ?, name = ? WHERE id = ?').run(newId, newName, artistId); db.prepare('UPDATE artist_track_links SET artist_id = ? WHERE artist_id = ?').run(newId, artistId) })
  ipcMain.handle('artist:merge', (_, sourceId, targetId) => {
    const db = getDB();
    const target = db.prepare('SELECT name FROM artists WHERE id = ?').get(targetId);
    const source = db.prepare('SELECT name FROM artists WHERE id = ?').get(sourceId);
    if (!target || !source) return;
    lockArtistLinks(db, sourceId);
    const performMerge = db.transaction(() => {
      db.prepare('UPDATE tracks SET artist = ? WHERE artist = ?').run(target.name, source.name);
      db.prepare(`
        INSERT OR IGNORE INTO artist_track_links (artist_id, track_id)
        SELECT ?, track_id FROM artist_track_links WHERE artist_id = ?
      `).run(targetId, sourceId);
      db.prepare('DELETE FROM artist_track_links WHERE artist_id = ?').run(sourceId);
      db.prepare('DELETE FROM artists WHERE id = ?').run(sourceId);
    });

    try {
      performMerge();
      return { success: true };
    } catch (err) {
      console.error('Merge failed:', err);
      throw err;
    }
  });
  ipcMain.handle('artist:delete', (_, artistId) => { const db = getDB(); lockArtistLinks(db, artistId); db.prepare('DELETE FROM artist_track_links WHERE artist_id = ?').run(artistId); db.prepare('DELETE FROM artists WHERE id = ?').run(artistId) })
  ipcMain.handle('track:setArtwork', async (_, trackId, imageData) => {
    const db = getDB()
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(trackId || ''))
    if (!track) return { error: 'Track not found' }
    try {
      const buf = await normalizeArtwork(imageData)
      const filePath = String(track.file_path || '')
      const hasLocalFile = path.isAbsolute(filePath) && !filePath.startsWith('ghost://')
      if (hasLocalFile) {
        if (!fs.existsSync(filePath)) return { error: 'The audio file is missing; artwork was not changed.' }
        // Write the cover into the audio's own metadata, so other music players
        // see the new image too. Don't report success if this step fails.
        writeEmbeddedArtwork(filePath, buf)
        require('../fileStamp').noteFileWritten(db, filePath)
      }
      const artPath = await require('../artwork/thumb').writeCover(path.join(getStorageDir(), 'artwork'), String(trackId), buf, { overwrite: true })
      db.prepare('UPDATE tracks SET artwork_path = ? WHERE id = ?').run(artPath, trackId)
      return db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) || null
    } catch (error) {
      console.error('[track:setArtwork] Could not replace artwork:', error)
      return { error: error?.message || 'Could not replace artwork' }
    }
  })
  ipcMain.handle('track:setGenre', (_, trackId, genre) => getDB().prepare('UPDATE tracks SET genre = ? WHERE id = ?').run(genre || null, trackId))
  ipcMain.handle('track:update', (_, trackId, data) => {
    const db = getDB()
    const currentTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId)
    if (!currentTrack) return { error: 'Track not found' }
    const updates = []
    const params = []
    let wroteFile = false
    
    if (data.title !== undefined) { updates.push('title = ?'); params.push(data.title) }
    if (data.artist !== undefined) { updates.push('artist = ?'); params.push(data.artist) }
    if (data.album !== undefined) { updates.push('album = ?'); params.push(data.album) }
    if (data.album_artist !== undefined) { updates.push('album_artist = ?'); params.push(data.album_artist) }
    if (data.track_num !== undefined) { updates.push('track_num = ?'); params.push(data.track_num) }
    if (data.year !== undefined) { updates.push('year = ?'); params.push(data.year) }
    if (data.record_label !== undefined) { updates.push('record_label = ?'); params.push(data.record_label) }
    if (data.clip_url !== undefined) { updates.push('clip_url = ?'); params.push(String(data.clip_url || '').trim() || null) }
    if (data.clip_start !== undefined) { updates.push('clip_start = ?'); params.push(data.clip_start === null || data.clip_start === '' ? null : Number(data.clip_start)) }
    if (data.clip_end !== undefined) { updates.push('clip_end = ?'); params.push(data.clip_end === null || data.clip_end === '' ? null : Number(data.clip_end)) }
    if (data.explicit !== undefined) { updates.push('explicit = ?'); params.push(data.explicit ? 1 : 0) }
    if (data.instrumental !== undefined) { updates.push('instrumental = ?'); params.push(data.instrumental === null ? null : data.instrumental ? 1 : 0) }
    if (data.danceability !== undefined) { updates.push('danceability = ?'); params.push(data.danceability) }
    if (data.energy !== undefined) { updates.push('energy = ?'); params.push(data.energy) }
    if (data.track_key !== undefined) { updates.push('track_key = ?'); params.push(data.track_key) }
    if (data.loudness !== undefined) { updates.push('loudness = ?'); params.push(data.loudness) }
    if (data.mode !== undefined) { updates.push('mode = ?'); params.push(data.mode) }
    if (data.speechiness !== undefined) { updates.push('speechiness = ?'); params.push(data.speechiness) }
    if (data.acousticness !== undefined) { updates.push('acousticness = ?'); params.push(data.acousticness) }
    if (data.instrumentalness !== undefined) { updates.push('instrumentalness = ?'); params.push(data.instrumentalness) }
    if (data.liveness !== undefined) { updates.push('liveness = ?'); params.push(data.liveness) }
    if (data.valence !== undefined) { updates.push('valence = ?'); params.push(data.valence) }
    if (data.tempo !== undefined) { updates.push('tempo = ?'); params.push(data.tempo) }
    if (data.time_signature !== undefined) { updates.push('time_signature = ?'); params.push(data.time_signature) }

    if (data.genre !== undefined || data.genres !== undefined) {
      const normalizedGenres = data.genres !== undefined
        ? normalizeGenresForBatch(data.genres)
        : normalizeGenresForBatch(currentTrack.genres || data.genre || currentTrack.genre)
      const primaryGenre = data.genre !== undefined
        ? (data.genre || firstGenreForBatch(normalizedGenres))
        : firstGenreForBatch(normalizedGenres)
      updates.push('genre = ?')
      params.push(primaryGenre || null)
      updates.push('genres = ?')
      params.push(normalizedGenres)
    }
    
    if (updates.length === 0) return { error: 'No fields to update' }

    // Keep editable metadata in the audio file so a later rescan doesn't restore old tags.
    const tagData = { ...(data || {}) }
    if (tagData.genre !== undefined && tagData.genres === undefined) {
      const existingGenres = String(currentTrack.genres || currentTrack.genre || '').split(',').map(value => value.trim()).filter(Boolean)
      tagData.genres = [...new Set([String(tagData.genre || '').trim(), ...existingGenres].filter(Boolean))]
    }
    const tagEdits = require('../fileComment').fileTagEdits(tagData)
    if (Object.keys(tagEdits).length && !String(currentTrack.file_path || '').startsWith('ghost://') && fs.existsSync(currentTrack.file_path)) {
      try { require('../fileComment').writeFileTags(currentTrack.file_path, tagEdits); wroteFile = true }
      catch (e) { return { error: `Couldn't save the tags into the file: ${e.message}` } }
    }

    params.push(trackId)
    const sql = `UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`
    const result = db.prepare(sql).run(...params)
    if (wroteFile) require('../fileStamp').noteFileWritten(db, currentTrack.file_path)
    if (data.artist !== undefined) {
      updateTrackArtistLinks(db, trackId, data.artist)
    }
    if (data.instrumental === 1 || data.instrumental === true) {
      clearLyricsStateForTrack(db, trackId, currentTrack.file_path)
    }
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId)
    return { success: true, changes: result.changes, track }
  })
  
  ipcMain.handle('track:fetchExternalArtwork', async (_, trackId, title, artist) => {
    const db = getDB()
    try {
      const result = await fetchExternalMetadata(title, artist, trackId)
      if (result?.artPath) {
        const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(String(trackId || ''))
        if (!track) return { success: false, error: 'Track not found' }
        const filePath = String(track.file_path || '')
        const hasLocalFile = path.isAbsolute(filePath) && !filePath.startsWith('ghost://')
        if (hasLocalFile) {
          if (!fs.existsSync(filePath)) return { success: false, error: 'The audio file is missing; artwork was not changed.' }
          // iTunes/Cover Art Archive images need the same embedded-tag write as
          // the manual picker. Otherwise the new cover appears only in Lokal.
          const cover = await normalizeArtwork(await fs.readFile(result.artPath))
          writeEmbeddedArtwork(filePath, cover)
          await fs.writeFile(result.artPath, cover)
          require('../fileStamp').noteFileWritten(db, filePath)
        }
        db.prepare('UPDATE tracks SET artwork_path = ? WHERE id = ?').run(result.artPath, trackId)
        return {
          success: true,
          artworkPath: result.artPath,
          track: db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) || null,
        }
      }
      return { success: false, error: 'No artwork found' }
    } catch (err) {
      console.error('[track:fetchExternalArtwork]', err.message)
      return { success: false, error: err?.message || 'Could not replace artwork' }
    }
  })
  ipcMain.handle('scanner:getTopGenres', () => getDB().prepare(`SELECT genre, COUNT(*) as count FROM tracks WHERE genre IS NOT NULL GROUP BY genre ORDER BY count DESC LIMIT 10`).all())
  ipcMain.handle('scanner:getAllGenres', () => collectAllGenres(getDB()))
  ipcMain.handle('scanner:getRandomTrack', () => getDB().prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' ORDER BY RANDOM() LIMIT 1").get())
  ipcMain.handle('db:clearTracks', () => { const db = getDB(); db.prepare('DELETE FROM artist_track_links').run(); db.prepare('DELETE FROM playlist_tracks').run(); db.prepare('DELETE FROM user_likes').run(); db.prepare('DELETE FROM play_history').run(); try { db.prepare('DELETE FROM listening_events').run() } catch {}; db.prepare('DELETE FROM lyrics_cache').run(); db.prepare('DELETE FROM lyrics_translations').run(); db.prepare('DELETE FROM tracks').run(); db.prepare('DELETE FROM artists').run() })
  ipcMain.handle('db:clearLyrics', () => { const db = getDB(); db.prepare('DELETE FROM lyrics_cache').run(); db.prepare('DELETE FROM lyrics_translations').run() })
  ipcMain.handle('settings:get', () => { const rows = getDB().prepare('SELECT key, value FROM settings').all(); return Object.fromEntries(rows.map(r => [r.key, SECRET_SETTING_KEYS.has(r.key) && r.value ? SECRET_SETTING_PLACEHOLDER : r.value])) })
  ipcMain.handle('settings:save', (_, s) => {
    const stmt = getDB().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(s)) { if (k === 'cache_root' || k === 'download_root') continue; if (SECRET_SETTING_KEYS.has(k) && String(v) === SECRET_SETTING_PLACEHOLDER) continue; stmt.run(k, String(v)) }
    // Write, or remove, the file made from a pasted YouTube cookie.
    require('./ytCookies').syncPastedCookie(Object.fromEntries(getDB().prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])))
  })
  ipcMain.handle('settings:getKeepCommaArtists', () => { try { const db = getDB(); const setting = db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get(); return setting?.value ? JSON.parse(setting.value) : [] } catch { return [] } })
  ipcMain.handle('settings:setKeepCommaArtists', (_, artists) => getDB().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('keep_comma_artists', ?)").run(JSON.stringify(artists)))

  ipcMain.handle('settings:getArtistSplitWords', () => ({
    builtIn: artistSplit.DEFAULT_SPLIT_WORDS,
    words: artistSplit.applySplitWordsFrom(getDB()),
  }))
  ipcMain.handle('settings:setArtistSplitWords', (_, words) => {
    try {
      const db = getDB()
      const saved = artistSplit.saveSplitWords(db, words)
      const changed = relinkArtists(db)
      const keepComma = db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()?.value || '[]'
      const fingerprint = `${ARTIST_SPLITTER_VERSION}:${keepComma}:${JSON.stringify(saved)}`
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('artist_relink_fingerprint', ?)").run(fingerprint)
      return { ok: true, words: saved, changed }
    } catch (error) { return { ok: false, error: error?.message || String(error) } }
  })

  ipcMain.handle('settings:getTheme', () => {
    const db = getDB()
    const theme = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()
    const overrides = db.prepare("SELECT value FROM settings WHERE key = 'theme_overrides'").get()
    return {
      theme: theme?.value || 'dark',
      overrides: overrides?.value ? JSON.parse(overrides.value) : {}
    }
  })

  ipcMain.handle('settings:saveTheme', (_, { theme, overrides }) => {
    const db = getDB()
    if (theme !== undefined) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', ?)").run(theme)
    }
    if (overrides !== undefined) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme_overrides', ?)").run(JSON.stringify(overrides))
    }
    require('./remote').events.emit('theme')
  })
  ipcMain.handle('track:batchUpdate', async (_, trackIds, operations) => {
    const db = getDB()
    try {
      const tracks = await applyBatchTrackUpdates(db, trackIds, operations || {})
      return { success: true, tracks }
    } catch (error) {
      return { error: error.message }
    }
  })
  ipcMain.handle('settings:exportAll', () => exportAppData())
  ipcMain.handle('settings:importAll', (_, payload) => {
    const incoming = payload?.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)
      ? payload.settings
      : {}
    const current = getDB().prepare('SELECT key, value FROM settings').all()
    const kept = current.filter(row => SECRET_SETTING_KEYS.has(row.key))
    const result = importAppData(payload)
    if (kept.length) {
      const restore = getDB().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      for (const row of kept) {
        const incomingValue = incoming[row.key]
        if (!(row.key in incoming) || String(incomingValue) === SECRET_SETTING_PLACEHOLDER) {
          restore.run(row.key, row.value)
        }
      }
    }
    return result
  })
  ipcMain.handle('settings:factoryReset', () => resetAppData())
  
  function parseM3U(content) {
    const lines = content.split(/\r?\n/)
    const entries = []
    let currentMeta = null
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#EXTM3U')) continue
      if (trimmed.startsWith('#EXTINF:')) {
        const match = trimmed.match(/#EXTINF:(\d+),(.+)/)
        if (match) {
          const duration = parseInt(match[1], 10)
          const meta = match[2].trim()
          const dashIndex = meta.lastIndexOf(' - ')
          if (dashIndex > 0) {
            currentMeta = { artist: meta.substring(0, dashIndex).trim(), title: meta.substring(dashIndex + 3).trim(), duration }
          } else {
            currentMeta = { title: meta, artist: null, duration }
          }
        }
        continue
      }
      if (trimmed.startsWith('#') || !trimmed) continue
      entries.push({ file_path: trimmed, title: currentMeta?.title || null, artist: currentMeta?.artist || null })
      currentMeta = null
    }
    return entries
  }

  
  function parseCSV(content) {
    const lines = content.split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) return []
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''))
    const findCol = (names) => headers.findIndex(h => names.some(n => h.includes(n)))
    const titleCol = findCol(['track name', 'trackname', 'title', 'name', 'track'])
    const artistCol = findCol(['artist name', 'artist', 'performer'])
    if (titleCol === -1) return []
    const entries = []
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''))
      const title = values[titleCol]
      const artist = artistCol !== -1 ? values[artistCol] : null
      if (title) entries.push({ title, artist })
    }
    return entries
  }

  
  function findTrack(db, entry) {
    if (entry.file_path) {
      const track = db.prepare('SELECT id FROM tracks WHERE file_path = ?').get(entry.file_path)
      if (track) return track
      const filename = path.basename(entry.file_path, path.extname(entry.file_path)).toLowerCase()
      const t = db.prepare('SELECT id FROM tracks WHERE LOWER(title) = ? LIMIT 1').get(filename)
      if (t) return t
    }
    if (entry.title && entry.artist) {
      const track = db.prepare(`SELECT id FROM tracks WHERE LOWER(title) = ? AND LOWER(artist) = ? LIMIT 1`).get(entry.title.toLowerCase(), entry.artist.toLowerCase())
      if (track) return track
    }
    if (entry.title) {
      const track = db.prepare('SELECT id FROM tracks WHERE LOWER(title) = ? LIMIT 1').get(entry.title.toLowerCase())
      if (track) return track
    }
    return null
  }

  

  ipcMain.handle('history:export', async (_, userId, format) => {
    const db = getDB()
    const uid = userId || 'guest'
    
    try { db.exec('ALTER TABLE play_history ADD COLUMN seconds_played INTEGER DEFAULT 0') } catch {}
    const history = db.prepare(`SELECT t.title, t.artist, t.album, ph.played_at, COALESCE(ph.seconds_played, 0) as seconds_played FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ph.user_id = ? ORDER BY ph.played_at DESC`).all(uid)
    if (format === 'csv') {
      const header = 'title,artist,album,played_at,seconds_played\n'
      const rows = history.map(h => `"${h.title}","${h.artist}","${h.album || ''}",${h.played_at},${h.seconds_played || 0}`).join('\n')
      return header + rows
    }
    return JSON.stringify(history, null, 2)
  })
}

function uniqueArtworkCachePath(trackId) {
  const safeTrackId = String(trackId || 'track').replace(/[^a-z0-9_-]/gi, '_')
  return path.join(getStorageDir(), 'artwork', safeTrackId + '-external-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.jpg')
}

async function fetchExternalMetadata(title, artist, trackId) {
  const db = getDB()
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'fetch_online_artwork'").get()
    if (setting?.value === '0') return null
  } catch { return null }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(title + ' ' + artist)}&entity=song&limit=5`
    const itunesRes = await fetch(itunesUrl, { signal: controller.signal })
    const itunesData = await itunesRes.json()

    if (itunesData.results && itunesData.results.length > 0) {
      const result = itunesData.results[0]
      let artworkUrl = result.artworkUrl100
      const genre = result.primaryGenreName || null  

      console.log(`[fetchExternalMetadata] iTunes result for "${title}" by "${artist}": genre = "${genre}"`)

      if (artworkUrl) {
        artworkUrl = artworkUrl.replace('100x100bb', '600x600bb')
        const artPath = uniqueArtworkCachePath(trackId)
        try {
          await downloadImageWithTimeout(artworkUrl, artPath, 5000)
          clearTimeout(timeout)
          return { artPath, genre }
        } catch {}
      }
      if (genre) { clearTimeout(timeout); return { artPath: null, genre } }
    }
  } catch {}

  clearTimeout(timeout)
  const controller2 = new AbortController()
  const timeout2 = setTimeout(() => controller2.abort(), 5000)

  try {
    const mbQuery = `https://musicbrainz.org/ws/2/recording/?query=recording:"${title}" AND artist:"${artist}"&fmt=json&limit=3&inc=tags`
    const mbRes = await fetch(mbQuery, {
      signal: controller2.signal,
      headers: { 'User-Agent': 'Lokal/4.0 (lokalmusic@email.com)' }
    })
    const mbData = await mbRes.json()

    const recording = mbData.recordings?.[0]
    
    const tags = recording?.tags?.sort((a, b) => b.count - a.count)
    const genre = tags?.[0]?.name || null

    console.log(`[fetchExternalMetadata] MusicBrainz result for "${title}" by "${artist}": genre = "${genre}"`)

    if (recording?.releases?.[0]?.id) {
      const releaseId = recording.releases[0].id
      const coverUrl = `https://coverartarchive.org/release/${releaseId}/front-500`
      const artPath = uniqueArtworkCachePath(trackId)
      try {
        await downloadImageWithTimeout(coverUrl, artPath, 5000)
        clearTimeout(timeout2)
        return { artPath, genre }
      } catch {}
    }
    if (genre) return { artPath: null, genre }
  } catch {}

  clearTimeout(timeout2)
  return null
}

const ARTIST_CLEANUP_INTERVAL_MS = 60_000
let lastUnusedArtistCleanupAt = 0
let unusedArtistCleanupTimer = null

function cleanupUnusedArtistsPeriodically(db) {
  const now = Date.now()
  const remaining = ARTIST_CLEANUP_INTERVAL_MS - (now - lastUnusedArtistCleanupAt)
  if (remaining > 0) {
    // A cleanup skipped due to the interval is still owed: schedule it for
    // the first allowed instant, even if no further track is relinked.
    if (unusedArtistCleanupTimer === null) {
      unusedArtistCleanupTimer = setTimeout(() => {
        unusedArtistCleanupTimer = null
        try {
          cleanupUnusedArtistsPeriodically(db)
        } catch (error) {
          console.warn('[scanner] Deferred unused-artist cleanup failed:', error.message)
        }
      }, remaining)
      unusedArtistCleanupTimer.unref?.()
    }
    return
  }

  db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM artist_track_links)').run()
  lastUnusedArtistCleanupAt = Date.now()
  if (unusedArtistCleanupTimer !== null) clearTimeout(unusedArtistCleanupTimer)
  unusedArtistCleanupTimer = null
}

function updateTrackArtistLinks(db, trackId, artist) {
  db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId)
  for (const name of splitArtists(artist)) {
    const artistId = resolveArtistId(db, name)
    db.prepare('INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)').run(artistId, trackId)
  }
  cleanupUnusedArtistsPeriodically(db)
}

async function indexSingleFile(filePath, opts = {}) {
  const db = getDB()
  const stat = fs.statSync(filePath)
  const trackId = 't-' + hashFile(filePath, stat)
  const existing = db.prepare('SELECT * FROM tracks WHERE file_hash = ? OR file_path = ?').get(trackId, filePath)
  if (existing) {
    const wanted = opts.metadata || {}
    const titleOverride = typeof wanted.title === 'string' && wanted.title.trim() ? wanted.title.trim() : null
    const artistOverride = typeof wanted.artist === 'string' && wanted.artist.trim() ? wanted.artist.trim() : null
    const albumOverride = typeof wanted.album === 'string' && wanted.album.trim() ? wanted.album.trim() : null
    const wantedDuration = Number(wanted.duration) || 0
    let duration = Number(existing.duration) || 0
    let currentMeta
    if (trackId !== existing.file_hash && (wantedDuration > 0 || titleOverride || artistOverride || albumOverride)) {
      let timeout
      try {
        const meta = await Promise.race([
          mm.parseFile(filePath, { duration: true, skipCovers: true }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Metadata parsing timeout')), 30000) }),
        ])
        currentMeta = meta
        duration = Number(meta.format.duration) || 0
      } catch { return { error: 'Failed to parse metadata' } }
      finally { clearTimeout(timeout) }
    }
    if (wantedDuration > 0 && duration > 0 && Math.abs(duration - wantedDuration) > 12) {
      return { error: 'Downloaded audio duration does not match the requested track' }
    }
    if (titleOverride || artistOverride || albumOverride || currentMeta) {
      const currentQuality = currentMeta ? quality.qualityFields(currentMeta) : null
      if (currentQuality) currentQuality.atmos_verified = await quality.probeAtmosFile(filePath, { codec: currentQuality.codec })
      const updates = []
      const params = []
      if (titleOverride && existing.title !== titleOverride) { updates.push('title = ?'); params.push(titleOverride) }
      if (artistOverride && existing.artist !== artistOverride) { updates.push('artist = ?'); params.push(artistOverride) }
      if (albumOverride && existing.album !== albumOverride) { updates.push('album = ?'); params.push(albumOverride) }
      if (currentMeta) {
        updates.push('duration = ?', 'file_hash = ?', 'last_modified = ?')
        params.push(duration, trackId, stat.mtimeMs)
      }
      if (updates.length) {
        params.push(existing.id)
        db.transaction(() => {
          db.prepare(`UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`).run(...params)
          if (artistOverride && existing.artist !== artistOverride) updateTrackArtistLinks(db, existing.id, artistOverride)
          if (currentMeta) {
        quality.saveFields(db, existing.id, currentQuality, { fileChanged: true })
        addedDate.applyToRow(db, existing.id, addedDate.fromMeta(currentMeta))
      }
        })()
      }
      return { skipped: true, id: existing.id, repaired: !!updates.length }
    }
    return { skipped: true, id: existing.id }
  }
  let meta
  let parseTimeout
  try {
    const parsePromise = mm.parseFile(filePath, { duration: true, skipCovers: false })
    const timeoutPromise = new Promise((_, reject) => { parseTimeout = setTimeout(() => reject(new Error('Metadata parsing timeout')), 30000) })
    meta = await Promise.race([parsePromise, timeoutPromise])
  } catch { return { error: 'Failed to parse metadata' } }
  finally { clearTimeout(parseTimeout) }
  const c = meta.common
  const added = addedDate.fromMeta(meta)
  const rawTitle = c.title?.trim()
  const rawArtist = pickPreferredArtist(c)
  const requested = opts.metadata || {}
  const requestedTitle = typeof requested.title === 'string' && requested.title.trim() ? requested.title.trim() : ''
  const requestedArtist = typeof requested.artist === 'string' && requested.artist.trim() ? requested.artist.trim() : ''
  const requestedAlbum = typeof requested.album === 'string' && requested.album.trim() ? requested.album.trim() : ''
  const title = requestedTitle || rawTitle || extractTitleFromFilename(filePath)
  const artist = requestedArtist || rawArtist || extractArtistFromFolder(filePath)
  const duration = meta.format.duration || 0
  const requestedDuration = Number(requested.duration) || 0
  if (requestedDuration > 0 && duration > 0 && Math.abs(duration - requestedDuration) > 12) {
    return { error: 'Downloaded audio duration does not match the requested track' }
  }
  if (!title || !artist) return { error: 'Missing title/artist' }
  if (!rawTitle) console.log(`[indexSingleFile] Fallback title from filename: ${filePath} -> "${title}"`)
  if (!rawArtist) console.log(`[indexSingleFile] Fallback artist from folder: ${filePath} -> "${artist}"`)
  if (duration < getMinDuration()) return { error: 'Too short' }
  if (getSkipDrumKit() && isDrumKit(title, c.album, c.genre?.[0])) return { error: 'Filtered drumkit' }
  
  let artwork = await extractArtwork(meta, trackId)
  
  const thumbnailUrl = opts.thumbnailUrl
  if (!artwork && thumbnailUrl) {
    try {
      const artPath = uniqueArtworkCachePath(trackId)
      await downloadImageWithTimeout(thumbnailUrl, artPath, 5000)
      artwork = artPath
    } catch {}
  }
  let genre = c.genre?.[0] || null
  
  if (!artwork || !genre) {
    const external = await fetchExternalMetadata(title, artist, trackId)
    if (external) {
      if (external.artPath && !artwork) {
        artwork = external.artPath
      }
      if (external.genre && !genre) {
        genre = external.genre
        console.log(`[indexSingleFile] Fetched genre for "${title}": "${genre}"`)
      }
    }
  }

  const replaygain = c.replaygain_track_gain || null
  const audioQuality = quality.qualityFields(meta)
  audioQuality.atmos_verified = await quality.probeAtmosFile(filePath, { codec: audioQuality.codec })
  const album = requestedAlbum || c.album?.trim() || 'Unknown Album'
  // A streamed (ghost) copy of the song isn't a copy in the library: the file
  // is added, and then takes the ghost's place.
  // Stereo FLAC and Dolby Atmos JOC are different editions, even if their
  // artist/title/album/duration are identical. Check the actual file profile,
  // not the source's catalogue badge: a failed Atmos request must not bypass
  // deduplication with an ordinary AAC or FLAC file.
  // Support libraries upgraded before Atmos columns existed (and standalone
  // imports where the scanner is invoked before the normal quality migration).
  quality.ensureColumns(db)
  const dupe = findAudioEditionDuplicate(db, {
    title, artist, album, duration, atmosVerified: audioQuality.atmos_verified, codec: audioQuality.codec,
  })
  if (dupe) {
    // A previous download may have left its database row behind after the
    // audio file was deleted. Reuse that row instead of creating a second
    // library entry when the song is downloaded or rescanned again.
    if (!fs.existsSync(dupe.file_path)) {
      const repaired = await require('../quality/upgrade').upgradeTrackFile(db, dupe.id, filePath, { storageDir: getStorageDir() })
      if (repaired?.id) return { id: repaired.id, repaired: true }
    }
    return { duplicate: true, id: dupe.id }
  }
  
  const insertTransaction = db.transaction(() => {
    const upsertArtist = db.prepare(`INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)`)
    const linkArtist = db.prepare(`INSERT OR IGNORE INTO artist_track_links (artist_id, track_id) VALUES (?, ?)`)
    try { db.exec("ALTER TABLE tracks ADD COLUMN replaygain TEXT") } catch {}
    

    const existingByPath = db.prepare('SELECT id FROM tracks WHERE file_path = ?').get(filePath)
    const params = trackParams({
      id: trackId,
      file_path: filePath,
      file_hash: trackId,
      title,
      artist,
      album,
      album_artist: c.albumartist?.trim() || null,
      track_num: c.track?.no || null,
      year: c.year || null,
      genre,
      duration,
      artwork_path: artwork,
      bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null,
      last_modified: stat.mtimeMs,
      replaygain,
    }, trackId)
    if (existingByPath) {
      db.prepare(`UPDATE tracks SET file_hash = @file_hash, title = @title, artist = @artist, album = @album, album_artist = @album_artist, track_num = @track_num, year = @year, genre = @genre, duration = @duration, artwork_path = @artwork_path, bitrate = @bitrate, last_modified = @last_modified, replaygain = @replaygain WHERE file_path = @file_path`)
        .run(params)
    } else {
      db.prepare(`INSERT INTO tracks (id, file_path, file_hash, title, artist, album, album_artist, track_num, year, genre, duration, artwork_path, bitrate, last_modified, replaygain) VALUES (@id, @file_path, @file_hash, @title, @artist, @album, @album_artist, @track_num, @year, @genre, @duration, @artwork_path, @bitrate, @last_modified, @replaygain)`)
        .run(params)
    }
    quality.saveFields(db, trackId, audioQuality, { fileChanged: true })
    db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId)
    const artistNames = splitArtists(artist)
    for (const name of artistNames) { 
      const aid = resolveArtistId(db, name)
      try {
        linkArtist.run(aid, trackId)
      } catch (linkErr) {
        console.warn(`[indexSingleFile] Failed to link artist ${aid} to track ${trackId}:`, linkErr.message)
      }
    }
    addedDate.applyToRow(db, trackId, added)
    applyPendingImportedMetadataToTrack(db, trackId)
    if (!opts.deferGhostResolution) resolveGhostsByIsrc(db, trackId)
  })
  
  insertTransaction()
  if (added == null) {
    try { await addedDate.stampAddedDates(db, [filePath]) } catch (error) { console.warn('[indexSingleFile] Date-added tag skipped:', error.message) }
  }
  await emitPluginHook('onTrackIndexed', {
    id: trackId,
    title,
    artist,
    album,
    genre,
    duration,
    filePath,
  })
  return { success: true, id: trackId }
}


async function applyFileChanges(changes = [], activeRoots) {
  // Watcher events must only be attributed to folders known to be online.
  // Synchronously probing all persisted roots can freeze Electron when a
  // separate NAS is offline.
  const db = getDB()
  const configured = configuredMusicFolders(db)
  const candidates = Array.isArray(activeRoots)
    ? activeRoots.map(root => path.resolve(root)).filter(root =>
        configured.some(saved => path.resolve(saved).toLowerCase() === root.toLowerCase()))
    : configured
  // A watcher can still deliver an old event after a NAS was disconnected.
  // Probe directory listing (not just stale watcher membership) without
  // blocking Electron's main process before processing any file changes.
  const { isReadableRoot } = require('./networkLibrary')
  const online = await Promise.all(candidates.map(async root => ({
    root, readable: await isReadableRoot(root),
  })))
  const roots = online.filter(entry => entry.readable).map(entry => entry.root)
  if (!roots.length || !Array.isArray(changes)) return { added: [], updated: [], removed: [] }

  const rootFor = filePath => {
    for (const root of roots) {
      const relative = path.relative(root, filePath)
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return root
    }
    return null
  }
  const files = new Set()
  const gone = []
  const seen = new Set()
  const changedRoots = new Set()

  for (const change of changes) {
    const rawPath = change?.path
    if (!rawPath) continue
    const filePath = path.resolve(String(rawPath))
    // Prepared stem clips are internal transition cache, not library songs.
    if (isPreparedStemClipName(filePath)) continue
    const owner = rootFor(filePath)
    if (!owner || seen.has(filePath)) continue
    seen.add(filePath)
    changedRoots.add(owner)

    let stat
    try {
      stat = await require('./networkLibrary').withTimeout(fs.stat)(filePath)
    } catch (error) {
      // Only an actual "path not found" should enter the destructive prune
      // pipeline. Permission failures, network disconnects and timeouts do
      // not prove that the music has been deleted.
      if ((error.code === 'ENOENT' || error.code === 'ENOTDIR') &&
          (change?.renamed || AUDIO_EXTS.has(path.extname(filePath).toLowerCase()))) {
        gone.push(filePath)
      }
      continue
    }
    if (stat.isDirectory()) {
      if (change?.renamed) for (const child of await walkDir(filePath)) files.add(path.resolve(child))
      continue
    }
    if (stat.isFile() && AUDIO_EXTS.has(path.extname(filePath).toLowerCase())) files.add(filePath)
  }

  if (!files.size && !gone.length) return { added: [], updated: [], removed: [] }

  const before = new Map()
  for (const filePath of files) {
    before.set(filePath, db.prepare('SELECT id, last_modified FROM tracks WHERE file_path = ?').get(filePath) || null)
  }

  // Scan only affected roots before pruning exact missing paths. This picks up
  // renamed files first, so the pruning code can transfer likes/history to the
  // replacement row instead of treating a rename as a delete.
  const readableAfterScan = new Map()
  for (const root of changedRoots) {
    if (!await isReadableRoot(root)) {
      readableAfterScan.set(root, false)
      continue
    }
    await scanFolder(root, { saveRoot: false, watch: false })
    readableAfterScan.set(root, await isReadableRoot(root))
  }

  let removed = []
  if (gone.length) {
    // A NAS can disconnect after its watcher event was queued. Never purge
    // rows unless the original owning root still permits directory listing.
    const confirmedGone = await require('./networkLibrary')
      .verifiedMissingPaths(gone, rootFor, readableAfterScan, isReadableRoot)
    try {
      if (confirmedGone.length) {
        removed = require('../libraryPrune').pruneGonePaths(db, confirmedGone).ids
      }
    } catch (error) {
      console.warn('[libraryWatcher] Clearing missing files skipped:', error.message)
    }
  }

  const added = []
  const updated = []
  for (const filePath of files) {
    const current = db.prepare('SELECT id, last_modified FROM tracks WHERE file_path = ?').get(filePath)
    if (!current) continue
    const previous = before.get(filePath)
    if (!previous) added.push(current.id)
    else if (previous.id !== current.id || previous.last_modified !== current.last_modified) updated.push(current.id)
  }

  return {
    added: [...new Set(added)],
    updated: [...new Set(updated)],
    removed: [...new Set(removed)],
  }
}

module.exports = { sourceFilter, genreFilter, userStats, registerScannerHandlers, scanFolder, scanFolders, configuredMusicFolders, applyFileChanges, DEFAULT_MUSIC_PATH, indexSingleFile, AUDIO_EXTS, relinkArtists, relinkArtistsIfNeeded, SECRET_SETTING_KEYS, getLibraryFolders }


function registerExtraHandlers(ipcMain) {
  ipcMain.handle('artist:setImageUrl', async (_, artistId, url) => { const db = getDB(); const imgPath = path.join(getStorageDir(), 'artwork', `artist-${artistId}.jpg`); await downloadToFile(url, imgPath); db.prepare('UPDATE artists SET image_path = ?, image_source = ?, image_fetched_at = ? WHERE id = ?').run(imgPath, 'manual', Date.now(), artistId); return imgPath })
  ipcMain.handle('album:setImageUrl', async (_, albumTitle, url) => { const db = getDB(); const safeTitle = albumTitle.replace(/[^a-z0-9]+/gi, '-'); const imgPath = path.join(getStorageDir(), 'artwork', `album-${safeTitle}.jpg`); await downloadToFile(url, imgPath); db.prepare('UPDATE tracks SET artwork_path = ? WHERE album = ?').run(imgPath, albumTitle); return imgPath })
  ipcMain.handle('scanner:checkDuplicates', () => getDB().prepare(`SELECT title, artist, COUNT(*) as count, GROUP_CONCAT(id) as ids, GROUP_CONCAT(file_path) as paths FROM tracks GROUP BY LOWER(title), LOWER(artist) HAVING count > 1`).all())
  ipcMain.handle('scanner:checkPossibleDuplicates', () => {
    const tracks = getDB().prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' ORDER BY artist, title").all()
    return buildPossibleDuplicateGroups(tracks)
  })
  ipcMain.handle('scanner:deleteTrack', async (_, trackId) => { const db = getDB(); const filePath = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId)?.file_path; db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId); db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(trackId); db.prepare('DELETE FROM user_likes WHERE track_id = ?').run(trackId); db.prepare('DELETE FROM play_history WHERE track_id = ?').run(trackId); try { db.prepare('DELETE FROM listening_events WHERE track_id = ?').run(trackId) } catch {}; db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId); try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(trackId) } catch {}; db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId); forgetDownloads([trackId]); return { success: true, files: await removeTrackFiles(db, [filePath]) } })
  ipcMain.handle('scanner:deleteTrackByPath', async (_, filePath) => { 
    const db = getDB()
    const track = db.prepare('SELECT id FROM tracks WHERE file_path = ?').get(filePath)
    if (!track) return { error: 'Track not found' }
    const trackId = track.id
    db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM user_likes WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM play_history WHERE track_id = ?').run(trackId)
    try { db.prepare('DELETE FROM listening_events WHERE track_id = ?').run(trackId) } catch {}
    db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId)
    db.prepare('DELETE FROM lyrics_cache WHERE file_path = ?').run(filePath)
    try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(trackId) } catch {}
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)
    forgetDownloads([trackId])
    return { success: true, trackId, files: await removeTrackFiles(db, [filePath]) }
  })
}

function downloadToFile(url, dest) {
  const fs = require('fs-extra')
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const file = fs.createWriteStream(dest)
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) { file.close(); return downloadToFile(res.headers.location, dest).then(resolve).catch(reject) }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve(dest) })
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
  })
}

module.exports.registerExtraHandlers = registerExtraHandlers

function registerV4Handlers(ipcMain) {
  const { getDB } = require('./db')
  ipcMain.handle('scanner:getRelated', (_, trackId, userId) => {
    const db = getDB()
    const uid = userId || 'guest'
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId)
    if (!track) return db.prepare("SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' ORDER BY RANDOM() LIMIT 20").all()
    const recentIds = db.prepare('SELECT track_id FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 100').all(uid).map(row => row.track_id)
    const recentSet = new Set(recentIds)
    const candidates = db.prepare(`
      SELECT * FROM tracks
      WHERE id != ?
        AND file_path NOT LIKE 'ghost://%'
        AND (
          artist = ?
          OR LOWER(COALESCE(genre, '')) = LOWER(?)
          OR LOWER(COALESCE(genres, '')) LIKE LOWER(?)
          OR (danceability IS NOT NULL AND ABS(danceability - ?) <= 0.18)
          OR (energy IS NOT NULL AND ABS(energy - ?) <= 0.18)
          OR (tempo IS NOT NULL AND ABS(tempo - ?) <= 18)
        )
      ORDER BY RANDOM()
      LIMIT 180
    `).all(trackId, track.artist || '', track.genre || '', `%${track.genre || ''}%`, Number(track.danceability) || -99, Number(track.energy) || -99, Number(track.tempo) || -999)
    let related = candidates
      .filter(candidate => !recentSet.has(candidate.id))
      .map(candidate => ({ track: candidate, score: scoreRelatedTrack(track, candidate) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map(item => item.track)
      .slice(0, 25)
    if (related.length < 10) {
      const extra = db.prepare("SELECT * FROM tracks WHERE id != ? AND file_path NOT LIKE 'ghost://%' ORDER BY RANDOM() LIMIT 40").all(trackId)
      const ids = new Set(related.map(t => t.id))
      for (const candidate of extra) {
        if (ids.has(candidate.id) || recentSet.has(candidate.id)) continue
        ids.add(candidate.id)
        related.push(candidate)
        if (related.length >= 25) break
      }
    }
    return related.slice(0, 25)
  })
  ipcMain.handle('scanner:incrementPlayTime', (_, trackId, userId, seconds) => {
    try {
      const db = getDB()
      const uid = userId || 'guest'
      const thresholdSetting = db.prepare("SELECT value FROM settings WHERE key = 'scrobble_threshold'").get()
      const threshold = thresholdSetting ? parseInt(thresholdSetting.value) : 30
      try { db.exec('ALTER TABLE play_history ADD COLUMN seconds_played INTEGER DEFAULT 0') } catch {}
      try { db.exec('ALTER TABLE play_history ADD COLUMN session_id TEXT') } catch {}
      const track = db.prepare('SELECT duration FROM tracks WHERE id = ?').get(trackId)
      const minSeconds = track ? Math.max(30, (track.duration || 0) * (threshold / 100)) : 30
      if (seconds >= minSeconds) db.prepare('UPDATE tracks SET play_count = play_count + 1 WHERE id = ?').run(trackId)
      const sessionId = recordListeningEvent(db, { userId: uid, trackId, secondsPlayed: seconds, trackDuration: track?.duration || null })
      db.prepare('INSERT INTO play_history (user_id, track_id, seconds_played, session_id) VALUES (?, ?, ?, ?)').run(uid, trackId, Math.round(seconds || 0), sessionId)
    } catch(e) { console.warn('incrementPlayTime:', e.message) }
  })
  // Settings > Library > Fill In Genres (see electron/online/genres.js).
  ipcMain.handle('scanner:fetchMissingGenres', () => require('../online/genres').startLibraryGenres(getDB()))
  ipcMain.handle('scanner:genresStatus', () => require('../online/genres').libraryGenresStatus())
  ipcMain.handle('scanner:setManualGenre', async (_, { artist, track, album, genre }) => {
    const db = getDB()
    if (!artist || !genre) {
      return { error: 'Artist and genre are required' }
    }
    
    let query = 'UPDATE tracks SET genre = ? WHERE LOWER(artist) = LOWER(?)'
    const params = [genre, artist]
    
    if (track) {
      query += ' AND LOWER(title) = LOWER(?)'
      params.push(track)
    }
    if (album) {
      query += ' AND LOWER(album) = LOWER(?)'
      params.push(album)
    }
    
    const result = db.prepare(query).run(...params)
    return { updated: result.changes }
  })
  ipcMain.handle('scanner:getAllAlbums', () => {
    const rows = getDB().prepare(`${albumRowsQuery()} ORDER BY year DESC, album ASC`).all()
    return enrichAlbumRows(rows)
  })
  ipcMain.handle('scanner:searchAlbums', (_, q) => {
    const match = require('../librarySearch').wordsMatch(q, ['album', 'album_artist', 'artist'])
    if (!match) return []
    const rows = getDB().prepare(`${albumRowsQuery(`AND ${match.sql}`)} ORDER BY album ASC`).all(...match.params)
    return enrichAlbumRows(rows)
  })
  ipcMain.handle('scanner:deleteTracks', async (_, ids) => { const db = getDB(); const filePaths = (ids || []).map(id => db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(id)?.file_path); const del = db.transaction((ids) => { for (const id of ids) { db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(id); db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(id); db.prepare('DELETE FROM user_likes WHERE track_id = ?').run(id); db.prepare('DELETE FROM play_history WHERE track_id = ?').run(id); try { db.prepare('DELETE FROM listening_events WHERE track_id = ?').run(id) } catch {}; db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(id); try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(id) } catch {}; db.prepare('DELETE FROM tracks WHERE id = ?').run(id) } }); del(ids); forgetDownloads(ids); return { success: true, files: await removeTrackFiles(db, filePaths) } })
  ipcMain.handle('scanner:mergeDuplicates', (_, keepId, removeIds) => mergeDuplicates(getDB(), keepId, removeIds))
  ipcMain.handle('scanner:mergeAllDuplicates', () => mergeAllDuplicates(getDB(), scoreTrack))
  ipcMain.handle('user:getStats', (_, userId) => userStats(getDB(), userId))
  ipcMain.handle('user:getRecap', (_, userId) => {
    const db = getDB()
    const uid = userId || 'guest'
    try { db.exec('ALTER TABLE play_history ADD COLUMN seconds_played INTEGER DEFAULT 0') } catch {}
    const qualified = 'ph.user_id = ? AND COALESCE(ph.seconds_played, 999) >= 30'
    const totalPlays = db.prepare(`SELECT COUNT(*) as c FROM play_history ph WHERE ${qualified}`).get(uid)?.c || 0
    const totalSecs = db.prepare(`SELECT SUM(COALESCE(ph.seconds_played, 0)) as s FROM play_history ph WHERE ${qualified}`).get(uid)?.s || 0
    const uniqueArtists = db.prepare(`SELECT COUNT(DISTINCT t.artist) as c FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ${qualified}`).get(uid)?.c || 0
    const uniqueAlbums = db.prepare(`SELECT COUNT(DISTINCT COALESCE(NULLIF(t.album, ''), t.id)) as c FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ${qualified}`).get(uid)?.c || 0
    const uniqueTracks = db.prepare(`SELECT COUNT(DISTINCT t.id) as c FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ${qualified}`).get(uid)?.c || 0
    const topArtists = db.prepare(`SELECT t.artist, COUNT(*) as plays FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ${qualified} GROUP BY t.artist ORDER BY plays DESC LIMIT 10`).all(uid)
    const topTracks = db.prepare(`SELECT t.*, COUNT(*) as plays FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ${qualified} GROUP BY t.id ORDER BY plays DESC LIMIT 50`).all(uid)
    const topGenres = db.prepare(`SELECT t.genre, COUNT(*) as plays FROM play_history ph JOIN tracks t ON t.id = ph.track_id WHERE ${qualified} AND t.genre IS NOT NULL AND t.genre != '' GROUP BY t.genre ORDER BY plays DESC LIMIT 8`).all(uid)
    const peakHour = db.prepare(`SELECT CAST(strftime('%H', ph.played_at, 'unixepoch', 'localtime') AS INTEGER) as hour, COUNT(*) as plays FROM play_history ph WHERE ${qualified} GROUP BY hour ORDER BY plays DESC LIMIT 1`).get(uid) || null
    const topDay = db.prepare(`SELECT strftime('%Y-%m-%d', ph.played_at, 'unixepoch', 'localtime') as day, COUNT(*) as plays FROM play_history ph WHERE ${qualified} GROUP BY day ORDER BY plays DESC LIMIT 1`).get(uid) || null
    const latestPlay = db.prepare(`SELECT MAX(ph.played_at) as playedAt FROM play_history ph WHERE ${qualified}`).get(uid)?.playedAt || null
    const likedCount = db.prepare('SELECT COUNT(*) as c FROM user_likes WHERE user_id = ?').get(uid)?.c || 0
    return {
      scope: 'all-time-dev',
      totalPlays,
      totalMinutes: Math.round(totalSecs / 60),
      uniqueArtists,
      uniqueAlbums,
      uniqueTracks,
      topArtists,
      topTracks,
      topGenres,
      peakHour,
      topDay,
      likedCount,
      latestPlay,
    }
  })
}



// Reuse this bounded, failure-reporting walker for watcher catch-up.
module.exports.walkDir = walkDir
module.exports.registerV4Handlers = registerV4Handlers
