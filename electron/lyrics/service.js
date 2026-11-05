// The lyrics feature as the app sees it: cache in front of the repository,
// settings read from the DB, translation/romanization on request. Shared by
// the Electron IPC handlers and the web server's routes so both behave the same.
//
// Cache (lyrics_cache):
//   content  JSON array of lines -- unchanged shape, so the existing
//            search-by-lyrics feature (scanner.searchLyricsEntries) keeps
//            reading it directly.
//   meta     JSON { v, sync, duet, isrc, language, translationLang,
//            romanizationLang, attempts, pinned }.
//            A row without meta was written before this revamp: imported
//            lyrics are upgraded in place, anything else is refetched once so
//            old LRCLIB-only answers get the chance to become syllable-synced.

const { createHash } = require('node:crypto')
const { lookup, parseImported, DEFAULT_ORDER } = require('./repository')
const { describe } = require('./providers')
const { finish, isUntimed, assignSides } = require('./postprocess')
const { stripVoicePrefix } = require('./lrc')
const translation = require('./translate')
const { readFlacLyrics } = require('./flacVorbis')
const { mergePrivateBackground } = require('./providers/local')

const META_VERSION = 2
const NEGATIVE_TTL_MS = 3 * 24 * 60 * 60 * 1000
// Credential fingerprints and negative-cache keys live only in this process.
// After a restart, retry persisted misses once with the current credentials.
const negativeSettingsKeys = new WeakMap()
const fingerprint = value => createHash('sha256').update(value || '').digest('hex')

// ---------------------------------------------------------------- schema

const prepared = new WeakSet()
function ensureSchema(db) {
  if (prepared.has(db)) return
  const cols = new Set(db.prepare('PRAGMA table_info(lyrics_cache)').all().map(c => c.name))
  if (!cols.has('fetched_at')) { try { db.exec('ALTER TABLE lyrics_cache ADD COLUMN fetched_at INTEGER DEFAULT 0') } catch {} }
  if (!cols.has('file_path')) { try { db.exec('ALTER TABLE lyrics_cache ADD COLUMN file_path TEXT') } catch {} }
  if (!cols.has('meta')) { try { db.exec('ALTER TABLE lyrics_cache ADD COLUMN meta TEXT') } catch {} }
  prepared.add(db)
}

// ---------------------------------------------------------------- settings

function readSettings(db) {
  let rows = []
  try { rows = db.prepare('SELECT key, value FROM settings').all() } catch {}
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]))
  const parseList = (v) => {
    if (!v) return null
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : null } catch { return null }
  }
  let keepCommaArtists = []
  try {
    const v = s.keep_comma_artists || ''
    keepCommaArtists = v.startsWith('[') ? JSON.parse(v) : v.split('\n').map(x => x.trim()).filter(Boolean)
  } catch { keepCommaArtists = [] }
  const savedOrder = parseList(s.lyrics_sources_order)
  const order = savedOrder ? [...savedOrder] : [...DEFAULT_ORDER]
  // Introduce the new source above BetterLyrics for existing installations,
  // while preserving every source preference the user explicitly saved.
  if (!order.includes('spicylyrics')) {
    const at = order.findIndex(id => id === 'betterlyrics' || id === 'betterlyrics_qq')
    order.splice(at < 0 ? order.length : at, 0, 'spicylyrics')
  }
  const savedEnabled = parseList(s.lyrics_sources_enabled)
  // Migrate existing installations with the newly available provider enabled;
  // once the settings page saves an explicit list, later toggles are retained.
  const enabled = savedEnabled
    ? [...savedEnabled, ...(!savedOrder?.includes('spicylyrics') && !savedEnabled.includes('spicylyrics') ? ['spicylyrics'] : [])]
    : DEFAULT_ORDER
  return {
    order,
    enabled,
    prioritizeSyllable: s.lyrics_prioritize_syllable === '1',
    autoFetch: s.lyrics_auto_fetch !== '0',
    keepCommaArtists,
    spicyKey: s.spicylyrics_api_key || '',
    spotifyCookie: s.spotify_sp_dc || '',
    // A negative answer is only trusted while the same sources are configured.
    settingsKey: JSON.stringify([order.filter(id => enabled.includes(id)), s.lyrics_prioritize_syllable === '1', fingerprint(s.spicylyrics_api_key), fingerprint(s.spotify_sp_dc)]),
  }
}

