// A radio stream supplies artist/title, but its `album` field often holds
// the STATION name. Never treat that as an album or navigate by artist alone.
import { api } from '../api.js'
import { isOnlineTrack, onlineAlbumPath } from '../onlineBrowse.js'
import { navigateToTrackAlbum } from '../playbackContext.js'
import { recommendationKey, titleKey } from '../recommendations.js'
import { resolveStationSong } from './stationSong.js'

const normalize = value => recommendationKey(value)
const albumName = (value, station) => {
  const title = String(value || '').trim()
  const stationTitle = String(station?.station?.title || '').trim()
  return title && normalize(title) !== normalize(stationTitle) &&
    !/^(?:unknown album|unknown|radio|live radio)$/i.test(title)
    ? title : null
}

export function radioAlbumFromLastfm(info, station) {
  const track = info?.track || null
  const title = String(track?.name || '').trim()
  const artist = typeof track?.artist === 'string' ? track.artist : track?.artist?.name
  if (!track || titleKey(title) !== titleKey(station?.title) ||
      normalize(artist) !== normalize(station?.artist)) return null
  return albumName(typeof track.album === 'string' ? track.album : track.album?.title, station)
}

/**
 * A radio TITLE is an album shortcut, never an artist shortcut.
 * An unresolved stream title is not enough evidence for an album route.
 * Return false rather than going to the artist or an empty online album.
 */
export async function navigateToRadioAlbum(nav, station, {
  client = api,
  resolve = resolveStationSong,
} = {}) {
  if (!nav || !station?.song_key || !station?.title || !station?.artist) return false

  // Radio station metadata can include a real album; its placeholder album
  // (the station title) must be excluded.
  const broadcastAlbum = albumName(station.album, station)
  let found = null
  try { found = await resolve(station, client) } catch { /* try metadata */ }

  const foundAlbum = albumName(found?.album || found?.album_name || found?.albumName, station)
  if (foundAlbum && found?.artist && found?.title &&
      titleKey(found.title) === titleKey(station.title) &&
      normalize(found.artist) === normalize(station.artist)) {
    // If this is an actual library track, open its own local album.
    if (!isOnlineTrack(found)) return navigateToTrackAlbum(nav, found)
    // For online tracks retain an exact addon album ID only if the resolved
    // song provided the display album too.
    return navigateToTrackAlbum(nav, { ...found, album: foundAlbum })
  }

  let album = broadcastAlbum
  if (!album && typeof client.lastfmGetTrackInfo === 'function') {
    try {
      const info = await client.lastfmGetTrackInfo(station.artist, station.title)
      album = radioAlbumFromLastfm(info, station)
    } catch { /* Last.fm can be disconnected; never guess */ }
  }
  if (!album) return false

  // A broadcaster or verified Last.fm album title can be looked up by name,
  // but never reuse an unrelated stream/provider album ID or station title.
  nav(onlineAlbumPath({ artist: station.artist, album }), {
    state: {
      highlightTitle: station.title,
      anchor: { title: station.title, album, artist: station.artist },
    },
  })
  return true
}
