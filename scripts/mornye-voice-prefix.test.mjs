import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseLRC, parseEnhancedLRC, parseKaraokeLRC, parsePlain } = require('../electron/lyrics/lrc.js')
const { finish } = require('../electron/lyrics/postprocess.js')

test('Mornye line-synced labels are voice metadata, not lyrics', () => {
  const lines = parseLRC('[00:01.00]v1: Hello\n[00:02.00]v2： World')
  assert.deepEqual(lines.map(l => l.text), ['Hello', 'World'])
  assert.deepEqual(lines.map(l => l.agent), ['v1', 'v2'])
})

test('enhanced LRC removes split speaker markers without changing sung word times', () => {
  const lines = parseEnhancedLRC(
    '[00:01.00]<00:01.00>v1<00:01.10>:<00:01.20>Hello <00:01.60>world<00:02.00>'
  )
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, 'Hello world')
  assert.equal(lines[0].agent, 'v1')
  assert.deepEqual(lines[0].words.map(w => w.word), ['Hello', 'world'])
  assert.deepEqual(lines[0].words.map(w => w.time), [1.2, 1.6])
})

test('karaoke LRC retains clean word timestamps', () => {
  const lines = parseKaraokeLRC(
    '[1000,1000](1000,100,0)v2:(1100,400,0)Reply'
  )
  assert.equal(lines[0].text, 'Reply')
  assert.equal(lines[0].agent, 'v2')
  assert.deepEqual(lines[0].words.map(w => w.time), [1.1])
})

test('plain lyric prefixes are cleaned only at the start', () => {
  const lines = parsePlain('v1: First\nv2：Second\nI still have a v1: demo\nv1: ')
  assert.deepEqual(lines.map(l => l.text), [
    'First', 'Second', 'I still have a v1: demo', 'v1:'
  ])
})

test('desktop finishing covers cached, TTML, and non-LRC provider rows', () => {
  const result = finish([
    { time: 1, text: 'v1: First', words: [] },
    { time: 2, text: 'v2： Reply', words: [] },
  ])
  assert.deepEqual(result.lines.filter(l => !l.gap).map(l => l.text), ['First', 'Reply'])
  assert.equal(result.duet, true)
  assert.deepEqual(result.lines.filter(l => !l.gap).map(l => l.agent), ['v1', 'v2'])
})
