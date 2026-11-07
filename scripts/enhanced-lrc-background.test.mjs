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


test('background rows grouped after all leads still follow their audio timestamps', () => {
  const leads = Array.from({ length: 41 }, (_, i) => {
    const t = String(i * 5).padStart(2, '0')
    const m = String(Math.floor(i * 5 / 60)).padStart(2, '0')
    const sec = String(i * 5 % 60).padStart(2, '0')
    return `[${m}:${sec}.000]v1:<${m}:${sec}.000>Lead ${i + 1}<${m}:${sec}.900>`
  })
  const bg = Array.from({ length: 16 }, (_, i) => {
    const seconds = 75 + i * 5 + 1
    const m = String(Math.floor(seconds / 60)).padStart(2, '0')
    const s = String(seconds % 60).padStart(2, '0')
    return `[bg:<${m}:${s}.100><${m}:${s}.100>Voice ${i + 1}<${m}:${s}.900>]`
  })
  const lines = parseEnhancedLRC([...leads, '', ...bg].join('\n'))
  assert.equal(lines.length, 41)
  assert.equal(lines.filter(x => x.bgText).length, 16)
  assert.equal(lines[15].bgText, 'Voice 1')
  assert.equal(lines[16].bgText, 'Voice 2')
  assert.equal(lines[15].bgWords[0].time, 76.1)
  assert.equal(lines[0].bgText, undefined)
  assert.equal(lines[40].bgText, undefined)
})

test('out-of-order or separated backing rows associate by onset, not surrounding text', () => {
  const raw = [
    '[bg:<00:07.00><00:07.00>Early<00:08.00>]',
    '',
    '[00:05.00]<00:05.00>First<00:09.00>',
    '[00:10.00]<00:10.00>Second<00:13.00>',
    '',
    '[bg:<00:11.00><00:11.00>Late<00:12.00>]',
  ].join('\n')
  const lines = parseEnhancedLRC(raw)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].bgText, 'Early')
  assert.equal(lines[1].bgText, 'Late')
})
