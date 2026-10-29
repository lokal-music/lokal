'use strict'

// Tidal exposes Dolby Atmos as an audio mode, independently from the stereo
// stream's FLAC/AAC quality. Never infer Atmos from sample rate or bitrate.
const isAtmosMode = value => typeof value === 'string' &&
  value.split(/[,;|]/).some(mode => /^(?:DOLBY[_ -]?ATMOS|ATMOS|E[_ -]?AC[_ -]?3[_ -]?JOC|AC[_ -]?4[_ -]?ATMOS)$/i.test(mode.trim()))

function hasAtmosMetadata(track) {
  if (!track || typeof track !== 'object') return false
  const values = [
    track.audio_mode, track.audioMode, track.audio_quality, track.audioQuality,
    track.spatial_audio, track.spatialAudio,
    track.audio_modes, track.audioModes,
    ...(Array.isArray(track.audio_modes) ? track.audio_modes : []),
    ...(Array.isArray(track.audioModes) ? track.audioModes : []),
    track.audioQualities, track.audio_qualities,
    ...(Array.isArray(track.audioQualities) ? track.audioQualities : []),
    ...(Array.isArray(track.audio_qualities) ? track.audio_qualities : []),
  ]
  return values.some(isAtmosMode)
}

module.exports = { hasAtmosMetadata }