// ---------------------------------------------------------------- cache

/**
 * Rank lyrics by information quality, not merely by source priority:
 * syllable-timed > line-timed > plain text > instrumental/no result.
 */
function lyricsQualityRank(result) {
  if (!result || result.instrumental || result.type === 'instrumental') return 0
  const lines = Array.isArray(result.lines) ? result.lines : []
  const sync = String(result.sync || '').toLowerCase()
  const hasWordTimes = lines.some(line =>
    (Array.isArray(line?.words) && line.words.some(word => word?.time != null)) ||
    (Array.isArray(line?.bgWords) && line.bgWords.some(word => word?.time != null)))
  if (sync === 'syllable' || result.type === 'syllable' || hasWordTimes) return 3
  const hasLineTimes = lines.some(line => line && typeof line === 'object' && line.time != null)
  if (sync === 'line' || sync === 'sync' || sync === 'synced' || hasLineTimes) return 2
  const hasText = (typeof result.text === 'string' && result.text.trim()) ||
    lines.some(line => (typeof line === 'string' ? line.trim() : String(line?.text || line?.bgText || '').trim()))
  return hasText ? 1 : 0
}

/** A lower/equal-quality refresh must not downgrade an existing usable result. */
function retainBetterLyrics(existing, candidate) {
  const oldRank = lyricsQualityRank(existing)
  return oldRank > 0 && oldRank >= lyricsQualityRank(candidate) ? existing : (candidate || existing || null)
}

function readRow(db, trackId, filePath) {
  let row = trackId ? db.prepare('SELECT * FROM lyrics_cache WHERE track_id = ?').get(trackId) : null
  if (!row && filePath) {
    try { row = db.prepare('SELECT * FROM lyrics_cache WHERE file_path = ?').get(filePath) } catch {}
  }
  return row || null
}

function parseMeta(row) {
  if (!row?.meta) return null
  try { const m = JSON.parse(row.meta); return m && m.v === META_VERSION ? m : null } catch { return null }
}

