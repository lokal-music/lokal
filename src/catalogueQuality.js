// Metadata supplied by online catalogues, not the format proved by a decoder.
// Don't invent a bit depth or sample rate for a tier-only response.
export function advertisedQuality(track) {
  if (!track) return ''
  const q = String(track.quality ?? track.audio_quality ?? '').trim()
  // A spatial audio mode is not a PCM quality tier. Independent bit depth
  // and sample-rate fields can still be shown when the provider supplies them.
  const isAtmosMode = /^(?:DOLBY[_ -]?ATMOS|ATMOS)$/i.test(q)
  const bits = Number(track.bit_depth ?? track.bitDepth) ||
    Number(q.match(/\b(16|24|32)\s*(?:-?bit|bits?)\b/i)?.[1]) || 0
  const rawRate = Number(track.sample_rate ?? track.sampleRate) || 0
  const rate = rawRate > 0 ? (rawRate > 1000 ? rawRate / 1000 : rawRate) :
    Number(q.match(/\b(\d{2,3}(?:\.\d+)?)\s*(?:kHz|k)\b/i)?.[1]) || 0
  const suffix = [bits ? `${bits}-bit` : '', rate ? `${Number(rate.toFixed(2))} kHz` : ''].filter(Boolean).join(' / ')
  if (suffix) return suffix
  if (isAtmosMode) return ''
  // FLAC identifies a lossless codec, not a particular PCM resolution.
  // Show the distinction without pretending the provider reported bit depth.
  if (/^flac$/i.test(q)) return 'FLAC · Lossless'
  switch (q.toUpperCase()) {
    case 'HI_RES_LOSSLESS': return 'Hi-res lossless'
    case 'LOSSLESS': return 'Lossless'
    case 'HIGH': return 'High'
    case 'LOW': return 'Low'
    default: return q && q.length <= 40 ? q : ''
  }
}
