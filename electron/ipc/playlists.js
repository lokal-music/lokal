const { ipcMain, dialog } = require('electron');
const fsPromises = require('node:fs/promises');
const path = require('path');
const { getDB } = require('./db');
const { buildM3u } = require('../playlists/exportM3u');
const { configuredMusicRoots } = require('../libraryFolder');
const { smartTracks, playlistRules } = require('../playlists/smart');

function parseM3U(fileContent) {
  const lines = fileContent.split(/\r?\n/);
  const entries = [];
  let currentMeta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:(-?\d+),(.+)/);
      if (match) {
        const meta = match[2].trim();
        const dashIndex = meta.lastIndexOf(' - ');
        if (dashIndex > 0) {
          currentMeta = { artist: meta.substring(0, dashIndex).trim(), title: meta.substring(dashIndex + 3).trim() };
        } else {
          currentMeta = { title: meta, artist: null };
        }
      } else {
        currentMeta = null;
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    entries.push({ file_path: line, title: currentMeta?.title || null, artist: currentMeta?.artist || null });
    currentMeta = null;
  }
  return entries;
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result.map(s => s.trim());
}

function firstGenre(value) {
  return String(value || '').split(',').map(part => part.trim()).filter(Boolean)[0] || null
}

function normalizeArtistList(value) {
  const parts = String(value || '')
    .split(/\s*[;,]\s*/)
    .map(part => part.trim())
    .filter(Boolean)
  return parts.length ? [...new Set(parts)].join(', ') : null
}

function normalizeGenres(value) {
  const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean)
  return parts.length ? [...new Set(parts)].join(', ') : null
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseExplicit(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 0
  return ['1', 'true', 'yes', 'y', 'explicit'].includes(normalized) ? 1 : 0
}

const { normalizeIsrc } = require('../quality')

function parseCSV(fileContent) {
  const lines = fileContent.split(/\r?\n/).filter(l => l.trim())
  const entries = []
  if (lines.length < 1) return entries
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase())
  const findCol = names => headers.findIndex(h => names.some(n => h === n || h.includes(n)))
  const titleCol = findCol(['track name', 'trackname', 'song title', 'title', 'name'])
  const artistCol = findCol(['artist name', 'artist', 'performer'])
  const albumCol = findCol(['album name', 'album'])
  const durationCol = findCol(['duration_ms', 'duration ms', 'duration'])
  const urlCol = findCol(['track url', 'url', 'spotify uri', 'uri', 'apple music url', 'youtube url'])
  const genreCol = findCol(['genres', 'genre'])
  const labelCol = findCol(['record label', 'label'])
  const explicitCol = findCol(['explicit'])
  const releaseDateCol = findCol(['release date', 'release_date', 'year'])
  const danceabilityCol = findCol(['danceability'])
  const energyCol = findCol(['energy'])
  const keyCol = findCol(['track key', 'key'])
  const loudnessCol = findCol(['loudness'])
  const modeCol = findCol(['mode'])
  const speechinessCol = findCol(['speechiness'])
  const acousticnessCol = findCol(['acousticness'])
  const instrumentalnessCol = findCol(['instrumentalness'])
  const livenessCol = findCol(['liveness'])
  const valenceCol = findCol(['valence'])
  const tempoCol = findCol(['tempo'])
  const timeSignatureCol = findCol(['time signature'])
  const isrcCol = findCol(['isrc'])
  if (titleCol === -1) return entries
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i])
    const title = values[titleCol]
    const artist = artistCol !== -1 ? normalizeArtistList(values[artistCol]) : null
    const album = albumCol !== -1 ? values[albumCol] : null
    const genres = genreCol !== -1 ? normalizeGenres(values[genreCol]) : null
    const releaseDate = releaseDateCol !== -1 ? values[releaseDateCol] : null
    if (title) entries.push({
      title,
      artist,
      album,
      duration: durationCol !== -1 ? require('../playlists/importDuration').csvDuration(values[durationCol], headers[durationCol]) : null,
      source_url: urlCol !== -1 ? values[urlCol] : null,
      genres,
      genre: firstGenre(genres),
      record_label: labelCol !== -1 ? values[labelCol] || null : null,
      explicit: explicitCol !== -1 ? parseExplicit(values[explicitCol]) : 0,
      year: releaseDate ? parseInteger(String(releaseDate).slice(0, 4)) : null,
      danceability: danceabilityCol !== -1 ? parseNumber(values[danceabilityCol]) : null,
      energy: energyCol !== -1 ? parseNumber(values[energyCol]) : null,
      track_key: keyCol !== -1 ? parseInteger(values[keyCol]) : null,
      loudness: loudnessCol !== -1 ? parseNumber(values[loudnessCol]) : null,
      mode: modeCol !== -1 ? parseInteger(values[modeCol]) : null,
      speechiness: speechinessCol !== -1 ? parseNumber(values[speechinessCol]) : null,
      acousticness: acousticnessCol !== -1 ? parseNumber(values[acousticnessCol]) : null,
      instrumentalness: instrumentalnessCol !== -1 ? parseNumber(values[instrumentalnessCol]) : null,
      liveness: livenessCol !== -1 ? parseNumber(values[livenessCol]) : null,
      valence: valenceCol !== -1 ? parseNumber(values[valenceCol]) : null,
      tempo: tempoCol !== -1 ? parseNumber(values[tempoCol]) : null,
      time_signature: timeSignatureCol !== -1 ? parseInteger(values[timeSignatureCol]) : null,
      // Exportify and similar exports have it: matches the exact recording.
      isrc: isrcCol !== -1 ? normalizeIsrc(values[isrcCol]) : null,
    })
  }
  return entries
}

