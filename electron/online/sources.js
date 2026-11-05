// Online sources for search results that aren't in the library, played
// through the user's own yt-dlp:
//
//   yt  YouTube Music (youtube.js): its own Songs search, full tracks
//   sc  SoundCloud (soundcloud.js): yt-dlp search, progressive MP3; Go+
//       tracks only give a 30-second preview
//   a-<key>  addons the user installed from a manifest URL (addons.js)
//
// Shared by the desktop app (IPC + lokal-stream://<provider>/<id>) and the web
// server (/api/online). An online song that's played, liked or added to a
// playlist is kept as a ghost track (ghost://<platform>/online/<id>), so
// playlists, likes and history work as for any track, while the library,
// albums, artists and mixes keep ignoring it. Saving it to the library swaps
// the ghost for the downloaded file.

const crypto = require('crypto')
const yt = require('./youtube')
const sc = require('./soundcloud')
const mono = require('./monochrome')
const addons = require('./addons')

const PROVIDERS = {
  yt: { id: 'yt', label: 'YouTube Music', platform: 'youtube', idPattern: /^[\w-]{11}$/, sourceUrl: id => `https://music.youtube.com/watch?v=${id}` },
  sc: { id: 'sc', label: 'SoundCloud', platform: 'soundcloud', idPattern: /^\d{1,20}$/, sourceUrl: id => sc.trackUrl(id) },
  mono: { id: 'mono', label: 'Monochrome', platform: 'monochrome', idPattern: mono.TRACK_ID, sourceUrl: id => mono.trackUrl(id) },
}
const PLATFORM_TO_PROVIDER = { youtube: 'yt', soundcloud: 'sc', monochrome: 'mono' }

/** A built-in provider, or an addon provider ("a-<key>"), or null. */
function providerOf(id) {
  if (PROVIDERS[id]) return PROVIDERS[id]
  const key = addons.keyOfProvider(id)
  return key ? { id, addonKey: key, platform: 'addon', idPattern: /^[^\n\r]{1,300}$/, sourceUrl: () => null } : null
}

/** Is `id` a well-formed item id for `provider`? */
function validId(provider, id) {
  const p = providerOf(provider)
  return !!p && p.idPattern.test(String(id ?? ''))
}

// ---------------------------------------------------------------- search

/** YouTube Music results in the shared shape ({ provider, id, ... }). */
function fromYouTube(r) {
  return { ...r, provider: 'yt', id: r.videoId }
}

/**
 * Songs for `query` on one provider. YouTube Music falls back to plain
 * YouTube search through yt-dlp if YouTube Music can't be reached.
 * @param fallbackSearch (query) => Promise<results in the yt shape>, optional
 */
async function search(provider, query, { db, ytdlp, fetchImpl, fallbackSearch, limit = 10, addonTimeoutMs } = {}) {
  const key = addons.keyOfProvider(provider)
  if (key) return { results: await addons.search(db, key, query, { fetchImpl, limit: 20, timeoutMs: addonTimeoutMs }) }
  if (provider === 'sc') return { results: await sc.searchTracks(query, { ytdlp, limit }) }
  if (provider === 'mono') return { results: await mono.searchTracks(query, { limit, fetchImpl }) }
  try {
    return { results: (await yt.searchSongs(query, { limit, fetchImpl })).map(fromYouTube) }
  } catch (e) {
    if (!fallbackSearch) throw e
    return { fallback: true, results: (await fallbackSearch(query)).map(fromYouTube) }
  }
}

// ---------------------------------------------------------------- streams

/** Resolve (or reuse) the stream of an item. */
function resolveStream(provider, id, opts = {}) {
  if (!validId(provider, id)) return Promise.reject(new Error('Unknown online song'))
  const key = addons.keyOfProvider(provider)
  if (key) return addons.resolveStream(opts.db, key, id, { force: opts.force, download: opts.download, fetchImpl: opts.addonFetch, signal: opts.signal, timeoutMs: opts.addonTimeoutMs })
  if (provider === 'mono') return mono.resolveStream(id)
  return provider === 'sc' ? sc.resolveStream(id, opts) : yt.resolveStream(id, opts)
}

