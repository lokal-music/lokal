import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { hasAtmosMetadata } = require('../electron/mornye/atmos.js')
const qualitySource = readFileSync(new URL('../src/quality.js', import.meta.url), 'utf8')
const resultsSource = readFileSync(new URL('../src/components/OnlineResults.jsx', import.meta.url), 'utf8')
const listSource = readFileSync(new URL('../src/components/OnlineSongList.jsx', import.meta.url), 'utf8')
const packagesSource = readFileSync(new URL('../electron/mornye/packages.js', import.meta.url), 'utf8')
const match = qualitySource.match(/export function atmosAvailable\(track\) \{[\s\S]*?\n\}/)
assert.ok(match, 'Atmos predicate exists in the renderer')
const atmosAvailable = new Function(match[0].replace('export function', 'function') + '\nreturn atmosAvailable')()

test('a confirmed AC-4 Atmos or E-AC-3 JOC track gets the same Atmos signal', () => {
  for (const mode of ['ATMOS', 'DOLBY_ATMOS', 'AC4_ATMOS', 'AC-4 Atmos', 'EAC3_JOC', 'E-AC-3 JOC']) {
    assert.equal(hasAtmosMetadata({ audio_modes: mode }), true, mode)
    assert.equal(atmosAvailable({ audio_modes: mode }), true, mode)
  }
})

test('bare codec support or a provider-wide quality option never proves Atmos', () => {
  for (const track of [
    {},
    { codec: 'ac4' },
    { audio_modes: 'AC-4' },
    { audio_modes: 'E-AC-3' },
    { audio_quality: 'FLAC Best Available', atmos_requestable: 1 },
  ]) {
    assert.equal(hasAtmosMetadata(track), false)
    assert.equal(atmosAvailable(track), false)
  }
})

test('desktop search uses a purple Atmos badge and hides speculative actions', () => {
  assert.match(qualitySource, /bg-violet-500\/15 text-violet-200 border-violet-400\/30/)
  assert.match(resultsSource, /atmosAvailable\(item\) && <AtmosPlayButton/)
  assert.match(listSource, /atmosAvailable\(track\) && <AtmosPlayButton/)
  assert.doesNotMatch(resultsSource, /atmosRequestable\(item\) && <AtmosPlayButton/)
  assert.doesNotMatch(listSource, /atmosRequestable\(track\) && <AtmosPlayButton/)
  assert.match(resultsSource, /\{t\('Atmos'\)\}/)
  assert.match(listSource, />Atmos<\/span>/)
})

test('Amazon search only removes exact duplicate track IDs, keeping separate editions', () => {
  assert.match(packagesSource, /const id=String\(song.id\)/)
  assert.match(packagesSource, /const existing=unique.get\(id\)/)
  assert.match(packagesSource, /hasAtmosMetadata\(song\) && !hasAtmosMetadata\(existing\)/)
})
