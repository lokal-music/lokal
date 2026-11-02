// Library search (the search bar's songs, albums and artists, desktop and web):
// every word of the query must be found in one of the fields, in any order,
// so "fame is for fools hallex" finds Hallex M's "Fame Is for Fools" (title
// words and an artist word). Results where the whole query appears together
// come first.

const MAX_WORDS = 8

/** "Fame is  for Fools" -> ['fame', 'is', 'for', 'fools'] */
function searchWords(query) {
  return [...new Set(String(query || '').toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_WORDS)
}

// LIKE treats % and _ as wildcards: a search for "100%" means the text "100%".
const likeText = text => `%${String(text).replace(/[\\%_]/g, c => `\\${c}`)}%`

/**
 * SQL where each word is in one of `columns`: { sql, params }, or null for an
 * empty query.
 */
function wordsMatch(query, columns) {
  const words = searchWords(query)
  if (!words.length) return null
  const one = `(${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`
  return {
    sql: `(${words.map(() => one).join(' AND ')})`,
    params: words.flatMap(word => columns.map(() => likeText(word))),
  }
}

/**
 * ORDER BY terms putting the whole query first: in `first` (the title), then
 * in any of `columns`. { sql, params }
 */
function phraseFirst(query, first, columns) {
  const phrase = likeText(String(query || '').trim().toLowerCase())
  return {
    sql: `CASE WHEN LOWER(${first}) LIKE ? ESCAPE '\\' THEN 0 WHEN ${columns.map(c => `LOWER(${c}) LIKE ? ESCAPE '\\'`).join(' OR ')} THEN 1 ELSE 2 END`,
    params: [phrase, ...columns.map(() => phrase)],
  }
}

const TRACK_COLUMNS = ['title', 'artist', 'album', 'album_artist']

/** Library songs for `query` (not streamed ones), best matches first. */
function searchTracks(db, query, limit = 40) {
  const match = wordsMatch(query, TRACK_COLUMNS)
  if (!match) return []
  const order = phraseFirst(query, 'title', TRACK_COLUMNS)
  return db.prepare(`SELECT * FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND COALESCE(download_source, '') <> 'mobile' AND ${match.sql}
    ORDER BY ${order.sql}, IFNULL(play_count, 0) DESC, title COLLATE NOCASE LIMIT ?`).all(...match.params, ...order.params, limit)
}

/**
 * Artists for `query`: the name contains the query, or the artist sings one
 * of the songs found and their name is one of its words ("... hallex" -> Hallex M).
 */
function searchArtists(db, query, tracks = [], limit = 5) {
  const words = searchWords(query)
  if (!words.length) return []
  const byName = db.prepare(`SELECT a.*, COUNT(atl.track_id) as track_count FROM artists a
    JOIN artist_track_links atl ON atl.artist_id = a.id
    JOIN tracks tx ON tx.id = atl.track_id AND COALESCE(tx.download_source, '') <> 'mobile' AND tx.file_path NOT LIKE 'ghost://%'
    WHERE a.name LIKE ? ESCAPE '\\' GROUP BY a.id LIMIT ?`).all(likeText(String(query).trim()), limit)
  const ids = tracks.map(track => track.id).slice(0, 40)
  // Short words ("is", "of") are in too many names to say anything.
  const named = words.filter(word => word.length >= 3)
  if (byName.length >= limit || !ids.length || !named.length) return byName
  const anyWord = `(${named.map(() => "a.name LIKE ? ESCAPE '\\'").join(' OR ')})`
  const ofSongs = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM artist_track_links x WHERE x.artist_id = a.id) as track_count FROM artists a
    WHERE a.id IN (SELECT artist_id FROM artist_track_links WHERE track_id IN (${ids.map(() => '?').join(',')})) AND ${anyWord}
    LIMIT ?`).all(...ids, ...named.map(likeText), limit)
  const seen = new Set(byName.map(a => a.id))
  return [...byName, ...ofSongs.filter(a => !seen.has(a.id))].slice(0, limit)
}

module.exports = { searchWords, wordsMatch, phraseFirst, searchTracks, searchArtists, TRACK_COLUMNS }

// ---------------------------------------------------------------- spelling

// "micheal jackson" finds nothing: each word that's in no title, artist or
// album is replaced by the library's closest word (one or two letters off:
// a typo, a swap) -- "michael jackson". The words come from the library's
// own names, so a correction is always something it has.

const WORD = /[\p{L}\p{N}']+/gu
let vocabulary = null // { stamp, words: Map(word -> uses) }

function libraryWords(db) {
  const stamp = (() => { try { const r = db.prepare("SELECT COUNT(*) AS n, MAX(rowid) AS last FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND COALESCE(download_source, '') <> 'mobile'").get(); return `${r.n}:${r.last}` } catch { return '' } })()
  if (vocabulary && vocabulary.stamp === stamp) return vocabulary.words
  const words = new Map()
  const rows = (() => { try { return db.prepare("SELECT title, artist, album, album_artist FROM tracks WHERE file_path NOT LIKE 'ghost://%' AND COALESCE(download_source, '') <> 'mobile'").all() } catch { return [] } })()
  for (const row of rows) {
    for (const text of [row.title, row.artist, row.album, row.album_artist]) {
      for (const word of String(text || '').toLowerCase().match(WORD) || []) {
        if (word.length >= 3) words.set(word, (words.get(word) || 0) + 1)
      }
    }
  }
  vocabulary = { stamp, words }
  return words
}

/** Edit distance with swaps ("micheal" / "michael" = 1), stopping past `max`. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows = [Array.from({ length: b.length + 1 }, (_, j) => j)]
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1)
      row.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    rows.push(row)
  }
  return rows[a.length][b.length]
}

/**
 * `query` with its misspelt words replaced by the library's closest ones, or
 * null when it needs none (or nothing close enough exists, or the corrected
 * query wouldn't find anything either).
 */
function correctSpelling(db, query) {
  const words = String(query || '').toLowerCase().match(WORD) || []
  if (!words.length || searchTracks(db, query, 1).length) return null
  const known = libraryWords(db)
  const keys = [...known.keys()]
  let changed = false
  const fixed = words.map(word => {
    if (word.length < 4 || keys.some(k => k.includes(word))) return word
    const max = word.length >= 8 ? 2 : 1
    let best = null
    for (const [candidate, uses] of known) {
      const d = distance(word, candidate, max)
      if (d <= max && (!best || d < best.d || (d === best.d && uses > best.uses))) best = { word: candidate, d, uses }
    }
    if (!best) return word
    changed = true
    return best.word
  })
  if (!changed) return null
  const corrected = fixed.join(' ')
  return searchTracks(db, corrected, 1).length ? corrected : null
}

module.exports.correctSpelling = correctSpelling