// How long an addon's media server may take to start answering (per
// attempt; resolving the stream has its own timeout in addons.js).
const ADDON_MEDIA_TIMEOUT_MS = 20000

/** Fetch an addon's media: checked redirects, a timeout, and cancelled with `signal`. */
async function fetchAddonMedia(url, { fetchImpl, headers, signal }) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  // The player went away (skipped, closed): stop fetching, body included.
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener?.('abort', cancel, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, ADDON_MEDIA_TIMEOUT_MS)
  try {
    return await addons.fetchChecked(url, { fetchImpl, headers, signal: controller.signal })
  } catch (e) {
    signal?.removeEventListener?.('abort', cancel)
    if (timedOut) throw new Error("The addon's audio server took too long to answer.")
    throw e
  } finally {
    // Only the wait for the answer is timed: the song itself streams as long as it lasts.
    clearTimeout(timer)
  }
}

/**
 * Fetch (a range of) the audio of an item. A refused URL (expired, or tied to
 * another address) is looked up again once. `signal`: aborts the media
 * request when the one who asked for it goes away.
 */
function withStreamErrorStage(error, stage) {
  const value = error instanceof Error ? error : new Error(String(error || 'Unknown stream error'))
  try { if (!value.streamStage) value.streamStage = stage } catch {}
  return value
}

async function fetchStream(provider, id, { range, fetchImpl = fetch, signal, ...opts } = {}) {
  const attempt = async (force) => {
    let stream
    try {
      opts.onPhase?.('resolving')
      stream = await resolveStream(provider, id, { ...opts, force, signal })
      opts.onPhase?.('fetching')
    } catch (error) {
      throw withStreamErrorStage(error, 'resolve')
    }
    try {
      if (stream.type === 'live') return { stream, res: await require('../mornye/media').liveResponse(stream.job, { range, signal, mime: stream.mime }) }
      if (stream.type === 'file') return { stream, res: await require('../mornye/media').fileResponse(stream.file, { range, signal, mime: stream.mime }) }
      const headers = { ...stream.headers }
      if (range) headers.Range = range
      // An addon's media URL is the addon's to choose: follow its redirects one
      // at a time, each checked like the addon's own URLs (https, or http on
      // this machine / network only). Built-in providers fetch directly.
      if (addons.keyOfProvider(provider)) return { stream, res: await fetchAddonMedia(stream.url, { fetchImpl, headers, signal }) }
      return { stream, res: await fetchImpl(stream.url, { headers, signal }) }
    } catch (error) {
      throw withStreamErrorStage(error, 'media-fetch')
    }
  }
  let { stream, res } = await attempt(false)
  if (res.status === 403 || res.status === 410) {
    try { await res.body?.cancel?.() } catch {}
    ;({ stream, res } = await attempt(true))
  }
  return { res, mime: stream.mime, preview: !!stream.preview }
}

/**
 * `body`, passed on chunk by chunk; cancelling it (the player dropped the
 * stream: skipped, seeked, ended) calls `abort`. Cancelling the body alone
 * doesn't close the request it came from.
 */
function cancellableBody(body, abort, onFirstChunk) {
  if (!body?.getReader) return body
  const reader = body.getReader()
  let reported = false
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else {
          // One startup event only. Avoid streaming IPC updates (and a second
          // TransformStream) for every packet throughout the entire song.
          if (!reported && value?.byteLength) {
            reported = true
            try { onFirstChunk?.(value.byteLength) } catch {}
          }
          controller.enqueue(value)
        }
      } catch (e) { controller.error(e) }
    },
    cancel(reason) {
      abort()
      return reader.cancel(reason).catch(() => {})
    },
  })
}

// ---------------------------------------------------------------- tracks

/** Library id of an online song (addon ids can be anything, so they're hashed). */
function onlineTrackId(provider, id) {
  if (addons.keyOfProvider(provider)) return `${provider}-${crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16)}`
  return `${provider}-${id}`
}

/** ghost:// path of an online song. */
function ghostPath(provider, id) {
  const key = addons.keyOfProvider(provider)
  if (key) return `ghost://addon/${key}/${encodeURIComponent(id)}`
  return `ghost://${providerOf(provider).platform}/online/${id}`
}

