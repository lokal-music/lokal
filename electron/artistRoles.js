const artistSplit = require('./artistSplit')

const GENERIC_ALBUM_ARTISTS = new Set([
  'various artists', 'various artist', 'va', 'v.a.', 'unknown artist', 'unknown artists',
])

function normalizeArtistName(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function isGenericAlbumArtist(value) {
  return GENERIC_ALBUM_ARTISTS.has(normalizeArtistName(value))
}

function keepCommaSetFromDb(db) {
  if (!db) return artistSplit.keepCommaSet()
  try {
    const value = db.prepare("SELECT value FROM settings WHERE key = 'keep_comma_artists'").get()?.value
    return artistSplit.keepCommaSet(value ? JSON.parse(value) : [])
  } catch {
    return artistSplit.keepCommaSet()
  }
}

function firstPrincipalCreditGroup(credit, keepComma) {
  let value = String(credit || '').trim()
  if (!value) return ''
  // Preserve names whose own spelling contains a comma (for example,
  // "Tyler, the Creator") before treating a later comma as a credit separator.
  const protectedNames = []
  const wordChar = /[\p{L}\p{N}]/u
  for (const known of [...keepComma].sort((a, b) => b.length - a.length)) {
    if (!known) continue
    let from = 0
    for (;;) {
      const lower = value.toLocaleLowerCase()
      const start = lower.indexOf(known, from)
      if (start < 0) break
      const end = start + known.length
      if ((start > 0 && wordChar.test(value[start - 1])) ||
          (end < value.length && wordChar.test(value[end]))) {
        from = start + 1
        continue
      }
      const marker = '\uE000' + protectedNames.length + '\uE001'
      protectedNames.push(value.slice(start, end))
      value = value.slice(0, start) + marker + value.slice(end)
      from = start + marker.length
    }
  }

  // The artist parser uses the same exception for a comma before "the",
  // "and", "of", "a", "an", or a digit: those are part of the preceding name.
  const separator = /\s*,(?!\s*(?:\d|(?:the|and|of|a|an)\b))\s*/u
  const index = value.search(separator)
  if (index >= 0) value = value.slice(0, index)
  return value.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedNames[Number(index)] ?? '')
}

function mainArtistNames(credit, keepComma = artistSplit.keepCommaSet()) {
  let value = String(credit || '').trim()
  if (!value) return []
  value = value
    .replace(/\s*[\[(]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[\])]/gi, ' ')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .trim()
  value = firstPrincipalCreditGroup(value, keepComma)
  return [...new Set(artistSplit.splitArtists(value, keepComma).map(name => name.trim()).filter(Boolean))]
}

function mainOnlyArtistIds(db) {
  artistSplit.applySplitWordsFrom(db)
  const keepComma = keepCommaSetFromDb(db)
  const rows = db.prepare("SELECT DISTINCT artist, album_artist FROM tracks WHERE file_path NOT LIKE 'ghost://%'").all()
  const mainNames = new Set()
  for (const row of rows) {
    const albumArtist = String(row.album_artist || '').trim()
    const credit = albumArtist && !isGenericAlbumArtist(albumArtist) ? albumArtist : row.artist
    for (const name of mainArtistNames(credit, keepComma)) mainNames.add(normalizeArtistName(name))
  }
  return new Set(
    db.prepare('SELECT id, name FROM artists').all()
      .filter(artist => mainNames.has(normalizeArtistName(artist.name)))
      .map(artist => String(artist.id))
  )
}

function isMainArtistRelease(artistName, release, artistTracks = [], db = null) {
  const target = normalizeArtistName(artistName)
  if (!target) return false
  if (db) artistSplit.applySplitWordsFrom(db)
  const keepComma = keepCommaSetFromDb(db)
  const albumArtist = String(release?.album_artist || '').trim()
  if (albumArtist && !isGenericAlbumArtist(albumArtist)) {
    return mainArtistNames(albumArtist, keepComma).some(name => normalizeArtistName(name) === target)
  }

  const albumTitle = normalizeArtistName(release?.title)
  const matchingTracks = (Array.isArray(artistTracks) ? artistTracks : []).filter(track => {
    if (normalizeArtistName(track.album) !== albumTitle) return false
    if (!albumArtist) return !String(track.album_artist || '').trim()
    return isGenericAlbumArtist(track.album_artist)
  })
  const candidates = matchingTracks.length
    ? matchingTracks
    : (Array.isArray(artistTracks) ? artistTracks.filter(track => normalizeArtistName(track.album) === albumTitle) : [])
  return candidates.some(track => mainArtistNames(track.artist, keepComma).some(name => normalizeArtistName(name) === target))
}

module.exports = {
  GENERIC_ALBUM_ARTISTS,
  normalizeArtistName,
  isGenericAlbumArtist,
  keepCommaSetFromDb,
  mainArtistNames,
  mainOnlyArtistIds,
  isMainArtistRelease,
}