function parseJSON(fileContent) {
  try {
    const json = JSON.parse(fileContent);
    if (Array.isArray(json)) {
      return json.map(t => ({
        title: t.title || t.name || null,
        artist: normalizeArtistList(t.artist || t.artistName || t.performer || null),
        album: t.album || t.albumName || null,
        file_path: t.file_path || t.path || null,
        duration: t.duration || t.duration_ms || null,
        source_url: t.source_url || t.url || t.uri || null,
        genres: normalizeGenres(t.genres || t.genre),
        genre: firstGenre(t.genres || t.genre),
        record_label: t.record_label || t.label || null,
        explicit: parseExplicit(t.explicit),
        year: parseInteger(t.year || String(t.release_date || '').slice(0, 4)),
        danceability: parseNumber(t.danceability),
        energy: parseNumber(t.energy),
        track_key: parseInteger(t.track_key ?? t.key),
        loudness: parseNumber(t.loudness),
        mode: parseInteger(t.mode),
        speechiness: parseNumber(t.speechiness),
        acousticness: parseNumber(t.acousticness),
        instrumentalness: parseNumber(t.instrumentalness),
        liveness: parseNumber(t.liveness),
        valence: parseNumber(t.valence),
        tempo: parseNumber(t.tempo),
        time_signature: parseInteger(t.time_signature ?? t.timeSignature),
      })).filter(t => t.title || t.file_path);
    }
    if (Array.isArray(json.tracks)) {
      return json.tracks.map(t => ({
        title: t.title || t.name || null,
        artist: normalizeArtistList(t.artist || t.artistName || null),
        album: t.album || t.albumName || null,
        file_path: t.file_path || t.path || null,
        duration: t.duration || t.duration_ms || null,
        source_url: t.source_url || t.url || t.uri || null,
        genres: normalizeGenres(t.genres || t.genre),
        genre: firstGenre(t.genres || t.genre),
        record_label: t.record_label || t.label || null,
        explicit: parseExplicit(t.explicit),
        year: parseInteger(t.year || String(t.release_date || '').slice(0, 4)),
        danceability: parseNumber(t.danceability),
        energy: parseNumber(t.energy),
        track_key: parseInteger(t.track_key ?? t.key),
        loudness: parseNumber(t.loudness),
        mode: parseInteger(t.mode),
        speechiness: parseNumber(t.speechiness),
        acousticness: parseNumber(t.acousticness),
        instrumentalness: parseNumber(t.instrumentalness),
        liveness: parseNumber(t.liveness),
        valence: parseNumber(t.valence),
        tempo: parseNumber(t.tempo),
        time_signature: parseInteger(t.time_signature ?? t.timeSignature),
      })).filter(t => t.title || t.file_path);
    }
  } catch {}
  return [];
}