/** Where a track can be streamed from ({ provider, id }), or null. */
function streamRef(track) {
  const path = String(track?.file_path || '')
  const fromAddon = path.match(/^ghost:\/\/addon\/([0-9a-f]{10})\/(.+)$/)
  if (fromAddon) {
    try { return { provider: addons.providerFor(fromAddon[1]), id: decodeURIComponent(fromAddon[2]) } } catch { return null }
  }
  const own = path.match(/^ghost:\/\/(youtube|soundcloud|monochrome)\/online\/([\w-]+)$/)
  if (own) {
    const provider = PLATFORM_TO_PROVIDER[own[1]]
    return validId(provider, own[2]) ? { provider, id: own[2] } : null
  }
  if (!path.startsWith('ghost://')) return null
  const videoId = yt.videoIdFromUrl(track?.source_url)
  if (videoId) return { provider: 'yt', id: videoId }
  const trackId = sc.idFromUrl(track?.source_url)
  if (trackId) return { provider: 'sc', id: trackId }
  const monoId = mono.idFromUrl(track?.source_url)
  return monoId ? { provider: 'mono', id: monoId } : null
}

/**
 * What a download URL points at, to check that a download really is the
 * song a ghost track stands for: "yt:<videoId>", "sc:<trackId>", or null.
 */
function sourceIdentity(url) {
  const videoId = yt.videoIdFromUrl(url)
  if (videoId) return `yt:${videoId}`
  const trackId = sc.idFromUrl(url)
  if (trackId) return `sc:${trackId}`
  const monoId = mono.idFromUrl(url)
  return monoId ? `mono:${monoId}` : null
}

// ------------------------------------------------------ the same song, streamed
// Liking (or adding to a playlist) a streamed song, then downloading it from
// anywhere else (another result, an addon, Soulseek, the Download page) left
// both copies in likes and playlists. These find a new file's streamed twins:
// same title and lead artist, lengths within a few seconds. Noise such as
// "(Official Video)" or "(feat. …)" is ignored; "(Remix)", "(Live)", "(… Edit)"
// are not (nor "(Official Remix)", "(Official Live Video)"), so another
// version is never taken for the original. Both lengths must be known.
const NOISE_TAG = /^(?:official(?: (?:music|lyric|hd|4k))?(?: (?:video|audio|visuali[sz]er))?|lyrics?(?: video)?|lyric video|audio|video|music video|visuali[sz]er|hd|hq|4k|mv|explicit|clean|remaster(?:ed)?(?: \d{4})?|\d{4} remaster(?:ed)?|(?:feat|ft|featuring|with)\b.*)$/i
const TWIN_DURATION_SLACK_S = 5

const plainKey = (s) => String(s || '').toLowerCase().replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function titleKey(title) {
  return plainKey(String(title || '').replace(/\s*[([]([^()[\]]*)[)\]]/g, (group, inner) => (NOISE_TAG.test(inner.trim()) ? '' : group)))
}

function leadArtistKey(artist) {
  // "A (feat. B)" / "A [with B]": the credit in brackets goes first.
  const credited = String(artist || '').replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^()[\]]*[)\]]/gi, '')
  // Not on commas: "Tyler, The Creator" is one artist, not Tyler.
  const lead = credited.split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s+&\s+/i)[0]
  return plainKey(lead.replace(/\s*-\s*topic$/i, ''))
}

// "Artist - Song" video titles carry the artist: compare the song part. Only
// with that separator: "Drake Freestyle" by Drake stays "drake freestyle".
const ARTIST_SEPARATOR = /^\s*(.+?)\s+[-–—|]\s+(.+)$/
function songKey(title, artist) {
  const parts = String(title || '').match(ARTIST_SEPARATOR)
  if (parts && leadArtistKey(parts[1]) === artist) return titleKey(parts[2])
  return titleKey(title)
}

