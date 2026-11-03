// Normalize the metadata shapes emitted by icecast-metadata-player.
// ICY streams use StreamTitle; Ogg/Opus streams commonly use TITLE/ARTIST.
const text = value => String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim()

export function stationMetadataTypes(url, codec = '') {
  let pathname = ''
  try { pathname = new URL(url).pathname.toLowerCase() } catch {}
  const ogg = /\.(?:ogg|oga|opus)(?:$|\.)/.test(pathname) ||
    ['OPUS', 'OGG', 'VORBIS'].includes(String(codec).toUpperCase())
  return ogg ? ['icy', 'ogg'] : ['icy']
}

export function streamTitleFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const icy = text(metadata.StreamTitle || metadata.streamTitle)
  if (icy) return icy
  const title = text(metadata.TITLE || metadata.title)
  if (!title) return null
  const artist = text(metadata.ARTIST || metadata.artist)
  return artist ? artist + ' - ' + title : title
}