function normalizeImportEntry(entry = {}) {
  return {
    ...entry,
    artist: normalizeArtistList(entry.artist),
    album_artist: normalizeArtistList(entry.album_artist),
  }
}

function parseImportEntries(fileContent, fileType) {
  let entries = []
  if (fileType === 'm3u' || fileType === 'm3u8') entries = parseM3U(fileContent);
  else if (fileType === 'csv') entries = parseCSV(fileContent);
  else if (fileType === 'json') entries = parseJSON(fileContent);
  else if (fileType === 'txt') entries = require('../playlists/textList').parseTextList(fileContent);
  return entries.map(normalizeImportEntry);
}

function collectImportEntries(payload = {}) {
  const files = Array.isArray(payload.files) && payload.files.length
    ? payload.files
    : [{ fileContent: payload.fileContent || '', fileType: payload.fileType || 'csv', fileName: payload.fileName || '' }]

  const entries = []
  const fileSummaries = []
  for (const file of files) {
    const fileType = file?.fileType || 'csv'
    const parsed = parseImportEntries(file?.fileContent || '', fileType)
    fileSummaries.push({
      fileName: file?.fileName || '',
      fileType,
      total: parsed.length,
    })
    entries.push(...parsed)
  }

  return {
    entries,
    fileCount: files.filter(file => file?.fileContent || file?.fileName).length,
    fileSummaries,
  }
}

