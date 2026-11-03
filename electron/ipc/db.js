const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs-extra')

function getDataDir() {
  
  if (process.env.LOKAL_DATA_DIR) return process.env.LOKAL_DATA_DIR
  if (process.type === 'browser' || process.versions?.electron) {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'data')
  }
  
  return path.join(process.cwd(), 'data')
}

let db
let _dataDir

function ensureStorageDirs() {
  fs.ensureDirSync(_dataDir)
  fs.ensureDirSync(path.join(_dataDir, 'artwork'))
  fs.ensureDirSync(path.join(_dataDir, 'lyrics'))
  fs.ensureDirSync(path.join(_dataDir, 'avatars'))
}

function initDB() {
  _dataDir = getDataDir()
  ensureStorageDirs()

  db = new Database(path.join(_dataDir, 'lokal.db'))
  // Capture functions are registered after migrations, before ordinary writes.
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'link_*'").all()) db.exec('DROP TRIGGER IF EXISTS \"' + name.replace(/\"/g, '\"\"') + '\"')
  db.function('link_track_key', (artist,title,duration) => require('../link/protocol').trackKey({artist,title,duration}))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      file_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      album_artist TEXT,
      track_num INTEGER,
      year INTEGER,
      genre TEXT,
      genres TEXT,
      record_label TEXT,
      explicit INTEGER DEFAULT 0,
      instrumental INTEGER,
      danceability REAL,
      energy REAL,
      track_key INTEGER,
      loudness REAL,
      mode INTEGER,
      speechiness REAL,
      acousticness REAL,
      instrumentalness REAL,
      liveness REAL,
      valence REAL,
      tempo REAL,
      time_signature INTEGER,
      duration REAL,
      artwork_path TEXT,
      bitrate INTEGER,
      last_modified INTEGER,
      replaygain TEXT,
      play_count INTEGER DEFAULT 0,
      liked INTEGER DEFAULT 0,
      added_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      bio TEXT,
      image_path TEXT
    );
    CREATE TABLE IF NOT EXISTS artist_track_links (
      artist_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      PRIMARY KEY (artist_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT DEFAULT 'guest',
      description TEXT,
      cover_path TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT,
      track_id TEXT,
      position INTEGER,
      added_by TEXT DEFAULT 'guest',
      added_at INTEGER,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id),
      FOREIGN KEY (track_id) REFERENCES tracks(id)
    );
    CREATE TABLE IF NOT EXISTS user_likes (
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      liked_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      seconds_played INTEGER DEFAULT 0,
      session_id TEXT,
      played_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (track_id) REFERENCES tracks(id)
    );
    CREATE TABLE IF NOT EXISTS listening_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source_type TEXT,
      source_id TEXT,
      session_id TEXT,
      seconds_played INTEGER DEFAULT 0,
      track_duration REAL,
      started_at INTEGER,
      ended_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS lyrics_cache (
      track_id TEXT PRIMARY KEY,
      lyrics_type TEXT,
      content TEXT,
      source TEXT,
      cached_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS lyrics_translations (
      track_id TEXT NOT NULL,
      target_lang TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      detected_lang TEXT,
      content TEXT,
      provider TEXT,
      fetched_at INTEGER DEFAULT 0,
      PRIMARY KEY (track_id, target_lang, source_hash)
    );
    CREATE TABLE IF NOT EXISTS pending_import_metadata (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      artist TEXT,
      normalized_artist TEXT,
      album TEXT,
      normalized_album TEXT,
      year INTEGER,
      genre TEXT,
      genres TEXT,
      record_label TEXT,
      explicit INTEGER,
      danceability REAL,
      energy REAL,
      track_key INTEGER,
      loudness REAL,
      mode INTEGER,
      speechiness REAL,
      acousticness REAL,
      instrumentalness REAL,
      liveness REAL,
      valence REAL,
      tempo REAL,
      time_signature INTEGER,
      duration REAL,
      source_url TEXT,
      source_platform TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      avatar_path TEXT,
      bio TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
    CREATE INDEX IF NOT EXISTS idx_ph_user ON play_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_ph_time ON play_history(played_at);
    CREATE INDEX IF NOT EXISTS idx_le_user_time ON listening_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_le_session ON listening_events(session_id);
  `)

  
  const migrations = [
    `ALTER TABLE playlists ADD COLUMN user_id TEXT DEFAULT 'guest'`,
    `ALTER TABLE playlists ADD COLUMN description TEXT`,
    `ALTER TABLE playlists ADD COLUMN cover_path TEXT`,
    `ALTER TABLE playlists ADD COLUMN smart_rules TEXT`,
    `ALTER TABLE users ADD COLUMN bio TEXT`,
    `ALTER TABLE artists ADD COLUMN bio_source TEXT`,
    `ALTER TABLE artists ADD COLUMN bio_fetched_at INTEGER`,
    `ALTER TABLE artists ADD COLUMN image_source TEXT`,
    `ALTER TABLE artists ADD COLUMN image_fetched_at INTEGER`,
    `ALTER TABLE play_history ADD COLUMN seconds_played INTEGER DEFAULT 0`,
    `ALTER TABLE play_history ADD COLUMN session_id TEXT`,
    `ALTER TABLE tracks ADD COLUMN genres TEXT`,
    `ALTER TABLE tracks ADD COLUMN replaygain TEXT`,
    // Ghost tracks: where the song can be found (an import link, or the
    // YouTube Music page of an online song) and its remote cover.
    `ALTER TABLE tracks ADD COLUMN source_url TEXT`,
    `ALTER TABLE tracks ADD COLUMN artwork_url TEXT`,
    `ALTER TABLE tracks ADD COLUMN record_label TEXT`,
    `ALTER TABLE tracks ADD COLUMN explicit INTEGER DEFAULT 0`,
    `ALTER TABLE tracks ADD COLUMN instrumental INTEGER`,
    `ALTER TABLE tracks ADD COLUMN danceability REAL`,
    `ALTER TABLE tracks ADD COLUMN energy REAL`,
    `ALTER TABLE tracks ADD COLUMN track_key INTEGER`,
    `ALTER TABLE tracks ADD COLUMN loudness REAL`,
    `ALTER TABLE tracks ADD COLUMN mode INTEGER`,
    `ALTER TABLE tracks ADD COLUMN speechiness REAL`,
    `ALTER TABLE tracks ADD COLUMN acousticness REAL`,
    `ALTER TABLE tracks ADD COLUMN instrumentalness REAL`,
    `ALTER TABLE tracks ADD COLUMN liveness REAL`,
    `ALTER TABLE tracks ADD COLUMN valence REAL`,
    `ALTER TABLE tracks ADD COLUMN tempo REAL`,
    `ALTER TABLE tracks ADD COLUMN time_signature INTEGER`,
    `ALTER TABLE tracks ADD COLUMN clip_url TEXT`,
    `ALTER TABLE tracks ADD COLUMN clip_start REAL`,
    `ALTER TABLE tracks ADD COLUMN clip_end REAL`,
    `ALTER TABLE tracks ADD COLUMN clip_zoom REAL`,
    // Downloaded songs: where from ('yt', 'sc', an addon 'a-<key>', 'soulseek',
    // 'web') and which online song ("yt:<id>", "a-<key>:<id>"...), so the same
    // song isn't downloaded twice and versions from different places can be
    // told apart.
    `ALTER TABLE tracks ADD COLUMN download_source TEXT`,
    `ALTER TABLE tracks ADD COLUMN source_ref TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tracks_source_ref ON tracks(source_ref)`,
    // A streamed (ghost) track replaced by its file: its old id still leads
    // to the file (a player or page may still hold the old one).
    `CREATE TABLE IF NOT EXISTS track_aliases (old_id TEXT PRIMARY KEY, track_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS artist_track_links (artist_id TEXT NOT NULL, track_id TEXT NOT NULL, PRIMARY KEY (artist_id, track_id))`,
    `CREATE TABLE IF NOT EXISTS play_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, track_id TEXT NOT NULL, seconds_played INTEGER DEFAULT 0, played_at INTEGER DEFAULT (unixepoch()))`,
    `CREATE TABLE IF NOT EXISTS listening_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, track_id TEXT NOT NULL, event_type TEXT NOT NULL, source_type TEXT, source_id TEXT, session_id TEXT, seconds_played INTEGER DEFAULT 0, track_duration REAL, started_at INTEGER, ended_at INTEGER, created_at INTEGER DEFAULT (unixepoch()))`,
    `CREATE TABLE IF NOT EXISTS pending_import_metadata (id TEXT PRIMARY KEY, title TEXT NOT NULL, normalized_title TEXT NOT NULL, artist TEXT, normalized_artist TEXT, album TEXT, normalized_album TEXT, year INTEGER, genre TEXT, genres TEXT, record_label TEXT, explicit INTEGER, danceability REAL, energy REAL, track_key INTEGER, loudness REAL, mode INTEGER, speechiness REAL, acousticness REAL, instrumentalness REAL, liveness REAL, valence REAL, tempo REAL, time_signature INTEGER, duration REAL, source_url TEXT, source_platform TEXT, created_at INTEGER DEFAULT (unixepoch()))`,
  ]
  
  const quickMigrations = [
    `ALTER TABLE play_history ADD COLUMN seconds_played INTEGER DEFAULT 0`,
    `ALTER TABLE play_history ADD COLUMN session_id TEXT`,
    `ALTER TABLE playlists ADD COLUMN user_id TEXT DEFAULT 'guest'`,
    `ALTER TABLE playlists ADD COLUMN description TEXT`,
    `ALTER TABLE playlists ADD COLUMN cover_path TEXT`,
    `ALTER TABLE playlists ADD COLUMN smart_rules TEXT`,
    `ALTER TABLE users ADD COLUMN bio TEXT`,
    `ALTER TABLE artists ADD COLUMN bio_source TEXT`,
    `ALTER TABLE artists ADD COLUMN bio_fetched_at INTEGER`,
    `ALTER TABLE artists ADD COLUMN image_source TEXT`,
    `ALTER TABLE artists ADD COLUMN image_fetched_at INTEGER`,
    `ALTER TABLE tracks ADD COLUMN genres TEXT`,
    `ALTER TABLE tracks ADD COLUMN replaygain TEXT`,
    // Ghost tracks: where the song can be found (an import link, or the
    // YouTube Music page of an online song) and its remote cover.
    `ALTER TABLE tracks ADD COLUMN source_url TEXT`,
    `ALTER TABLE tracks ADD COLUMN artwork_url TEXT`,
    `ALTER TABLE tracks ADD COLUMN record_label TEXT`,
    `ALTER TABLE tracks ADD COLUMN explicit INTEGER DEFAULT 0`,
    `ALTER TABLE tracks ADD COLUMN instrumental INTEGER`,
    `ALTER TABLE tracks ADD COLUMN danceability REAL`,
    `ALTER TABLE tracks ADD COLUMN energy REAL`,
    `ALTER TABLE tracks ADD COLUMN track_key INTEGER`,
    `ALTER TABLE tracks ADD COLUMN loudness REAL`,
    `ALTER TABLE tracks ADD COLUMN mode INTEGER`,
    `ALTER TABLE tracks ADD COLUMN speechiness REAL`,
    `ALTER TABLE tracks ADD COLUMN acousticness REAL`,
    `ALTER TABLE tracks ADD COLUMN instrumentalness REAL`,
    `ALTER TABLE tracks ADD COLUMN liveness REAL`,
    `ALTER TABLE tracks ADD COLUMN valence REAL`,
    `ALTER TABLE tracks ADD COLUMN tempo REAL`,
    `ALTER TABLE tracks ADD COLUMN time_signature INTEGER`,
    `ALTER TABLE tracks ADD COLUMN clip_url TEXT`,
    `ALTER TABLE tracks ADD COLUMN clip_start REAL`,
    `ALTER TABLE tracks ADD COLUMN clip_end REAL`,
    `ALTER TABLE tracks ADD COLUMN clip_zoom REAL`,
    `ALTER TABLE playlist_tracks ADD COLUMN added_by TEXT DEFAULT 'guest'`,
    `ALTER TABLE playlist_tracks ADD COLUMN added_at INTEGER`,
    
    `ALTER TABLE playlist_tracks ADD COLUMN id INTEGER PRIMARY KEY AUTOINCREMENT`,
    
    `CREATE TABLE IF NOT EXISTS downloaded_playlists (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      archive_path TEXT NOT NULL,
      total_tracks INTEGER DEFAULT 0,
      downloaded_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch()),
      last_downloaded_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS pending_import_metadata (id TEXT PRIMARY KEY, title TEXT NOT NULL, normalized_title TEXT NOT NULL, artist TEXT, normalized_artist TEXT, album TEXT, normalized_album TEXT, year INTEGER, genre TEXT, genres TEXT, record_label TEXT, explicit INTEGER, danceability REAL, energy REAL, track_key INTEGER, loudness REAL, mode INTEGER, speechiness REAL, acousticness REAL, instrumentalness REAL, liveness REAL, valence REAL, tempo REAL, time_signature INTEGER, duration REAL, source_url TEXT, source_platform TEXT, created_at INTEGER DEFAULT (unixepoch()))`,
    `CREATE TABLE IF NOT EXISTS listening_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, track_id TEXT NOT NULL, event_type TEXT NOT NULL, source_type TEXT, source_id TEXT, session_id TEXT, seconds_played INTEGER DEFAULT 0, track_duration REAL, started_at INTEGER, ended_at INTEGER, created_at INTEGER DEFAULT (unixepoch()))`,
  ]
  for (const m of quickMigrations) { try { db.exec(m) } catch {} }
  // Audio quality and ISRC columns (electron/quality).
  // The scanner writes these columns: without them indexing would fail later
  // and less clearly, so a failure here stops start-up.
  try { require('../quality').ensureColumns(db) } catch (e) { console.warn('quality columns:', e.message); throw e }
  // "Paste my cookie" became the default cookie source. Whoever turned
  // cookies on before without picking a source was using Firefox: keep that.
  // Once only (marked done), so a later "on" with the new default isn't touched.
  try {
    if (!db.prepare("SELECT 1 FROM settings WHERE key = 'yt_cookie_default_v2'").get()) {
      db.prepare(`INSERT OR IGNORE INTO settings (key, value)
        SELECT 'yt_cookie_browser', 'firefox' WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'yt_cookies' AND value = '1')`).run()
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('yt_cookie_default_v2', '1')").run()
    }
  } catch {}
  // Wikipedia's old search found the wrong page too often (a band member's for
  // a band), and its photos are small stage shots: bios and photos fetched from
  // it before are cleared so they're fetched again (Wikipedia is now only a
  // checked last resort for bios). Set by hand ones
  // are kept. Once only, so someone who picks Wikipedia later keeps its results.
  try {
    if (!db.prepare("SELECT 1 FROM settings WHERE key = 'artist_wikipedia_cleared_v1'").get()) {
      db.prepare("UPDATE artists SET bio = NULL, bio_source = NULL, bio_fetched_at = NULL WHERE bio_source = 'wikipedia'").run()
      db.prepare("UPDATE artists SET image_path = NULL, image_source = NULL, image_fetched_at = NULL WHERE image_source = 'wikipedia'").run()
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('artist_wikipedia_cleared_v1', '1')").run()
    }
  } catch {}
  
  
  try {
    
    const tableInfo = db.prepare('PRAGMA table_info(playlist_tracks)').all()
    const hasId = tableInfo.some(c => c.name === 'id')
    if (!hasId) {
      
      db.exec(`
        CREATE TABLE IF NOT EXISTS playlist_tracks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          playlist_id TEXT,
          track_id TEXT,
          position INTEGER,
          added_by TEXT DEFAULT 'guest',
          added_at INTEGER,
          FOREIGN KEY (playlist_id) REFERENCES playlists(id),
          FOREIGN KEY (track_id) REFERENCES tracks(id)
        );
        INSERT INTO playlist_tracks_new (playlist_id, track_id, position, added_by, added_at)
        SELECT playlist_id, track_id, position, COALESCE(added_by, 'guest'), added_at FROM playlist_tracks;
        DROP TABLE playlist_tracks;
        ALTER TABLE playlist_tracks_new RENAME TO playlist_tracks;
      `)
    }
  } catch (e) {
    console.log('Playlist tracks migration skipped:', e.message)
  }

  
  for (const m of migrations) {
    try {
      if (m.includes('ALTER TABLE') && m.includes('ADD COLUMN')) {
        const match = m.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/)
        if (match) {
          const [, table, col] = match
          const cols = db.prepare(`PRAGMA table_info(${table})`).all()
          if (cols.some(c => c.name === col)) continue 
        }
      }
      db.exec(m)
    } catch {}
  }

  // Speed up desktop-vs-mobile recording checks for large linked libraries.
  // The query compares titles case-insensitively before checking artist and
  // duration, so a matching-title index prevents scanning the whole library.
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_title_nocase ON tracks(title COLLATE NOCASE)') } catch {}

  // Older phone uploads predate source tracking; repair those identifiable
  // imports once while keeping explicit addon/download origins intact.
  try {
    if (!db.prepare("SELECT 1 FROM settings WHERE key = 'mobile_sources_v1'").get()) {
      db.transaction(() => {
        require('../mobileSource').backfillMobileSources(db, getStorageDir())
        db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('mobile_sources_v1','1')").run()
      })()
    }
  } catch (error) { console.warn('mobile source migration:', error.message) }

  // Upgrade historical phone downloads whose filenames were random UUIDs.
  // Only files inside data/phone-downloads are touched, and track IDs remain intact.
  try {
    const count = require('../phoneCopyFilenames').repairPhoneCopyFilenames(db, getStorageDir())
    if (count) console.log(`[phone-copy] Repaired ${count} legacy filenames`)
  } catch (error) { console.warn('phone filename migration:', error.message) }

  try {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('lyrics_auto_translate', '0')").run()
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('lyrics_translate_target', 'en')").run()
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('prefer_media_keys', '0')").run()
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_fetch_artist_metadata', '0')").run()
    // key that would cause SMTC to not work.
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'prefer_media_keys' AND value = '1'").run()
  } catch {}

  return db
}

function getDB() { return db }
function getStorageDir() { return _dataDir }

function clearDatabaseTables() {
  db.prepare('DELETE FROM playlist_tracks').run()
  db.prepare('DELETE FROM user_likes').run()
  db.prepare('DELETE FROM play_history').run()
  try { db.prepare('DELETE FROM listening_events').run() } catch {}
  db.prepare('DELETE FROM artist_track_links').run()
  db.prepare('DELETE FROM lyrics_translations').run()
  db.prepare('DELETE FROM lyrics_cache').run()
  try { db.prepare('DELETE FROM pending_import_metadata').run() } catch {}
  try { db.prepare('DELETE FROM downloaded_playlists').run() } catch {}
  db.prepare('DELETE FROM playlists').run()
  db.prepare('DELETE FROM tracks').run()
  db.prepare('DELETE FROM artists').run()
  db.prepare('DELETE FROM user_settings').run()
  db.prepare('DELETE FROM users').run()
  db.prepare('DELETE FROM settings').run()
}

function resetAppData() {
  if (!db) throw new Error('Database not initialized')
  const wipe = db.transaction(() => {
    clearDatabaseTables()
  })
  wipe()
  for (const dir of ['artwork', 'lyrics', 'avatars']) {
    fs.removeSync(path.join(_dataDir, dir))
  }
  ensureStorageDirs()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('lyrics_auto_translate', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('lyrics_translate_target', 'en')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('prefer_media_keys', '0')").run()
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_fetch_artist_metadata', '0')").run()
  return { ok: true }
}

function importAppData(payload = {}) {
  if (!db) throw new Error('Database not initialized')
  if (!payload || typeof payload !== 'object') throw new Error('Invalid backup payload')
  if (payload.version !== 1) throw new Error('Unsupported backup version')

  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {}
  const users = Array.isArray(payload.users) ? payload.users : []
  const userSettings = Array.isArray(payload.user_settings) ? payload.user_settings : []
  const artists = Array.isArray(payload.artists) ? payload.artists : []
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
  const artistLinks = Array.isArray(payload.artist_track_links) ? payload.artist_track_links : []
  const playlists = Array.isArray(payload.playlists) ? payload.playlists : []
  const playlistTracks = Array.isArray(payload.playlist_tracks) ? payload.playlist_tracks : []
  const userLikes = Array.isArray(payload.user_likes) ? payload.user_likes : []
  const playHistory = Array.isArray(payload.play_history) ? payload.play_history : []
  const listeningEvents = Array.isArray(payload.listening_events) ? payload.listening_events : []

  fs.ensureDirSync(path.join(_dataDir, 'avatars'))

  const restore = db.transaction(() => {
    clearDatabaseTables()

    const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(settings)) {
      insertSetting.run(String(key), String(value))
    }

    const insertUser = db.prepare('INSERT INTO users (id, username, display_name, password_hash, avatar_path, bio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const user of users) {
      let avatarPath = user.avatar_path || null
      if (user.avatar_data) {
        const ext = String(user.avatar_data).includes('image/png') ? 'png' : String(user.avatar_data).includes('image/webp') ? 'webp' : 'jpg'
        avatarPath = path.join(_dataDir, 'avatars', `${user.id}.${ext}`)
        const base64 = String(user.avatar_data).split(',')[1] || ''
        fs.writeFileSync(avatarPath, Buffer.from(base64, 'base64'))
      }
      insertUser.run(
        user.id,
        user.username,
        user.display_name || null,
        user.password_hash,
        avatarPath,
        user.bio || null,
        user.created_at || Math.floor(Date.now() / 1000)
      )
    }

    const insertUserSetting = db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
    for (const entry of userSettings) {
      insertUserSetting.run(entry.user_id, entry.key, entry.value)
    }

    const insertArtist = db.prepare('INSERT INTO artists (id, name, bio, image_path, bio_source, bio_fetched_at, image_source, image_fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const artist of artists) {
      insertArtist.run(
        artist.id,
        artist.name,
        artist.bio || null,
        artist.image_path || null,
        artist.bio_source || null,
        artist.bio_fetched_at || null,
        artist.image_source || null,
        artist.image_fetched_at || null
      )
    }

    const insertTrack = db.prepare('INSERT INTO tracks (id, file_path, file_hash, title, artist, album, album_artist, track_num, year, genre, genres, record_label, explicit, instrumental, danceability, energy, track_key, loudness, mode, speechiness, acousticness, instrumentalness, liveness, valence, tempo, time_signature, duration, artwork_path, bitrate, last_modified, replaygain, play_count, liked, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const track of tracks) {
      insertTrack.run(
        track.id,
        track.file_path,
        track.file_hash,
        track.title,
        track.artist,
        track.album || null,
        track.album_artist || null,
        track.track_num || null,
        track.year || null,
        track.genre || null,
        track.genres || null,
        track.record_label || null,
        track.explicit ? 1 : 0,
        track.instrumental ?? null,
        track.danceability ?? null,
        track.energy ?? null,
        track.track_key ?? null,
        track.loudness ?? null,
        track.mode ?? null,
        track.speechiness ?? null,
        track.acousticness ?? null,
        track.instrumentalness ?? null,
        track.liveness ?? null,
        track.valence ?? null,
        track.tempo ?? null,
        track.time_signature ?? null,
        track.duration || 0,
        track.artwork_path || null,
        track.bitrate || null,
        track.last_modified || null,
        track.replaygain || null,
        track.play_count || 0,
        track.liked || 0,
        track.added_at || Math.floor(Date.now() / 1000)
      )
    }

    const insertArtistLink = db.prepare('INSERT INTO artist_track_links (artist_id, track_id) VALUES (?, ?)')
    for (const link of artistLinks) {
      insertArtistLink.run(link.artist_id, link.track_id)
    }

    const insertPlaylist = db.prepare('INSERT INTO playlists (id, name, user_id, description, cover_path, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const playlist of playlists) {
      let coverPath = playlist.cover_path || null
      if (playlist.cover_data) {
        const ext = String(playlist.cover_data).includes('image/png') ? 'png' : String(playlist.cover_data).includes('image/webp') ? 'webp' : 'jpg'
        coverPath = path.join(_dataDir, 'artwork', `playlist-${playlist.id}.${ext}`)
        const base64 = String(playlist.cover_data).split(',')[1] || ''
        fs.writeFileSync(coverPath, Buffer.from(base64, 'base64'))
      }
      insertPlaylist.run(
        playlist.id,
        playlist.name,
        playlist.user_id || 'guest',
        playlist.description || null,
        coverPath,
        playlist.created_at || Math.floor(Date.now() / 1000)
      )
    }

    const insertPlaylistTrack = db.prepare('INSERT INTO playlist_tracks (id, playlist_id, track_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const item of playlistTracks) {
      insertPlaylistTrack.run(
        item.id || null,
        item.playlist_id,
        item.track_id,
        item.position || 0,
        item.added_by || 'guest',
        item.added_at || null
      )
    }

    const insertUserLike = db.prepare('INSERT INTO user_likes (user_id, track_id, liked_at) VALUES (?, ?, ?)')
    for (const like of userLikes) {
      insertUserLike.run(like.user_id, like.track_id, like.liked_at || Math.floor(Date.now() / 1000))
    }

    const insertPlayHistory = db.prepare('INSERT INTO play_history (id, user_id, track_id, seconds_played, session_id, played_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const row of playHistory) {
      insertPlayHistory.run(
        row.id || null,
        row.user_id,
        row.track_id,
        row.seconds_played || 0,
        row.session_id || null,
        row.played_at || Math.floor(Date.now() / 1000)
      )
    }

    const insertListeningEvent = db.prepare('INSERT INTO listening_events (id, user_id, track_id, event_type, source_type, source_id, session_id, seconds_played, track_duration, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const row of listeningEvents) {
      insertListeningEvent.run(
        row.id || null,
        row.user_id,
        row.track_id,
        row.event_type || 'qualified_play',
        row.source_type || null,
        row.source_id || null,
        row.session_id || null,
        row.seconds_played || 0,
        row.track_duration || null,
        row.started_at || null,
        row.ended_at || null,
        row.created_at || Math.floor(Date.now() / 1000)
      )
    }
  })

  restore()

  return {
    ok: true,
    imported: {
      users: users.length,
      artists: artists.length,
      tracks: tracks.length,
      playlists: playlists.length,
      history: playHistory.length,
    },
  }
}

module.exports = { initDB, getDB, getStorageDir, resetAppData, importAppData }