/** Are `a` and `b` ({ title, artist, duration }) the same song? */
function sameSong(a, b) {
  const artist = leadArtistKey(a?.artist)
  if (!artist || leadArtistKey(b?.artist) !== artist) return false
  const song = songKey(a.title, artist)
  if (!song || songKey(b.title, artist) !== song) return false
  const x = Number(a.duration) || 0, y = Number(b.duration) || 0
  // An unknown length could be any version: not the same, to be safe.
  return x > 0 && y > 0 && Math.abs(x - y) <= TWIN_DURATION_SLACK_S
}

/** Ids of liked or playlisted streamed tracks that are the same song as `track`. */
function streamedTwins(db, track) {
  if (!leadArtistKey(track?.artist) || !titleKey(track?.title)) return []
  const ghosts = db.prepare(`
    SELECT id, title, artist, duration FROM tracks
    WHERE file_path LIKE 'ghost://%'
      AND (id IN (SELECT track_id FROM user_likes) OR id IN (SELECT track_id FROM playlist_tracks))
  `).all()
  return ghosts.filter(ghost => sameSong(track, ghost)).map(ghost => ghost.id)
}

// ---------------------------------------------------------- downloaded songs
// An online song, the same whichever link it came from: "yt:<videoId>",
// "sc:<trackId>" or "a-<key>:<id>". Downloads keep it (tracks.source_ref).

function sourceRefOf(provider, id) {
  return provider && id ? `${provider}:${id}` : null
}

/** The online song a streamed (ghost) track stands for, or null. */
function sourceRefOfTrack(track) {
  const ref = streamRef(track)
  return ref ? sourceRefOf(ref.provider, ref.id) : null
}

/**
 * The library copy of a streamed track, if there is one: the file it was
 * replaced by, the download of that same online song, or the same song
 * downloaded from elsewhere. Null for a library track, or when there's none.
 */
function libraryCopyOf(db, trackId) {
  if (!trackId) return null
  // On upgrades, the persisted online queue can be read before scanner
  // initialization. Ensure the edition column exists before filtering it.
  try { require('../quality').ensureColumns(db) } catch {}
  try {
    const alias = db.prepare("SELECT t.id FROM track_aliases a JOIN tracks t ON t.id = a.track_id WHERE a.old_id = ? AND t.file_path NOT LIKE 'ghost://%' AND COALESCE(t.atmos_verified, 0) != 1").get(trackId)
    if (alias) return alias.id
  } catch {}
  const track = db.prepare('SELECT id, file_path, source_url, title, artist, duration FROM tracks WHERE id = ?').get(trackId)
  if (!track || !String(track.file_path || '').startsWith('ghost://')) return null
  const ref = sourceRefOfTrack(track)
  if (ref) {
    const hit = db.prepare("SELECT id FROM tracks WHERE source_ref = ? AND file_path NOT LIKE 'ghost://%' AND COALESCE(atmos_verified, 0) != 1 LIMIT 1").get(ref)
    if (hit) return hit.id
  }
  // The same song downloaded from elsewhere. sameSong needs both lengths
  // within a few seconds, so only songs of about that length can match:
  // those are the candidates, each compared the same way as everywhere else.
  const length = Number(track.duration) || 0
  if (!(length > 0)) return null
  const candidates = db.prepare("SELECT id, title, artist, duration FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND COALESCE(atmos_verified, 0) != 1 AND duration BETWEEN ? AND ?")
    .all(length - TWIN_DURATION_SLACK_S, length + TWIN_DURATION_SLACK_S)
  return candidates.find(candidate => sameSong(track, candidate))?.id || null
}

/** `trackId`, or its library copy when it's a streamed track that has one. */
function libraryTrackId(db, trackId) {
  try { return libraryCopyOf(db, trackId) || trackId } catch { return trackId }
}

/**
 * Every id a library song goes by: its own, the streamed copy of the online
 * song it was downloaded from ("sc-<id>"...), and the streamed copies it
 * replaced (a player may still hold one). A heart shows the same on all.
 */