function writeRow(db, trackId, filePath, result, extra = {}) {
  const meta = {
    v: META_VERSION,
    // The standalone enhanced-LRC backing-voice parser was introduced after
    // earlier synced local entries were persisted without their background.
    bgLrcChecked: true,
    // FLAC's separately stored [bg:] Vorbis tag was previously invisible to
    // desktop metadata readers. Force one rescan of old local cache rows.
    vorbisBgChecked: true,
    sync: result?.sync || null,
    duet: !!result?.duet,
    isrc: result?.isrc || null,
    language: result?.language || null,
    translationLang: result?.translationLang || null,
    romanizationLang: result?.romanizationLang || null,
    attribution: result?.attribution || null,
    ...extra,
  }
  db.prepare('INSERT OR REPLACE INTO lyrics_cache (track_id, lyrics_type, content, source, fetched_at, file_path, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(trackId, result?.type || null, JSON.stringify(result?.lines || []), result?.source || 'no-results', Date.now(), filePath || null, JSON.stringify(meta))
}

function fromRow(row, meta, db) {
  let lines = []
  try { lines = JSON.parse(row.content || '[]') } catch {}
  // Earlier versions cached the raw "v1:" prefix as if it were sung text.
  // Repair these rows on first read; otherwise they would keep bypassing the
  // fixed LRC parser indefinitely, especially for pinned/local lyrics.
  let duet = !!meta.duet
  if (Array.isArray(lines)) {
    const cleaned = lines.map(stripVoicePrefix)
    if (cleaned.some((line, index) => line !== lines[index])) {
      lines = cleaned
      duet = assignSides(lines)
      try {
        db?.prepare('UPDATE lyrics_cache SET content = ?, meta = ? WHERE track_id = ?')
          .run(JSON.stringify(lines), JSON.stringify({ ...meta, duet }), row.track_id)
      } catch { /* a read-only/legacy cache must still display corrected text */ }
    }
  }
  return {
    type: row.lyrics_type,
    sync: meta.sync,
    lines,
    source: row.source,
    isrc: meta.isrc,
    language: meta.language,
    duet,
    translationLang: meta.translationLang,
    romanizationLang: meta.romanizationLang,
    attempts: meta.attempts || null,
    pinned: !!meta.pinned,
    attribution: meta.attribution || null,
  }
}

/**
 * True when a legacy line's word timings were invented by the old LRC parser,
 * which split each line's slot evenly across its words. Real (TTML) timings
 * are never all exactly equal.
 */
function isEvenSplit(words) {
  if (!Array.isArray(words) || words.length < 2) return false
  const spans = words.map(w => (w.end ?? 0) - (w.time ?? 0))
  return spans.every(s => Math.abs(s - spans[0]) < 0.002)
}

/** Old imported lines (pre-revamp shape) -> new shape, run through the shared finish pass. */
function upgradeLegacy(row) {
  let lines = []
  try { lines = JSON.parse(row.content || '[]') } catch { return null }
  if (!Array.isArray(lines) || !lines.length) return null
  const multiWord = lines.filter(l => Array.isArray(l.words) && l.words.length >= 2)
  const invented = multiWord.length > 0 && multiWord.filter(l => isEvenSplit(l.words)).length / multiWord.length > 0.8
  const toUnits = (list) => (Array.isArray(list) ? list : [])
    .filter(w => w && w.word && w.time != null)
    .map((w, i, arr) => ({ word: String(w.word), time: w.time, end: w.end ?? null, space: i < arr.length - 1 && !String(w.word).endsWith('-') }))
  const converted = lines.map(l => {
    const words = invented ? [] : toUnits(l.words)
    const bgWords = invented ? [] : toUnits(l.bgWords)
    const out = {
      time: l.time ?? null,
      end: l.end ?? null,
      endStated: words.length > 0,
      text: String(l.text || ''),
      words,
    }
    if (bgWords.length) { out.bgWords = bgWords; out.bgText = l.bgText || bgWords.map(w => w.word).join(' ') }
    else if (l.bgText) out.bgText = l.bgText
    if (l.agent) out.agent = l.agent
    return out
  })
  const result = finish(converted, { source: row.source || 'imported' })
  return result.type ? result : null
}

// ---------------------------------------------------------------- trusted paths

/**
 * The file a track actually lives at, from the library -- never from the
 * caller. The web server is reachable over the network, and the local-file
 * source reads sidecar files and tags next to whatever path it's given; a
 * client-supplied path would let any client read arbitrary .txt/.lrc/.ttml
 * files off the host (CWE-22). Callers' filePath arguments are ignored.
 */
function trustedFilePath(db, trackId) {
  if (!trackId) return null
  try {
    const row = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId)
    // Ghost tracks (online songs, imported entries) have no file to read.
    if (String(row?.file_path || '').startsWith('ghost://')) return null
    return row?.file_path || null
  } catch { return null }
}

// ---------------------------------------------------------------- public API

// A cached or online lead can be the best lyric source while the file stores
// a separate [bg:] singer. Mobile merges those two sources instead of replacing
// one with the other. Only the user's DB-validated local FLAC path is read.
async function withVorbisBacking(result, filePath) {
  if (!result?.lines?.length || !/\.flac$/i.test(filePath || '')) return result
  const ownText = await readFlacLyrics(filePath)
  return ownText ? mergePrivateBackground(result, ownText) : result
}

