import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseEnhancedLRC } = require('../electron/lyrics/lrc.js')
const { finish } = require('../electron/lyrics/postprocess.js')

test('standalone timed backing vocals remain attached to the overlapping lead', () => {
  const raw = [
    '[00:15.433]v1:<00:15.433>Lead <00:16.353>voice <00:22.852>',
    '[bg:<00:17.254><00:17.254>Backing <00:17.726><00:17.726>voice <00:21.736><00:21.736>]',
    '[00:23.055]v1:<00:23.055>Next <00:24.039>line <00:24.474>',
  ].join('\n')
  const parsed = parseEnhancedLRC(raw)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed.map(line => line.text), ['Lead voice', 'Next line'])
  assert.equal(parsed[0].agent, 'v1')
  assert.equal(parsed[0].bgText, 'Backing voice')
  assert.deepEqual(parsed[0].bgWords.map(word => word.word), ['Backing', 'voice'])
  assert.deepEqual(parsed[0].bgWords.map(word => word.time), [17.254, 17.726])
  assert.equal(parsed[0].bgWords.at(-1).end, 21.736)
  const finished = finish(parsed)
  const sung = finished.lines.filter(line => !line.gap)
  assert.equal(sung.length, 2)
  assert.equal(sung[0].bgText, 'Backing voice')
  assert.equal(sung[0].translation, undefined)
  assert.equal(finished.sync, 'syllable')
})

test('background timestamps respect LRC offset and are not a translation', () => {
  const raw = '[offset:500]\n[00:01.00]<00:01.00>Lead<00:03.00>\n' +
    '[bg:<00:01.50><00:01.50>Harmony<00:02.50><00:02.50>]\n' +
    '[00:03.20]<00:03.20>Next<00:04.20>'
  const parsed = parseEnhancedLRC(raw)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].bgText, 'Harmony')
  assert.equal(parsed[0].bgWords[0].time, 1)
  assert.equal(parsed[0].bgWords[0].end, 2)
  assert.equal(parsed[0].translation, undefined)
})