function songIds(db, trackId) {
  const ids = new Set([trackId])
  try {
    const ref = String(db.prepare('SELECT source_ref FROM tracks WHERE id = ?').get(trackId)?.source_ref || '').match(/^([^:]+):(.+)$/)
    if (ref && validId(ref[1], ref[2])) ids.add(onlineTrackId(ref[1], ref[2]))
    for (const row of db.prepare('SELECT old_id FROM track_aliases WHERE track_id = ?').all(trackId)) ids.add(row.old_id)
    // Streamed copies that are the same song by title, artist and length
    // (the match libraryCopyOf makes the other way).
    const track = db.prepare("SELECT title, artist, duration FROM tracks WHERE id = ? AND file_path NOT LIKE 'ghost://%'").get(trackId)
    const length = Number(track?.duration) || 0
    if (length > 0) {
      const ghosts = db.prepare("SELECT id, title, artist, duration FROM tracks WHERE file_path LIKE 'ghost://%' AND duration BETWEEN ? AND ?")
        .all(length - TWIN_DURATION_SLACK_S, length + TWIN_DURATION_SLACK_S)
      for (const ghost of ghosts) if (sameSong(track, ghost)) ids.add(ghost.id)
    }
  } catch {}
  return [...ids]
}

/**
 * Likes left on streamed copies of songs you have (made before likes were
 * kept on the library copy) move to the library copy: one entry per song in
 * Liked Songs.
 */
function foldStreamedLikes(db, userId) {
  try {
    const ghosts = db.prepare("SELECT ul.track_id FROM user_likes ul JOIN tracks t ON t.id = ul.track_id WHERE ul.user_id = ? AND t.file_path LIKE 'ghost://%'").all(userId)
    for (const { track_id: ghostId } of ghosts) {
      const copy = libraryCopyOf(db, ghostId)
      if (!copy) continue
      db.prepare('INSERT OR IGNORE INTO user_likes (user_id, track_id) VALUES (?, ?)').run(userId, copy)
      db.prepare('DELETE FROM user_likes WHERE user_id = ? AND track_id = ?').run(userId, ghostId)
    }
  } catch {}
}

/**
 * Like or unlike a song, from wherever it shows: a streamed copy of a song
 * you have counts as that song, so the like is the library copy's (and an
 * older like on the streamed copy is folded into it). Returns
 * { liked, trackId, ids }: every id the song goes by, to update all hearts.
 */
function toggleSongLike(db, userId, trackId) {
  const id = libraryTrackId(db, trackId)
  const ids = [...new Set([trackId, ...songIds(db, id)])]
  const marks = ids.map(() => '?').join(', ')
  const liked = !!db.prepare(`SELECT 1 FROM user_likes WHERE user_id = ? AND track_id IN (${marks})`).get(userId, ...ids)
  db.prepare(`DELETE FROM user_likes WHERE user_id = ? AND track_id IN (${marks})`).run(userId, ...ids)
  if (!liked) db.prepare('INSERT OR IGNORE INTO user_likes (user_id, track_id) VALUES (?, ?)').run(userId, id)
  return { liked: !liked, trackId: id, ids }
}

