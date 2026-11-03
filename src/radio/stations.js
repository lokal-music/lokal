// Online radio: a station from the catalogue as an entry the player can queue,
// and what the stream says is playing ("Artist - Title").

export const STATION_PATH_PREFIX = 'station://'
export const RADIO_CONTEXT = 'internet-radio'
// The station list everyone starts with (the main repository's radios.json):
// used until another link is set (Settings → Online Radio).
export const DEFAULT_RADIO_CATALOG_URL = 'https://raw.githubusercontent.com/lokal-music/Desktop/refs/heads/main/radios.json'

/** Move only the former built-in catalogue; custom station lists stay intact. */
export function resolveRadioCatalogUrl(url) {
  if (!url || /^https:\/\/raw\.githubusercontent\.com\/(?:sipbuu\/lokal|lokal-music\/lokal)\/(?:refs\/heads\/)?main\/radios\.json$/.test(url)) {
    return DEFAULT_RADIO_CATALOG_URL
  }
  return url
}

/** Is this queue entry an online radio station? */
export function isStationTrack(track) {
  return track?.kind === 'station' || String(track?.file_path || '').startsWith(STATION_PATH_PREFIX)
}

/** The queue entry for a station: it starts out showing the station itself. */
export function stationTrack(station, catalogTitle = '') {
  return {
    id: station.id,
    kind: 'station',
    file_path: `${STATION_PATH_PREFIX}${station.url}`,
    stream_url: station.url,
    station: { id: station.id, title: station.title, url: station.url, icon: station.icon || null, genre: station.genre || '', description: station.description || '', history: station.history || '', api: station.api || null, codec: station.codec || '', bitrate: Number(station.bitrate) || 0, lossless: station.lossless === true },
    catalog_title: catalogTitle,
    title: station.title,
    artist: catalogTitle || '',
    album: station.title,
    genre: station.genre || '',
    artwork_url: station.icon || null,
    duration: 0,
  }
}

/**
 * "Artist - Title" from an ICY StreamTitle: split at the first " - ". With
 * no separator the whole text is the title and the station is the artist.
 */
export function parseStreamTitle(text, stationTitle = '') {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!value) return null
  const at = value.indexOf(' - ')
  if (at > 0 && at < value.length - 3) return { artist: value.slice(0, at).trim(), title: value.slice(at + 3).trim() }
  return { artist: stationTitle, title: value }
}

const normPart = value => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s*[([]\s*(?:original|extended|radio|club|vip|album|single|instrumental|acoustic|live|remaster(?:ed)?|clean|explicit|slowed|sped up|speed up|remix|mix|edit|version|\d{4}\s+remaster(?:ed)?)(?:\s+(?:mix|edit|version|remaster(?:ed)?))?\s*[)\]]\s*$/i, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Same song, ignoring case, accents, punctuation and "(Original Mix)"-style suffixes. */
export function sameSong(a, b) {
  if (!a || !b) return false
  return normPart(a.title) === normPart(b.title) && normPart(a.artist) === normPart(b.artist)
}

/** A key per song heard on a station (lyrics are cached under it). */
export function stationSongKey(stationId, artist, title) {
  return `${stationId}|${normPart(artist)}|${normPart(title)}`
}

/**
 * What the lyrics views look up: for a station, the song now playing on it
 * under its own id (so each song gets its own lyrics), no file, and the
 * song's length when the station's API told us.
 */
export function lyricsTrackFor(track) {
  if (!isStationTrack(track) || !track.song_key) return track
  return { ...track, id: `station-song:${track.song_key}`, file_path: '', duration: Number(track.song_duration) || 0 }
}

/** A station's song whose place in it isn't known (tuned in mid-song): its lyrics can't follow it. */
export function stationClockUnknown(track) {
  return isStationTrack(track) && track?.song_clock_known === false
}

/** Seconds into the song now playing on a station (null when unknown). */
export function stationSongTime(track, audioTime) {
  if (!isStationTrack(track) || !Number.isFinite(track?.song_clock_base) || !Number.isFinite(audioTime)) return null
  return Math.max(0, audioTime - track.song_clock_base)
}
