import test from 'node:test'
import assert from 'node:assert/strict'
import { BULK_LOSSLESS_TIERS, canBulkUpgradeQuality, collectQualityUpgradeTracks } from '../src/qualityBulk.js'

const track = (id, extra = {}) => ({
  id: String(id), title: 'Track ' + id, artist: 'Artist',
  file_path: '/music/' + id + '.mp3', lossless: 0, ...extra,
})

test('Get all in lossless includes all eligible songs, not just the first 200 displayed', async () => {
  const rows = [
    ...Array.from({ length: 1200 }, (_, id) => track(id + 1)),
    track(1201, { lossless: 1 }),
    track(1202, { atmos_verified: 1 }),
    track(1203, { file_path: 'ghost://remote/song' }),
  ]
  const calls = []
  const progress = []
  const result = await collectQualityUpgradeTracks(opts => {
    calls.push(opts)
    return rows.slice(opts.offset, opts.offset + opts.limit)
  }, 'upgradable', { onProgress: value => progress.push(value) })
  assert.equal(result.length, 1200)
  assert.deepEqual(calls.map(call => [call.offset, call.limit]), [[0, 1000], [1000, 1000]])
  assert.deepEqual(progress.at(-1), { scanned: 1203, eligible: 1200 })
})

test('deduplicates library IDs and honors the existing lossless eligibility rules', async () => {
  const rows = [
    track(1), track(1), track(2, { lossless: 1, spectral_verdict: 'lossy' }),
    track(3, { missing: true }), track(4, { lossless: 1 }),
  ]
  const result = await collectQualityUpgradeTracks(
    async () => rows, 'suspect',
  )
  assert.deepEqual(result.map(row => row.id), ['1', '2'])
})

test('only upgradable, high, low and suspect lists expose the batch action', () => {
  assert.deepEqual([...BULK_LOSSLESS_TIERS], ['upgradable', 'suspect', 'low', 'high'])
  for (const tier of ['lossless', 'hires', 'atmos', 'unknown']) {
    assert.equal(canBulkUpgradeQuality(tier, [track(1)]), false, tier)
  }
  assert.equal(canBulkUpgradeQuality('upgradable', [track(2, { lossless: 1 })]), false)
  assert.equal(canBulkUpgradeQuality('low', [track(3)]), true)
})

test('server failures abort rather than opening the modal with only a partial library', async () => {
  let pages = 0
  await assert.rejects(
    collectQualityUpgradeTracks(async ({ limit }) => {
      if (++pages > 1) return { error: 'Desktop disconnected' }
      return Array.from({ length: limit }, (_, i) => track(i))
    }, 'upgradable'),
    /Desktop disconnected/,
  )
  assert.equal(pages, 2)
})

test('changing the quality filter cancels stale pagination without opening a modal', async () => {
  let current = true
  const result = await collectQualityUpgradeTracks(async ({ offset, limit }) => {
    if (offset === 0) {
      current = false
      return Array.from({ length: limit }, (_, i) => track(i))
    }
    throw new Error('Should not request a cancelled page')
  }, 'high', { isCurrent: () => current })
  assert.equal(result, null)
})

test('protects against repeated full pages and invalid page-size assumptions', async () => {
  const repeated = Array.from({ length: 3 }, (_, i) => track(i))
  await assert.rejects(
    collectQualityUpgradeTracks(async () => repeated, 'low', { pageSize: 3 }),
    /repeated a page/,
  )
  await assert.rejects(
    collectQualityUpgradeTracks(async () => [], 'low', { pageSize: 1001 }),
    /between 1 and 1000/,
  )
})
