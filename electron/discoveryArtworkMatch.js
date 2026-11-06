// Keep desktop LastWave artwork matching aligned with Mobile's
// discovery/recommendation_match.dart. These keys are used only for cover
// metadata, never for selecting a different recording or media stream.
const key = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const featuredBracket = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[)\]]/gi
const featuredSuffix = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i
const harmlessBrackets = /\s*[([](?:explicit|clean)(?:\s+version)?|official (?:music video|audio|video)|lyrics?|audio|hq|hd|album version|single version)[)\]]/gi
const sameRecording = '(?:(?:\\d{4}\\s+)?(?:digital(?:ly)?\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?(?:\\s+version)?|(?:album|single|mono|stereo|lp)\\s+version|original\\s+mix|mono|stereo)'
const remasterBracket = new RegExp('\\s*[(\\[]' + sameRecording + '[)\\]]', 'gi')
const remasterSuffix = new RegExp('\\s+[-–—]\\s+' + sameRecording + '\\s*$', 'gi')
const recordingVersions = /\b(?:remix|live|cover|instrumental|acoustic|karaoke|edit|sped up|slowed|nightcore)\b/g
const stopWords = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'the', 'to', 'with'])
const knownCommaArtists = ['Tyler, The Creator', 'Earth, Wind & Fire', 'Crosby, Stills, Nash & Young', 'Crosby, Stills & Nash', 'Emerson, Lake & Palmer']

function mainArtist(value) {
  return String(value || '').replace(featuredBracket, '').replace(featuredSuffix, '').trim()
}
function leadArtist(value) {
  const name = mainArtist(value)
  if (name.includes(';')) return name.split(';')[0].trim()
  const preserved = knownCommaArtists.find(artist => name.toLowerCase() === artist.toLowerCase() || name.toLowerCase().startsWith(artist.toLowerCase() + ','))
  return preserved || name.split(',')[0].trim()
}
function titleKey(value) {
  const clean = String(value || '')
    .replace(harmlessBrackets, '')
    .replace(remasterBracket, '')
    .replace(remasterSuffix, '')
    // A guest credit is not a different recording; remix/live/edit labels are.
    .replace(featuredBracket, text => recordingVersions.test(key(text)) ? text : '')
    .replace(featuredSuffix, text => recordingVersions.test(key(text)) ? text : '')
  return key(clean)
}
function artistMatches(a, b) {
  const expected = new Set([key(mainArtist(a)), key(leadArtist(a))].filter(Boolean))
  return [key(mainArtist(b)), key(leadArtist(b))].some(value => value && expected.has(value))
}
function versions(value) {
  return [...new Set([...String(value || '').matchAll(new RegExp(recordingVersions.source, 'g'))].map(match => match[0]))].sort().join(',')
}
function editSimilarity(a, b) {
  if (a === b) return 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(previous[j] + 1, next[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = next
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length)
}
function artworkMatchConfidence(title, artist, candidateTitle, candidateArtist) {
  if (!artistMatches(artist, candidateArtist)) return 0
  const wanted = titleKey(title), found = titleKey(candidateTitle)
  if (!wanted || !found) return 0
  if (wanted === found) return 1
  // As on Mobile, a different live/remix/edit recording must not be used.
  if (versions(wanted) !== versions(found)) return 0
  const important = value => new Set(value.split(' ').filter(word => word.length >= 3 && !stopWords.has(word)))
  const common = [...important(wanted)].filter(word => important(found).has(word))
  if (common.length < 2) return 0
  const wa = new Set(wanted.split(' ')), wb = new Set(found.split(' '))
  const tokenSimilarity = [...wa].filter(word => wb.has(word)).length / Math.max(wa.size, wb.size)
  return .8 * editSimilarity(wanted, found) + .2 * tokenSimilarity
}
const isArtworkMatch = (title, artist, candidateTitle, candidateArtist) =>
  artworkMatchConfidence(title, artist, candidateTitle, candidateArtist) >= .84
module.exports = { key, mainArtist, leadArtist, titleKey, artistMatches, artworkMatchConfidence, isArtworkMatch }