/** Set a song's local like state without toggling it. */
function setSongLike(db, userId, trackId, liked) {
  const id = libraryTrackId(db, trackId)
  const ids = [...new Set([trackId, ...songIds(db, id)])]
  const marks = ids.map(() => '?').join(', ')
  if (liked) {
    const otherIds = ids.filter(candidate => candidate !== id)
    if (otherIds.length) {
      const otherMarks = otherIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM user_likes WHERE user_id = ? AND track_id IN (${otherMarks})`).run(userId, ...otherIds)
    }
    db.prepare('INSERT OR IGNORE INTO user_likes (user_id, track_id) VALUES (?, ?)').run(userId, id)
  } else {
    db.prepare(`DELETE FROM user_likes WHERE user_id = ? AND track_id IN (${marks})`).run(userId, ...ids)
  }
  return { liked: !!liked, trackId: id, ids }
}

/**
 * Keep online songs as ghost tracks, so they can be played, liked and added
 * to playlists. Returns the track rows (null for unusable items), in order.
 */
const { streamQuality } = require('./streamQuality')

const year = value => (Number(value) >= 1000 && Number(value) <= 2999 ? Math.floor(Number(value)) : null)
const positive = value => (Number(value) > 0 && Number(value) < 1000 ? Math.floor(Number(value)) : null)

// Add-on album ids are needed to open the provider's album from a streamed
// track. Older library databases don't have a column for them.
// Catalogue Atmos availability belongs to the online ghost, not to the
// verified file-quality flag (atmos_verified). Preserve the capability after
// a search result becomes the player/playlist's persisted ghost track.
const sourceAlbumColumnDatabases = new WeakSet()
function ensureSourceAlbumIdColumn(db) {
  if (sourceAlbumColumnDatabases.has(db)) return
  const columns = db.pragma('table_info(tracks)')
  if (!columns.some(column => column.name === 'source_album_id')) db.exec('ALTER TABLE tracks ADD COLUMN source_album_id TEXT')
  if (!columns.some(column => column.name === 'atmos_available')) db.exec('ALTER TABLE tracks ADD COLUMN atmos_available INTEGER')
  if (!columns.some(column => column.name === 'atmos_requestable')) db.exec('ALTER TABLE tracks ADD COLUMN atmos_requestable INTEGER')
  sourceAlbumColumnDatabases.add(db)
}

function sourceAlbumIdOf(item) {
  const album = item?.album && typeof item.album === 'object' ? item.album : null
  const direct = item?.albumId ?? item?.album_id ?? album?.id ?? album?.album_id ?? album?.albumId
  if (direct != null && String(direct).trim()) return String(direct).trim().slice(0, 500)
  const url = String(item?.album_url || item?.albumUrl || '')
  const match = url.match(/\/albums?\/([^/?#]+)/i)
  if (!match) return null
  try { return decodeURIComponent(match[1]).slice(0, 500) } catch { return match[1].slice(0, 500) }
}

function saveOnlineTracks(db, items = []) {
  try { require('../quality').ensureColumns(db) } catch {}
  ensureSourceAlbumIdColumn(db)
  // What the source says of the song (an addon's year, track number, ISRC,
  // quality...) is kept for the details panel; it fills in, never erases.
  const upsert = db.prepare(`
    INSERT INTO tracks (id, file_path, file_hash, title, artist, album, album_artist, duration, source_url, artwork_url, last_modified,
      year, track_num, genre, isrc, codec, lossless, bit_depth, sample_rate, bitrate, source_album_id, atmos_available, atmos_requestable)
    VALUES (@id, @file_path, @id, @title, @artist, @album, @album_artist, @duration, @source_url, @artwork_url, @now,
      @year, @track_num, @genre, @isrc, @codec, @lossless, @bit_depth, @sample_rate, @bitrate, @source_album_id, @atmos_available, @atmos_requestable)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, artist = excluded.artist, album = excluded.album,
      album_artist = excluded.album_artist, duration = excluded.duration,
      source_url = excluded.source_url, artwork_url = excluded.artwork_url,
      year = COALESCE(excluded.year, tracks.year), track_num = COALESCE(excluded.track_num, tracks.track_num),
      genre = COALESCE(excluded.genre, tracks.genre), isrc = COALESCE(excluded.isrc, tracks.isrc),
      codec = COALESCE(excluded.codec, tracks.codec), lossless = COALESCE(excluded.lossless, tracks.lossless),
      bit_depth = COALESCE(excluded.bit_depth, tracks.bit_depth), sample_rate = COALESCE(excluded.sample_rate, tracks.sample_rate),
      bitrate = COALESCE(excluded.bitrate, tracks.bitrate),
      source_album_id = COALESCE(excluded.source_album_id, tracks.source_album_id),
      atmos_available = COALESCE(excluded.atmos_available, tracks.atmos_available),
      atmos_requestable = COALESCE(excluded.atmos_requestable, tracks.atmos_requestable)
    WHERE tracks.file_path LIKE 'ghost://%'
  `)
  const get = db.prepare('SELECT * FROM tracks WHERE id = ?')
  const run = db.transaction((list) => list.map(item => {
    // Older callers sent YouTube items as { videoId }.
    const provider = item?.provider || (item?.videoId ? 'yt' : null)
    const itemId = String(item?.id && item?.provider ? item.id : item?.videoId || '')
    if (!validId(provider, itemId)) return null
    const p = providerOf(provider)
    const id = onlineTrackId(provider, itemId)
    upsert.run({
      id,
      file_path: ghostPath(provider, itemId),
      title: String(item.title || 'Unknown Track').slice(0, 500),
      artist: String(item.artist || (item.artists || []).join(', ') || 'Unknown Artist').slice(0, 500),
      album: item.album ? String(item.album).slice(0, 500) : null,
      album_artist: item.artists?.[0] ? String(item.artists[0]).slice(0, 500) : null,
      duration: Number(item.duration) > 0 ? Number(item.duration) : null,
      source_url: p.sourceUrl(itemId),
      source_album_id: sourceAlbumIdOf(item),
      atmos_available: item.atmos_available === true || Number(item.atmos_available) === 1 ||
        require('../mornye/atmos').hasAtmosMetadata(item) ? 1 :
        item.atmos_available === false || item.atmos_available === 0 ? 0 : null,
      // Per-addon AC-4 requestability is separate from catalogue Atmos.
      // Null means unknown: never erase a previously persisted positive flag.
      atmos_requestable: item.atmos_requestable === true || Number(item.atmos_requestable) === 1 ? 1 :
        item.atmos_requestable === false || item.atmos_requestable === 0 ? 0 : null,
      // Search results call it thumbnail; a row played again (a fallback to
      // another source) has artwork_url: keep its cover either way.
      artwork_url: [item.thumbnail, item.artwork_url].map(value => String(value || '')).find(value => /^https:\/\//.test(value))?.slice(0, 1000) || null,
      now: Date.now(),
      year: year(item.year),
      track_num: positive(item.track_num ?? item.trackNumber),
      genre: typeof item.genre === 'string' && item.genre.trim() ? item.genre.trim().slice(0, 100) : null,
      isrc: (() => { try { return require('../quality').normalizeIsrc(item.isrc) || null } catch { return null } })(),
      ...streamQuality(item.quality || item.format),
    })
    return get.get(id)
  }))
  return run(Array.isArray(items) ? items.slice(0, 100) : [])
}

/**
 * Forget online songs nobody kept: played from a search but never liked,
 * added to a playlist or listened to for long enough to count, after a week.
 */
function pruneOnlineTracks(db, maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const prune = db.transaction((cutoff) => {
      const ids = db.prepare(`
        SELECT id FROM tracks
        WHERE (file_path LIKE 'ghost://youtube/online/%' OR file_path LIKE 'ghost://soundcloud/online/%' OR file_path LIKE 'ghost://monochrome/online/%' OR file_path LIKE 'ghost://addon/%')
          AND COALESCE(last_modified, 0) < ?
          AND id NOT IN (SELECT track_id FROM playlist_tracks)
          AND id NOT IN (SELECT track_id FROM user_likes)
          AND id NOT IN (SELECT track_id FROM play_history)
      `).all(cutoff).map(row => row.id)

      for (const id of ids) {
        db.prepare('DELETE FROM artist_track_links WHERE track_id = ?').run(id)
        db.prepare('DELETE FROM listening_events WHERE track_id = ?').run(id)
        db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(id)
        try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(id) } catch {}
        db.prepare('DELETE FROM tracks WHERE id = ?').run(id)
      }
      return ids.length
    })
    return prune(Date.now() - maxAgeMs)
  } catch { return 0 }
}

/** Prefer a known audio type over a generic type returned by a CDN. */
function streamContentType(upstreamType, mime) {
  const type = String(upstreamType || '').split(';', 1)[0].trim().toLowerCase()
  const generic = new Set(['application/octet-stream', 'application/binary', 'binary/octet-stream', 'application/force-download', 'application/download'])
  if (mime && mime !== 'audio/*' && (!type || generic.has(type))) return mime
  return upstreamType || mime || ''
}

module.exports = {
  streamContentType,
  streamQuality,
  cancellableBody,
  PROVIDERS, providerOf, validId, ghostPath, addons,
  search, resolveStream, fetchStream,
  onlineTrackId, streamRef, sourceIdentity, saveOnlineTracks, pruneOnlineTracks, streamedTwins,
  sameSong, sourceRefOf, sourceRefOfTrack, libraryCopyOf, libraryTrackId, songIds, toggleSongLike, setSongLike, foldStreamedLikes,
}