function instrumentalResult(db, trackId) {
  if (!trackId) return null
  try {
    const track = db.prepare('SELECT instrumental FROM tracks WHERE id = ?').get(trackId)
    if (!track?.instrumental) return null
  } catch { return null }
  return { type: 'instrumental', sync: 'none', lines: [], source: 'instrumental-tag', instrumental: true }
}

/**
 * The lyrics for a track: cache first, then every configured source.
 * @param args { trackId, title, artist, album, duration, filePath, refresh? }
 */
async function getLyrics(db, args) {
  ensureSchema(db)
  const { trackId, title, artist, album, duration } = args
  const filePath = trustedFilePath(db, trackId)
  const instrumental = instrumentalResult(db, trackId)
  if (instrumental) return instrumental
  const settings = readSettings(db)
  // Automatic lyrics off (Settings > Playback): a song's lyrics come only from
  // the song itself (its tags, a file next to it). Refreshing, or picking a
  // source, still looks online.
  if (!settings.autoFetch && !args.refresh) {
    settings.enabled = settings.enabled.filter(id => id === 'local')
    settings.settingsKey += '|own-only'
  }
  // Cached lyrics with untimed stamps, as plain text: kept when the fresh
  // lookup finds nothing better (every source down, say).
  let untimedFallback = null
  // The file's own usable lyrics are never replaced by an equal or worse lookup.
  let cachedLocalLyrics = null

  // Explicit refresh skips cache hits, but a saved local answer still needs to
  // participate in quality comparison so a weaker lookup cannot overwrite it.
  if (args.refresh) {
    const cachedRow = readRow(db, trackId, filePath)
    const cachedMeta = parseMeta(cachedRow)
    if (cachedRow?.source === 'local' && cachedMeta) cachedLocalLyrics = fromRow(cachedRow, cachedMeta, db)
  }

  if (!args.refresh) {
    const row = readRow(db, trackId, filePath)
    if (row) {
      const meta = parseMeta(row)
      if (meta) {
        if (row.source === 'no-results') {
          const fresh = row.fetched_at && Date.now() - row.fetched_at < NEGATIVE_TTL_MS
          if (fresh && negativeSettingsKeys.get(db)?.get(row.track_id) === settings.settingsKey) return null
        } else if (row.lyrics_type === 'synced' && isUntimed(fromRow(row, meta, db).lines)) {
          // Cached before untimed stamps were recognised (see isUntimed). A
          // source the user picked stays, as the plain text it really is;
          // anything else is looked up again so a truly synced source can win,
          // falling back to that plain text.
          const plain = finish(fromRow(row, meta, db).lines.map(l => ({ text: l.text, time: null, words: [] })), { source: row.source })
          if (meta.pinned) {
            writeRow(db, trackId || row.track_id, filePath || row.file_path, plain, { attempts: meta.attempts, pinned: true })
            return { ...plain, attempts: meta.attempts || null, pinned: true }
          }
          if (plain.type) untimedFallback = { result: plain, attempts: meta.attempts || null }
        } else if (meta.pinned) {
          // An explicit source choice is the user's decision, even when plain.
          const pinned = fromRow(row, meta, db)
          const enriched = !meta.vorbisBgChecked ? await withVorbisBacking(pinned, filePath) : pinned
          if ((enriched !== pinned || trackId && row.track_id !== trackId)) writeRow(db, trackId || row.track_id, filePath || row.file_path, enriched, { attempts: meta.attempts, pinned: true })
          return enriched
        } else if (row.source === 'local' &&
          (!meta.bgLrcChecked || (!meta.vorbisBgChecked && /\.flac$/i.test(filePath || ''))) &&
          filePath) {
          // Existing word-timed local cache rows can be missing every [bg:]
          // supporting vocal. Re-read the embedded source once after upgrade;
          // keep the cached result if the file is unavailable or unchanged.
          cachedLocalLyrics = fromRow(row, meta, db)
        } else if (row.source === 'local' && row.lyrics_type !== 'synced') {
          // The song's own lyrics, saved unsynced: read again, so a file whose
          // timed lyrics were missed before (two lyrics tags, a SYLT frame)
          // gets them now. Keep the existing words if the refresh cannot improve them.
          const existing = fromRow(row, meta, db)
          // Some older cached rows say "unsynced" even though their saved
          // lines have real timestamps and meta.sync is line/syllable. Repair
          // the stale type rather than letting the inconsistent row win the
          // quality comparison and keep showing as plain lyrics.
          const hasRealTime = existing.lines.some(line => line?.text && line.time != null) &&
            !isUntimed(existing.lines)
          cachedLocalLyrics = hasRealTime && ['line', 'syllable'].includes(existing.sync)
            ? { ...existing, type: 'synced' }
            : existing
        } else {
          const cached = fromRow(row, meta, db)
          const enriched = !meta.vorbisBgChecked ? await withVorbisBacking(cached, filePath) : cached
          if (enriched !== cached || trackId && row.track_id !== trackId) {
            writeRow(db, trackId || row.track_id, filePath || row.file_path, enriched, { attempts: meta.attempts, pinned: meta.pinned })
          }
          return enriched
        }
      } else if (row.source === 'imported' || String(row.source || '').startsWith('imported')) {
        const upgraded = upgradeLegacy(row)
        if (upgraded) {
          writeRow(db, trackId || row.track_id, filePath || row.file_path, upgraded)
          return upgraded
        }
      }
      // Legacy non-imported rows, stale negatives and untimed answers fall through to a fresh lookup.
    }
  }

  const { result: discovered, attempts } = await lookup(
    { title, artist, album, duration: Number(duration) || 0, filePath, keepCommaArtists: settings.keepCommaArtists },
    settings,
  )
  const result = await withVorbisBacking(discovered, filePath)
  if (!trackId) return result
  // A newly decoded local file with real backing vocals must supersede the
  // equally ranked legacy cached lead-only version; quality ranking alone
  // cannot see that the latter silently omitted the supporting voice.
  const recoveredBackground = cachedLocalLyrics && result?.source === 'local' &&
    result.lines?.some(line => line.bgText || line.bgWords?.length) &&
    !cachedLocalLyrics.lines?.some(line => line.bgText || line.bgWords?.length) &&
    lyricsQualityRank(result) >= lyricsQualityRank(cachedLocalLyrics)
  const preferred = recoveredBackground ? result : retainBetterLyrics(cachedLocalLyrics, result)
  if (cachedLocalLyrics && preferred === cachedLocalLyrics) {
    const merged = { ...(cachedLocalLyrics.attempts || {}), ...attempts }
    writeRow(db, trackId, filePath, cachedLocalLyrics, { attempts: merged })
    return { ...cachedLocalLyrics, attempts: merged }
  }
  if (result && !result.instrumental) {
    writeRow(db, trackId, filePath, result, { attempts })
    return { ...result, attempts }
  }
  if (result?.instrumental) return result
  if (untimedFallback) {
    const kept = { ...(untimedFallback.attempts || {}), ...attempts }
    writeRow(db, trackId, filePath, untimedFallback.result, { attempts: kept })
    return { ...untimedFallback.result, attempts: kept }
  }
  writeRow(db, trackId, filePath, null, { attempts })
  if (!negativeSettingsKeys.has(db)) negativeSettingsKeys.set(db, new Map())
  negativeSettingsKeys.get(db).set(trackId, settings.settingsKey)
  return null
}

