// Online radio: what to show while a station plays. The stream only says
// "Artist - Title"; the cover comes from the station's own API (the
// catalogue's `api`) or else the app's cover search, and the lyrics views
// look the song up like any other (src/radio/stations.js lyricsTrackFor).
//
// A new song shows its title at once and keeps the previous cover until the
// new one is found (and loaded); no cover found: the station's icon, or none.

import { api, peekSettings } from '../api'
import { usePlayerStore } from '../store/player'
import { radioBufferSeconds, useRadioStore } from '../store/radio'
import { isStationTrack, parseStreamTitle, sameSong, stationSongKey } from './stations'

const API_RETRY_MS = 5000
// A title heard this early in a connection is a song already under way: where
// it is in the song is unknown (unless the station's API says).
const CONNECT_WINDOW_S = 1.5
const PRELOAD_TIMEOUT_MS = 10000
const COVER_CACHE_MAX = 200

let sequence = 0
const coverCache = new Map()

function rememberCover(key, url) {
  coverCache.delete(key)
  coverCache.set(key, url)
  if (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Loads the image first, so the cover changes only once there's something to show. */
function preload(url) {
  if (!url || typeof Image === 'undefined') return Promise.resolve(!!url)
  return new Promise(resolve => {
    const image = new Image()
    const timer = setTimeout(() => resolve(false), PRELOAD_TIMEOUT_MS)
    image.onload = () => { clearTimeout(timer); resolve(true) }
    image.onerror = () => { clearTimeout(timer); resolve(false) }
    image.src = url
  })
}

/** The API's song is the stream's (titles match; artists may be spelt differently). */
function apiMatches(info, song) {
  if (!info) return false
  if (sameSong(info, song)) return true
  return sameSong({ artist: '', title: info.title }, { artist: '', title: song.title })
}

async function stationApiSong(stationApi, song, isCurrent) {
  if (!stationApi || !api.radioNowPlaying) return null
  let info = await api.radioNowPlaying(stationApi).catch(() => null)
  if (apiMatches(info, song)) return info
  // The API is live; what's heard is behind it by the buffer, or the API
  // hasn't caught up yet: once more, a little later.
  await wait(API_RETRY_MS)
  if (!isCurrent()) return null
  info = await api.radioNowPlaying(stationApi).catch(() => null)
  return apiMatches(info, song) ? info : null
}

async function searchCover(song) {
  if (!song.artist || !song.title || !api.discoveryArtwork) return null
  const results = await api.discoveryArtwork([{ type: 'track', title: song.title, artist: song.artist }]).catch(() => [])
  const found = Array.isArray(results) ? results[0] : null
  return found?.image || null
}

// A station whose stream never names its songs (Nova's, say) but whose API
// does (the catalogue's `api`): the API is asked every API_POLL_MS while it
// plays, and its song goes through the same path as a title from the stream.
const API_POLL_MS = 15000
let poll = { trackId: null, timer: null }

function stopApiPolling() {
  clearTimeout(poll.timer)
  poll = { trackId: null, timer: null }
}

function startApiPolling(track) {
  stopApiPolling()
  const stationApi = track.station?.api
  const station = track.station
  const metadataLookup = stationApi && api.radioNowPlaying
    ? () => api.radioNowPlaying(stationApi)
    : api.radioStationMetadata && station?.id?.startsWith('rb:')
      ? () => api.radioStationMetadata(station)
      : null
  if (!metadataLookup) return
  const mine = { trackId: track.id, timer: null }
  poll = mine
  const tick = async () => {
    if (poll !== mine) return
    const current = usePlayerStore.getState().currentTrack
    if (!current || current.id !== mine.trackId || !isStationTrack(current)) { stopApiPolling(); return }
    const info = await metadataLookup().catch(() => null)
    if (poll !== mine) return
    const now = usePlayerStore.getState().currentTrack
    if (info?.title && now?.id === mine.trackId && !(now.song_key && sameSong(info, now))) {
      await handleStationTitle(mine.trackId, info.title, NaN, info)
    }
    if (poll === mine) mine.timer = setTimeout(tick, API_POLL_MS)
  }
  tick()
}

/**
 * A station was picked: it shows itself (its icon, or no cover) straight
 * away, not the previous song's cover while the stream connects.
 */
export function resetStationDisplay(track) {
  if (!isStationTrack(track)) return
  startApiPolling(track)
  sequence++
  const station = track.station || {}
  usePlayerStore.getState().patchStationTrack(track.id, {
    title: station.title || track.title,
    artist: track.catalog_title || '',
    album: station.title || track.album,
    artwork_url: station.icon || null,
    song_key: null, song_clock_base: null, song_duration: 0, song_lyrics: null, song_year: null,
  })
}

/** The stream's title changed (heard now, at `audioTime` on the element). */
export async function handleStationTitle(trackId, text, audioTime, broadcasterInfo = null) {
  const current = usePlayerStore.getState().currentTrack
  if (!current || current.id !== trackId || !isStationTrack(current)) return
  const station = current.station || {}
  const song = broadcasterInfo?.title
    ? { artist: broadcasterInfo.artist || '', title: broadcasterInfo.title }
    : parseStreamTitle(text, station.title)
  if (!song) return
  const joinedMidSong = !Number.isFinite(audioTime) || audioTime < CONNECT_WINDOW_S
  // The same title again (a reconnect, a repeated block): nothing changed,
  // except that after a reconnect the place in the song isn't known any more.
  if (current.song_key && sameSong(song, current)) {
    if (joinedMidSong) {
      ++sequence // invalidate any older, still-running lookup for this song
      usePlayerStore.getState().patchStationTrack(trackId, { song_clock_base: null, song_clock_known: false })
    }
    return
  }

  const mine = ++sequence
  const isCurrent = () => mine === sequence && usePlayerStore.getState().currentTrack?.id === trackId
  const key = stationSongKey(station.id, song.artist, song.title)
  usePlayerStore.getState().patchStationTrack(trackId, {
    title: song.title, artist: song.artist, album: station.title,
    song_key: key, song_clock_base: Number.isFinite(audioTime) ? audioTime : null, song_clock_known: !joinedMidSong,
    song_duration: 0, song_lyrics: null, song_year: null,
  })
  useRadioStore.getState().setNowPlaying(station.id, { artist: song.artist, title: song.title, cover: broadcasterInfo?.cover || null })

  let cover = coverCache.get(key)
  let info = null
  if (cover === undefined) {
    // Never perform an extra artwork lookup if the broadcaster already gave
    // the exact current track and its cover.
    info = broadcasterInfo || await stationApiSong(station.api, song, isCurrent)
    if (!isCurrent()) return
    cover = info?.cover || await searchCover(song)
    if (!isCurrent()) return
    if (cover && !(await preload(cover))) cover = null
    rememberCover(key, cover || null)
  } else {
    info = broadcasterInfo || (station.api ? await stationApiSong(station.api, song, isCurrent) : null)
  }
  if (!isCurrent()) return

  // Joined mid-song: the station's API may say how far into it the station
  // is; what's heard is behind that by the buffer.
  let clock = {}
  if (joinedMidSong && Number.isFinite(info?.elapsed)) {
    const el = usePlayerStore.getState().audioRef?.current
    const heard = info.elapsed - radioBufferSeconds(peekSettings()?.radio_buffer_sec)
    if (el && Number.isFinite(el.currentTime) && heard > 0) clock = { song_clock_base: el.currentTime - heard, song_clock_known: true }
  }
  usePlayerStore.getState().patchStationTrack(trackId, {
    ...clock,
    artwork_url: cover || station.icon || null,
    ...(info?.album ? { album: info.album } : {}),
    ...(info?.year ? { song_year: info.year } : {}),
    ...(info?.duration ? { song_duration: info.duration } : {}),
    ...(info?.lyrics ? { song_lyrics: info.lyrics } : {}),
  })
  useRadioStore.getState().setNowPlaying(station.id, { cover: cover || null, ...(info?.album ? { album: info.album } : {}) })
}