function normalizeMatchValue(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(?:feat|ft|featuring|remaster(?:ed)?|deluxe|radio edit|explicit|clean|version|mix)\b/gi, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTrack(db, entry) {
  let track = null;
  // Same ISRC: the same recording, whatever the names say.
  const isrc = normalizeIsrc(entry.isrc || entry.ISRC)
  if (isrc) {
    track = db.prepare("SELECT id FROM tracks WHERE isrc = ? AND file_path NOT LIKE 'ghost://%' LIMIT 1").get(isrc);
    if (track) return track;
  }
  const normalizedArtist = normalizeArtistList(entry.artist)
  const primaryArtist = String(normalizedArtist || '').split(/\s*,\s*/).map(s => s.trim()).filter(Boolean)[0] || null;
  if (entry.file_path) {
    track = db.prepare("SELECT id FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND file_path = ?").get(entry.file_path);
    if (!track) {
      const filename = entry.file_path.split(/[/\\]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
      track = db.prepare("SELECT id FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND LOWER(title) = ? LIMIT 1").get(filename);
    }
  }
  if (!track && entry.title && normalizedArtist) {
    track = db.prepare("SELECT id FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND LOWER(title) = ? AND LOWER(artist) = ? LIMIT 1").get(entry.title.toLowerCase(), normalizedArtist.toLowerCase());
  }
  if (!track && entry.title && primaryArtist) {
    track = db.prepare("SELECT id FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND LOWER(title) = ? AND (LOWER(artist) = ? OR LOWER(artist) LIKE ?) LIMIT 1").get(entry.title.toLowerCase(), primaryArtist.toLowerCase(), `%${primaryArtist.toLowerCase()}%`);
  }
  if (!track && entry.title && !normalizedArtist) {
    track = db.prepare("SELECT id FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND LOWER(title) = ? LIMIT 1").get(entry.title.toLowerCase());
  }
  if (!track && entry.title && normalizedArtist) {
    const titleNorm = normalizeMatchValue(entry.title);
    const artistNorm = normalizeMatchValue(normalizedArtist);
    const candidates = db.prepare("SELECT id, title, artist FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND LOWER(title) LIKE ? LIMIT 50").all(`%${entry.title.toLowerCase().slice(0, 18)}%`);
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const candidateTitle = normalizeMatchValue(candidate.title);
      const candidateArtist = normalizeMatchValue(candidate.artist);
      let score = 0;
      if (candidateTitle === titleNorm) score += 70;
      else if (candidateTitle.includes(titleNorm) || titleNorm.includes(candidateTitle)) score += 45;
      if (candidateArtist === artistNorm) score += 30;
      else if (candidateArtist.includes(artistNorm) || artistNorm.includes(candidateArtist)) score += 18;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best && bestScore >= 72) {
      track = { id: best.id };
    }
  }
  return track;
}

function scoreTrackMatch(track, entry = {}) {
  const titleNorm = normalizeMatchValue(entry.title)
  const artistNorm = normalizeMatchValue(normalizeArtistList(entry.artist))
  const albumNorm = normalizeMatchValue(entry.album)
  const trackTitleNorm = normalizeMatchValue(track?.title)
  const trackArtistNorm = normalizeMatchValue(track?.artist)
  const trackAlbumNorm = normalizeMatchValue(track?.album)
  let score = 0

  if (!titleNorm || !trackTitleNorm) return score

  if (trackTitleNorm === titleNorm) score += 70
  else if (trackTitleNorm.includes(titleNorm) || titleNorm.includes(trackTitleNorm)) score += 45

  if (artistNorm && trackArtistNorm) {
    if (trackArtistNorm === artistNorm) score += 30
    else if (trackArtistNorm.includes(artistNorm) || artistNorm.includes(trackArtistNorm)) score += 18
  }

  if (albumNorm && trackAlbumNorm) {
    if (trackAlbumNorm === albumNorm) score += 12
    else if (trackAlbumNorm.includes(albumNorm) || albumNorm.includes(trackAlbumNorm)) score += 6
  }

  return score
}

function queuePendingImportedMetadata(db, entry = {}, sourcePlatform = 'generic') {
  const title = String(entry.title || '').trim()
  if (!title) return null
  db.prepare(`
    INSERT INTO pending_import_metadata (
      id, title, normalized_title, artist, normalized_artist, album, normalized_album,
      year, genre, genres, record_label, explicit, danceability, energy, track_key, loudness,
      mode, speechiness, acousticness, instrumentalness, liveness, valence, tempo, time_signature,
      duration, source_url, source_platform, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `pim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    normalizeMatchValue(title),
    normalizeArtistList(entry.artist) || null,
    normalizeMatchValue(normalizeArtistList(entry.artist)),
    entry.album || null,
    normalizeMatchValue(entry.album),
    entry.year ?? null,
    entry.genre || firstGenre(entry.genres),
    entry.genres || null,
    entry.record_label || null,
    entry.explicit === undefined || entry.explicit === null || entry.explicit === '' ? null : (entry.explicit ? 1 : 0),
    entry.danceability ?? null,
    entry.energy ?? null,
    entry.track_key ?? null,
    entry.loudness ?? null,
    entry.mode ?? null,
    entry.speechiness ?? null,
    entry.acousticness ?? null,
    entry.instrumentalness ?? null,
    entry.liveness ?? null,
    entry.valence ?? null,
    entry.tempo ?? null,
    entry.time_signature ?? null,
    entry.duration ?? null,
    entry.source_url || null,
    sourcePlatform || 'generic',
    Date.now()
  )
  return true
}

function applyPendingImportedMetadataToTrack(db, trackId) {
  const track = db.prepare("SELECT * FROM tracks WHERE id = ? AND file_path NOT LIKE 'ghost://%'").get(trackId)
  if (!track) return { matched: 0 }

  const titleNorm = normalizeMatchValue(track.title)
  if (!titleNorm) return { matched: 0 }

  const candidates = db.prepare(`
    SELECT *
    FROM pending_import_metadata
    WHERE normalized_title = ?
       OR normalized_title LIKE ?
       OR ? LIKE '%' || normalized_title || '%'
    ORDER BY created_at ASC
  `).all(titleNorm, `%${titleNorm}%`, titleNorm)

  const matchedIds = []
  for (const candidate of candidates) {
    const score = scoreTrackMatch(track, candidate)
    if (score >= 72) {
      applyImportedMetadata(db, trackId, candidate)
      matchedIds.push(candidate.id)
    }
  }

  if (matchedIds.length) {
    const deletePending = db.prepare('DELETE FROM pending_import_metadata WHERE id = ?')
    for (const id of matchedIds) deletePending.run(id)
  }

  return { matched: matchedIds.length }
}

function createGhostTrack(db, entry, sourcePlatform = 'generic', playlistId = 'import') {
  const id = `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safePlatform = String(sourcePlatform || 'generic').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'generic';
  const title = String(entry.title || 'Unknown Track').trim() || 'Unknown Track';
  const artist = normalizeArtistList(entry.artist) || 'Unknown Artist';
  const filePath = `ghost://${safePlatform}/${playlistId}/${id}`;
  db.prepare(`
    INSERT INTO tracks
    (id, file_path, file_hash, title, artist, album, album_artist, track_num, year, genre, genres, record_label, explicit, danceability, energy, track_key, loudness, mode, speechiness, acousticness, instrumentalness, liveness, valence, tempo, time_signature, duration, artwork_path, bitrate, last_modified, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    filePath,
    id,
    title,
    artist,
    entry.album || null,
    normalizeArtistList(entry.artist) || null,
    null,
    entry.year || null,
    entry.genre || null,
    entry.genres || null,
    entry.record_label || null,
    entry.explicit ? 1 : 0,
    entry.danceability ?? null,
    entry.energy ?? null,
    entry.track_key ?? null,
    entry.loudness ?? null,
    entry.mode ?? null,
    entry.speechiness ?? null,
    entry.acousticness ?? null,
    entry.instrumentalness ?? null,
    entry.liveness ?? null,
    entry.valence ?? null,
    entry.tempo ?? null,
    entry.time_signature ?? null,
    entry.duration ? Number(entry.duration) : null,
    null,
    null,
    Date.now(),
    // Kept on the track, so a ghost with a YouTube link can be streamed.
    entry.source_url ? String(entry.source_url).slice(0, 1000) : null
  );
  // Kept so the file is matched to this ghost by ISRC when it arrives.
  const ghostIsrc = normalizeIsrc(entry.isrc || entry.ISRC)
  if (ghostIsrc) db.prepare('UPDATE tracks SET isrc = ? WHERE id = ?').run(ghostIsrc, id);
  return { id, title, artist, album: entry.album || null, file_path: filePath, source_url: entry.source_url || null, isGhost: true };
}

function applyImportedMetadata(db, trackId, entry = {}) {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId)
  if (!track) return null
  const genre = entry.genre || firstGenre(entry.genres)
  const genres = entry.genres || null
  const explicitValue = entry.explicit ? 1 : 0
  db.prepare(`
    UPDATE tracks SET
      year = COALESCE(?, year),
      genre = COALESCE(NULLIF(?, ''), genre),
      genres = COALESCE(NULLIF(?, ''), genres),
      record_label = COALESCE(NULLIF(?, ''), record_label),
      explicit = CASE WHEN ? IS NULL THEN explicit ELSE ? END,
      danceability = COALESCE(?, danceability),
      energy = COALESCE(?, energy),
      track_key = COALESCE(?, track_key),
      loudness = COALESCE(?, loudness),
      mode = COALESCE(?, mode),
      speechiness = COALESCE(?, speechiness),
      acousticness = COALESCE(?, acousticness),
      instrumentalness = COALESCE(?, instrumentalness),
      liveness = COALESCE(?, liveness),
      valence = COALESCE(?, valence),
      tempo = COALESCE(?, tempo),
      time_signature = COALESCE(?, time_signature)
    WHERE id = ?
  `).run(
    entry.year ?? null,
    genre,
    genres,
    entry.record_label || null,
    entry.explicit === undefined || entry.explicit === null || entry.explicit === '' ? null : explicitValue,
    entry.explicit === undefined || entry.explicit === null || entry.explicit === '' ? null : explicitValue,
    entry.danceability ?? null,
    entry.energy ?? null,
    entry.track_key ?? null,
    entry.loudness ?? null,
    entry.mode ?? null,
    entry.speechiness ?? null,
    entry.acousticness ?? null,
    entry.instrumentalness ?? null,
    entry.liveness ?? null,
    entry.valence ?? null,
    entry.tempo ?? null,
    entry.time_signature ?? null,
    trackId
  )
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId)
}

function buildImportPreview(db, entries = []) {
  const preview = [];
  let matched = 0;
  for (const entry of entries) {
    const track = findTrack(db, entry);
    if (track) matched++;
    preview.push({
      title: entry.title || path.basename(entry.file_path || '').replace(/\.[^.]+$/, '') || 'Unknown Track',
      artist: entry.artist || 'Unknown Artist',
      album: entry.album || null,
      status: track ? 'Matched' : 'Ghost Song',
      action: track ? 'Already in library' : 'Try auto-match, download, or pick a local file',
    });
  }
  return {
    total: entries.length,
    matched,
    ghostable: Math.max(entries.length - matched, 0),
    rows: preview.slice(0, 12),
  };
}

function resolveGhostTrack(db, ghostTrackId, targetTrackId, sourceIdentity = null, options = {}) {
  return require('../../server/routes/playlists').resolveGhostTrack(db, ghostTrackId, targetTrackId, sourceIdentity, options)
}

/**
 * A file with an ISRC just came in: ghost tracks with the same ISRC (from an
 * import) are that recording, so they resolve to it at once.
 */
function resolveGhostsByIsrc(db, trackId) {
  const track = db.prepare("SELECT id, isrc FROM tracks WHERE id = ? AND file_path NOT LIKE 'ghost://%'").get(trackId)
  if (!track?.isrc) return 0
  const ghosts = db.prepare("SELECT id FROM tracks WHERE isrc = ? AND file_path LIKE 'ghost://%'").all(track.isrc)
  let resolved = 0
  for (const ghost of ghosts) if (resolveGhostTrack(db, ghost.id, track.id)?.ok) resolved++
  return resolved
}

function importExternalMetadata(db, payload = {}) {
  const { sourcePlatform = 'generic' } = payload || {}
  const { entries, fileCount } = collectImportEntries(payload)
  let matched = 0
  let savedForLater = 0
  const unmatched = []
  for (const entry of entries) {
    const track = findTrack(db, entry)
    if (!track) {
      queuePendingImportedMetadata(db, entry, sourcePlatform)
      savedForLater++
      unmatched.push({
        title: entry.title || 'Unknown Track',
        artist: entry.artist || 'Unknown Artist',
        album: entry.album || null,
      })
      continue
    }
    applyImportedMetadata(db, track.id, { ...entry, sourcePlatform })
    matched++
  }
  return {
    ok: true,
    fileCount,
    total: entries.length,
    matched,
    skipped: Math.max(entries.length - matched, 0),
    savedForLater,
    unmatched: unmatched.slice(0, 50),
  }
}

function registerPlaylistHandlers() {
  // Native Save dialog + database read: order, source paths, and user scope
  // come from the persisted playlist rather than filtered/sorted UI rows.
  ipcMain.handle('playlist:exportFile', async (_, payload = {}) => {
    try {
      const { playlistId, userId = 'guest', format = 'm3u8' } = payload || {};
      if (!['m3u', 'm3u8'].includes(format)) return { error: 'Unsupported playlist format.' };
      if (typeof playlistId !== 'string' || !playlistId) return { error: 'No playlist selected.' };
      const uid = String(userId || 'guest');
      const db = getDB();
      let name;
      let tracks;
      if (playlistId === 'liked') {
        name = 'Liked Songs';
        require('../online/sources').foldStreamedLikes(db, uid);
        tracks = db.prepare('SELECT t.file_path FROM tracks t JOIN user_likes ul ON ul.track_id = t.id WHERE ul.user_id = ? ORDER BY ul.liked_at DESC').all(uid);
      } else {
        const playlist = db.prepare('SELECT name, user_id, smart_rules FROM playlists WHERE id = ?').get(playlistId);
        if (!playlist || String(playlist.user_id || 'guest') !== uid) return { error: 'Playlist not found.' };
        name = playlist.name;
        tracks = playlistRules(playlist)
          ? smartTracks(db, playlist.smart_rules, playlist.user_id)
          : db.prepare('SELECT t.file_path FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id WHERE pt.playlist_id = ? ORDER BY pt.position, link_track_key(t.artist,t.title,t.duration)').all(playlistId);
      }
      // Windows invalid filename characters and reserved suffixes must not
      // leak into a suggested name, even if the playlist title contains them.
      const stem = String(name || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 100) || 'Playlist';
      const saved = await dialog.showSaveDialog({
        title: 'Export playlist',
        defaultPath: stem + '.' + format,
        buttonLabel: 'Export',
        filters: [{ name: format.toUpperCase() + ' playlist', extensions: [format] }],
      });
      if (saved.canceled || !saved.filePath) return { canceled: true };
      const { content, ...summary } = buildM3u(tracks, saved.filePath, { roots: configuredMusicRoots(db) });
      if (!summary.exported) return { error: 'No available local files in this playlist to export.', ...summary };
      await fsPromises.writeFile(saved.filePath, content, 'utf8');
      return { ok: true, filePath: saved.filePath, format, ...summary };
    } catch (error) {
      console.error('Playlist export failed:', error);
      return { error: error.message || 'Could not export playlist.' };
    }
  });

  ipcMain.handle('playlist:import', async (event, ...args) => {
    let payload;
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) payload = args[0];
    else payload = { name: args[0], entries: args[1] || [], userId: args[2] };
    const { name, entries = [], userId } = payload;
    const db = getDB();
    const playlistId = 'pl-' + Date.now();
    const uid = userId || 'guest';
    console.log('IPC Import UID:', uid);
    try {
      db.prepare('INSERT INTO playlists (id, name, user_id) VALUES (?, ?, ?)').run(playlistId, name, uid);
      let matched = 0;
      for (const entry of entries) {
        const track = findTrack(db, entry);
        if (track) {
          const max = db.prepare('SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
          db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(
            playlistId,
            track.id,
            (max?.m || 0) + 1,
            uid,
            Date.now()
          );
          matched++;
        }
      }
      return { playlistId, name, matched, total: entries.length };
    } catch (e) {
      console.error('Import Error:', e);
      return { error: e.message };
    }
  });

  ipcMain.handle('playlist:importFile', async (event, ...args) => {
    let payload;
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) payload = args[0];
    else payload = { name: args[0], fileContent: args[1], fileType: args[2], userId: args[3] };
    const { name, fileContent = '', fileType = 'm3u', userId } = payload;
    const db = getDB();
    const playlistId = 'pl-' + Date.now();
    const uid = userId || 'guest';
    console.log('IPC Import-File UID:', uid);
    try {
      db.prepare('INSERT INTO playlists (id, name, user_id) VALUES (?, ?, ?)').run(playlistId, name, uid);
      let entries = [];
      if (fileType === 'm3u' || fileType === 'm3u8') entries = parseM3U(fileContent);
      else if (fileType === 'csv') entries = parseCSV(fileContent);
      else if (fileType === 'json') {
        try {
          const json = JSON.parse(fileContent);
          if (Array.isArray(json.tracks)) entries = json.tracks.map(t => ({ title: t.title || null, artist: t.artist || null, file_path: t.file_path || null }));
        } catch (e) {}
      }
      let matched = 0;
      const unmatched = [];
      for (const entry of entries) {
        const track = findTrack(db, entry);
        if (track) {
          const max = db.prepare('SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
          db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(
            playlistId,
            track.id,
            (max?.m || 0) + 1,
            uid,
            Date.now()
          );
          matched++;
        } else {
          unmatched.push({ title: entry.title, artist: entry.artist });
        }
      }
      return { created: name, matched, total: entries.length, unmatched, playlistId };
    } catch (e) {
      console.error('Import File Error:', e);
      return { error: e.message };
    }
  });

  ipcMain.handle('playlist:previewExternalImport', async (event, payload = {}) => {
    try {
      const { entries, fileCount, fileSummaries } = collectImportEntries(payload);
      const db = getDB();
      return {
        ok: true,
        fileType: payload?.fileType || payload?.files?.[0]?.fileType || 'csv',
        fileCount,
        files: fileSummaries,
        ...buildImportPreview(db, entries),
      };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('playlist:importExternalFile', async (event, payload = {}) => {
    const { name, userId, sourcePlatform = 'generic' } = payload || {};
    const db = getDB();
    const playlistId = 'pl-' + Date.now();
    const uid = userId || 'guest';
    try {
      const { entries, fileCount } = collectImportEntries(payload);
      db.prepare('INSERT INTO playlists (id, name, user_id) VALUES (?, ?, ?)').run(playlistId, name, uid);
      let matched = 0;
      let ghosted = 0;
      const unresolved = [];
      for (const entry of entries) {
        let track = findTrack(db, entry);
        if (!track) {
          track = createGhostTrack(db, entry, sourcePlatform, playlistId);
          ghosted++;
          unresolved.push({
            title: track.title,
            artist: track.artist,
            album: track.album,
            status: 'Ghost Song',
            action: 'Search YouTube, download, pick local file, or skip',
          });
        } else {
          applyImportedMetadata(db, track.id, entry)
          matched++;
        }
        const max = db.prepare('SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
        db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(
          playlistId,
          track.id,
          (max?.m || 0) + 1,
          uid,
          Date.now()
        );
      }
      return {
        ok: true,
        playlistId,
        name,
        fileCount,
        total: entries.length,
        matched,
        ghosted,
        unresolved: unresolved.slice(0, 50),
      };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('playlist:previewLink', async (event, payload = {}) => {
    try {
      const linkImport = require('../playlists/linkImport');
      const { manager } = require('./downloader');
      const { findYtDlp } = require('./tools');
      const playlist = await linkImport.fetchPlaylist({ ytdlp: findYtDlp(), url: payload?.url, settings: manager().settings(), db: getDB() });
      if (playlist.error) return { error: playlist.error };
      const { rows, matched, ghostable } = await linkImport.previewEntries(getDB(), playlist.entries, { findTrack });
      return { ok: true, title: playlist.title, owner: playlist.owner, platform: playlist.platform, total: rows.length, matched, ghostable, skipped: playlist.skipped, truncated: playlist.truncated, limit: playlist.limit, entries: rows };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('playlist:importLink', async (event, payload = {}) => {
    try {
      const linkImport = require('../playlists/linkImport');
      const name = String(payload?.name || '').trim().slice(0, 200);
      if (!name) return { error: 'Please enter a playlist name' };
      const entries = linkImport.sanitizeEntries(payload?.entries);
      if (!entries.length) return { error: 'No tracks selected' };
      const result = await linkImport.importLinkEntries(getDB(), {
        name,
        userId: payload?.userId,
        entries,
        platform: linkImport.platformOf(entries[0].source_url),
        helpers: { findTrack, createGhostTrack },
      });
      let downloads = null;
      if (payload?.downloadAfter && result.ghosts.length) {
        const { manager } = require('./downloader');
        downloads = linkImport.queueGhostDownloads(manager(), result.ghosts);
      }
      const { ghosts, ...summary } = result;
      return { ok: true, ...summary, downloads };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('playlist:importExternalMetadata', async (event, payload = {}) => {
    try {
      return importExternalMetadata(getDB(), payload)
    } catch (e) {
      return { error: e.message }
    }
  });

  // Linked streaming playlists (electron/playlists/sync.js).
  ipcMain.handle('playlist:syncStatus', (_, playlistId) => { try { return require('../playlists/sync').status(getDB(), playlistId) } catch (e) { return { error: e.message } } });
  ipcMain.handle('playlist:syncLink', (_, playlistId, url) => { try { return require('../playlists/sync').link(getDB(), playlistId, url) } catch (e) { return { error: e.message } } });
  ipcMain.handle('playlist:syncUnlink', (_, playlistId) => { try { return require('../playlists/sync').unlink(getDB(), playlistId) } catch (e) { return { error: e.message } } });
  ipcMain.handle('playlist:syncLinked', () => { try { return require('../playlists/sync').linked(getDB()) } catch { return [] } });
  ipcMain.handle('playlist:sync', async (_, playlistId, userId) => {
    try {
      return await require('../playlists/sync').sync(getDB(), playlistId, { packages: require('../mornye/packages').service(getDB()), helpers: { findTrack, createGhostTrack, readPlaylist: url => require('../playlists/linkImport').fetchPlaylist({ ytdlp: require('./tools').findYtDlp(), url, settings: require('./downloader').manager().settings(), db: getDB() }) }, userId: userId || 'guest' });
    } catch (e) { return { error: e.message } }
  });

  ipcMain.handle('playlist:resolveGhostTrack', async (event, ghostTrackId, targetTrackId, options = {}) => {
    try {
      return resolveGhostTrack(getDB(), ghostTrackId, targetTrackId, null, options || {});
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = {
  registerPlaylistHandlers,
  applyPendingImportedMetadataToTrack,
  resolveGhostTrack,
  resolveGhostsByIsrc,
};