/** Asks exactly one source (the "try another source" picker). Pins the answer when found. */
async function getLyricsFrom(db, args, providerId) {
  ensureSchema(db)
  const settings = readSettings(db)
  const filePath = trustedFilePath(db, args.trackId)
  const { result, attempts } = await lookup(
    { title: args.title, artist: args.artist, album: args.album, duration: Number(args.duration) || 0, filePath, keepCommaArtists: settings.keepCommaArtists },
    { only: providerId, spicyKey: settings.spicyKey, spotifyCookie: settings.spotifyCookie },
  )
  if (result && !result.instrumental && args.trackId) {
    // Merge this attempt into what the row already knew about the other sources.
    const previous = parseMeta(readRow(db, args.trackId, filePath) || {})
    const merged = { ...(previous?.attempts || {}), ...attempts }
    writeRow(db, args.trackId, filePath, result, { attempts: merged, pinned: true })
    return { ...result, attempts: merged, pinned: true }
  }
  return result ? { ...result, attempts } : { type: null, lines: [], source: providerId, attempts, miss: true }
}

/** Resolve exactly the lyrics selected in the player for an explicit
 * embed/export action. Imported LRC/ELRC is a pinned cache result, not a
 * network provider. Re-fetching an unknown 'imported' provider returned no
 * lyrics, causing issue #660 when users clicked Insert into track.
 *
 * A pinned source must match *this track and this requested source*; never
 * embed a stale selection from a different song/provider.
 */
