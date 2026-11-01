// Audio Quality's "Get all in lossless" button. Unlike the visible list
// (capped at 200 rows), this walks every page of the selected quality tier.
// Keep discovery/download decisions in the existing BulkLosslessModal.

import { canGetLossless } from './quality.js'

// Only tiers with files that may benefit from a verified lossless replacement.
// Already-good lossless, hi-res and spatial Atmos are not bulk upgrade targets.
export const BULK_LOSSLESS_TIERS = new Set(['upgradable', 'suspect', 'low', 'high'])

export function canBulkUpgradeQuality(tier, rows) {
  return BULK_LOSSLESS_TIERS.has(tier) &&
    Array.isArray(rows) && rows.some(canGetLossless)
}

/**
 * Fetch every page independently of the UI's 200-row preview.
 *
 * The quality IPC/HTTP endpoints cap limit at 1000. Passing a larger value
 * would lead to missing pages if offset advanced by the requested count.
 * This function advances by the number actually returned instead.
 *
 * Results are de-duplicated by library ID and checked with the same rules as
 * a single-song "Get it in lossless". The modal reviews matches and asks the
 * user before replacing any original audio files.
 */
export async function collectQualityUpgradeTracks(
  qualityList,
  tier,
  { pageSize = 1000, isCurrent = () => true, onProgress = () => {} } = {},
) {
  if (typeof qualityList !== 'function') throw new TypeError('qualityList must be a function')
  if (!BULK_LOSSLESS_TIERS.has(tier)) return []
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new RangeError('pageSize must be between 1 and 1000')
  }
  const eligible = []
  const seen = new Set()
  let offset = 0
  while (isCurrent()) {
    const result = await qualityList({ tier, offset, limit: pageSize })
    if (!isCurrent()) return null
    if (!Array.isArray(result)) {
      throw new Error(result?.error || 'Could not load the complete audio quality list')
    }

    let advanced = 0
    for (const track of result) {
      if (!track?.id || seen.has(String(track.id))) continue
      seen.add(String(track.id))
      advanced++
      if (canGetLossless(track)) eligible.push(track)
    }
    offset += result.length
    onProgress({ scanned: offset, eligible: eligible.length })

    if (result.length < pageSize) return eligible
    if (advanced === 0) {
      throw new Error('Audio quality pagination repeated a page; try again')
    }
  }
  return null
}
