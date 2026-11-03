// Online radio playback: icecast-metadata-player plays the station through the
// app's own <audio> element (so the EQ, volume and analyser keep working),
// buffers before starting, reads the ICY metadata and reports each title
// change when it is actually heard (after the buffer).
//
// The player owns the element while a station plays: pausing the element
// stops the stream, playing it reconnects live. release() hands it back
// clean before an ordinary song takes the element again.

import IcecastMetadataPlayer from 'icecast-metadata-player'
import { stationMetadataTypes, streamTitleFromMetadata } from './streamMetadata.mjs'

let session = null
let generation = 0
let releaseTail = Promise.resolve()

/** The station playing (or set to play), or null. */
export function radioTrackId() {
  return session?.trackId ?? null
}

/** MP3 / AAC / ... from what the codec parser reports. */
function codecName(info) {
  if (!info) return ''
  if (info.layer) return String(info.layer).includes('III') ? 'MP3' : `MPEG ${info.layer}`
  if (info.profile) return 'AAC'
  if (info.vendor || info.preSkip != null) return 'Opus'
  if (info.bitDepth && info.streamInfo) return 'FLAC'
  return ''
}

/**
 * Stop the station and give the element back: no source, not looping (the
 * player leaves a looping silent clip on it to keep the play button usable).
 */
export async function releaseRadio({ invalidate = true } = {}) {
  const current = session
  session = null
  if (invalidate) generation++
  if (!current) {
    await releaseTail.catch(() => {})
    return
  }
  const releaseGeneration = generation
  const detach = async () => {
    try { await current.player.detachAudioElement() } catch {}
    // A newer station request owns the shared audio element now. An older
    // detach must never pause or clear its newly attached stream.
    if (generation !== releaseGeneration) return
    const el = current.el
    try {
      el.loop = false
      el.pause()
      el.removeAttribute('src')
      el.srcObject = null
      el.load()
    } catch {}
  }
  const pending = releaseTail.catch(() => {}).then(detach)
  releaseTail = pending
  await pending
}

/**
 * Play `track` (a station entry, src/radio/stations.js) on `el`.
 *   bufferSec  seconds of audio gathered before it starts (0: none)
 *   autoplay   start now (otherwise on the next playRadio())
 *   handlers   { onTitle(text, audioTime), onStreamInfo({bitrate, codec}),
 *                onBuffering(bool), onFailed(message), onLog(message, level) }
 */
export async function startRadio(el, track, { bufferSec = 3, autoplay = true, handlers = {} } = {}) {
  const mine = ++generation
  await releaseRadio({ invalidate: false })
  if (generation !== mine) return false
  const live = () => generation === mine && session?.trackId === track.id
  const log = (message, level = 'info') => handlers.onLog?.(`[radio] ${track.title}: ${message}`, level)
  el.loop = false
  const player = new IcecastMetadataPlayer(track.stream_url, {
    audioElement: el,
    metadataTypes: stationMetadataTypes(track.stream_url, track.station?.codec),
    bufferLength: Math.max(0, Number(bufferSec) || 0),
    retryTimeout: 60,
    retryDelayMin: 1,
    retryDelayMax: 8,
    icyDetectionTimeout: 4000,
    enableLogging: false,
    onLoad: () => { if (live()) handlers.onBuffering?.(true) },
    onBuffer: () => { if (live()) handlers.onBuffering?.(true) },
    onPlay: () => { if (live()) { handlers.onBuffering?.(false); log(`playing (${player.playbackMethod || '?'}, buffer ${bufferSec}s)`) } },
    onMetadata: (metadata) => {
      if (!live()) return
      const title = streamTitleFromMetadata(metadata)
      if (title) handlers.onTitle?.(title, el.currentTime)
    },
    onCodecUpdate: (info) => {
      if (!live()) return
      handlers.onStreamInfo?.({ bitrate: Number(info?.bitrate) || null, codec: codecName(info) })
    },
    onRetry: () => { if (live()) { handlers.onBuffering?.(true); log('reconnecting', 'warn') } },
    onRetryTimeout: () => { if (live()) { handlers.onBuffering?.(false); handlers.onFailed?.('The station stopped responding.') } },
    onWarn: (...messages) => { if (live()) log(messages.join(' '), 'warn') },
    onError: (message, error) => {
      if (!live()) return
      log(`${message}${error?.message ? ` (${error.message})` : ''}`, 'warn')
    },
  })
  session = { player, el, trackId: track.id }
  if (autoplay) await playRadio()
}

/** Start (or reconnect, after a pause) the current station. */
export async function playRadio() {
  const current = session
  if (!current) return
  if (current.player.state === 'stopped') {
    try { await current.player.play() } catch {}
  } else if (current.el.paused) {
    try { await current.el.play() } catch {}
  }
}

/** Pause = stop the stream (it's live: resuming starts from now). */
export function pauseRadio() {
  const current = session
  if (!current) return
  try { current.el.pause() } catch {}
}