async function getLyricsForSaving(db, args, providerId) {
  ensureSchema(db)
  if (!args?.trackId || !providerId) throw new Error('Select lyrics for this song before saving.')
  const filePath = trustedFilePath(db, args.trackId)
  const row = readRow(db, args.trackId, filePath)
  const meta = parseMeta(row)
  if (row?.track_id === args.trackId && row.source === providerId && meta?.pinned) {
    const selected = fromRow(row, meta, db)
    if (selected.lines?.some(line => line?.text || line?.bgText)) {
      return { ...selected, ...(meta.rawImport ? { rawImport: meta.rawImport } : {}) }
    }
  }
  if (providerId === 'imported') {
    throw new Error('The imported lyrics are no longer selected. Import the file again before saving.')
  }
  return getLyricsFrom(db, args, providerId)
}

function importLyrics(db, trackId, content, type) {
  ensureSchema(db)
  if (!trackId) return null
  const filePath = trustedFilePath(db, trackId)
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.join('\n') : String(content ?? '')
  const result = parseImported(text.replace(/\r\n/g, '\n'), type)
  // A blank/plain import can parse to a truthy empty result. Never replace
  // a previously chosen lyric with that empty result.
  if (!result?.lines?.some(line => String(line?.text || line?.bgText || '').trim())) return null
  // Keep the imported document's original text, like Mobile's normal Save:
  // reconstructed ELRC/TTML may otherwise lose metadata, whitespace or
  // unsupported vendor extensions. Do not duplicate unusually huge files.
  const rawImport = Buffer.byteLength(text, 'utf8') <= 512 * 1024
    ? { type: String(type || '').toLowerCase(), content: text }
    : null
  writeRow(db, trackId, filePath, result, { pinned: true, ...(rawImport ? { rawImport } : {}) })
  return result
}

function clearCache(db, trackId) {
  if (!trackId) return { ok: false }
  db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId)
  try { db.prepare('DELETE FROM lyrics_translations WHERE track_id = ?').run(trackId) } catch {}
  return { ok: true }
}

function sources(db) {
  const settings = readSettings(db)
  return {
    providers: describe(),
    order: settings.order,
    enabled: settings.enabled,
    prioritizeSyllable: settings.prioritizeSyllable,
    defaultOrder: DEFAULT_ORDER,
  }
}

async function translate(db, trackId, lines, targetLang) {
  return translation.translate(db, trackId, lines, targetLang)
}

async function romanize(db, trackId, lines) {
  return translation.romanize(db, trackId, lines)
}

module.exports = { getLyrics, getLyricsFrom, getLyricsForSaving, importLyrics, clearCache, sources, translate, romanize, readSettings, upgradeLegacy, lyricsQualityRank, retainBetterLyrics }
