import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { lyricsFromMeta, lyricsForEditor } = require('../electron/lyrics/fileLyrics.js')
const { parseAny } = require('../electron/lyrics/detect.js')
const { finish } = require('../electron/lyrics/postprocess.js')

// Millisecond positions transcribed from the user-supplied Mornye FLAC's
// Vorbis LYRICS/UNSYNCEDLYRICS fields. The test uses synthetic words instead
// of redistributing the recording or copyrighted lyric lines.
const timestamps = [
  2916, 6811, 9117, 11004, 12925, 14486, 16939, 18832, 20075,
  22714, 24701, 26611, 30635, 32561, 34384, 38383, 42203, 46173,
  50115, 53448, 57092, 61948, 65071, 69791, 71956, 73915, 75882,
  77709, 79863, 81944, 83768, 85723, 87731, 89052, 93598, 95514,
  97315, 101301, 105167, 109010, 113074, 116498, 120925, 124895,
  128075, 133687, 135531, 137519, 140863, 142157, 146621, 150487,
  154434, 158282, 162298, 166167, 170164, 173446, 177994, 181851,
  185781,
]
const stamp = ms =>
  '[' + String(Math.floor(ms / 60000)).padStart(2, '0') +
  ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') +
  '.' + String(ms % 1000).padStart(3, '0') + ']'
const lrc = [
  '[ti:Call On Me]',
  '[ar:RAYE]',
  '[by:Mornye (source: lrc.red)]',
  '',
  ...timestamps.map((ms, index) => stamp(ms) + 'v1:Line ' + (index + 1)),
].join('\n')

test('entire uploaded FLAC lyric shape strips all 61 v1 labels and preserves timestamps', () => {
  const parsed = parseAny(lrc)
  assert.ok(parsed)
  const result = finish(parsed.lines, { source: 'local' })
  const sung = result.lines.filter(line => line.text)
  assert.equal(sung.length, 61)
  assert.equal(result.sync, 'line')
  assert.deepEqual(sung.map(line => Math.round(line.time * 1000)), timestamps)
  assert.deepEqual(sung.map(line => line.text), timestamps.map((_, i) => 'Line ' + (i + 1)))
  assert.ok(sung.every(line => line.agent === 'v1'))
  assert.ok(sung.every(line => line.words.length === 0))
})

test('desktop metadata reader prefers timestamped native Vorbis tags over flattened common.lyrics', () => {
  const flattened = lrc.replace(/\[\d{1,3}:\d{1,2}\.\d{3}\]/g, '')
  const meta = {
    common: { lyrics: [{ text: flattened }] },
    native: { vorbis: [
      { id: 'UNSYNCEDLYRICS', value: lrc },
      { id: 'LYRICS', value: lrc },
    ] },
  }
  assert.equal(lyricsFromMeta(meta), lrc)
  assert.equal(lyricsForEditor(lyricsFromMeta(meta)).split('\n').length, lrc.split('\n').length)
  // This normalizes the editor view only and does not mutate either source tag.
  assert.equal(meta.native.vorbis[0].value, lrc)
  assert.equal(meta.native.vorbis[1].value, lrc)
})

test('tag editor hides the prefixed voice marker on all 61 rows without losing LRC timing', () => {
  const cleaned = lyricsForEditor(lrc)
  assert.equal(lyricsForEditor(cleaned), cleaned)
  assert.ok(cleaned.includes('[by:Mornye (source: lrc.red)]'))
  assert.ok(!cleaned.includes(']v1:'))
  assert.deepEqual(
    cleaned.split('\n').filter(line => /^\[\d/.test(line)),
    timestamps.map((ms, i) => stamp(ms) + 'Line ' + (i + 1)),
  )
})

test('editor handles simultaneous duet voices, untimed, enhanced and non-label mentions', () => {
  const raw = [
    '[00:01.000]v1:First',
    '[00:01.000]v2：Second',
    '[00:02.000]<00:02.000>v2:Third',
    'v1: Plain',
    '[00:03.000]I said v1: but did not sing a label',
    '[00:04.000]v1:',
  ].join('\n')
  const cleaned = lyricsForEditor(raw).split('\n')
  assert.deepEqual(cleaned, [
    '[00:01.000]First',
    '[00:01.000]Second',
    '[00:02.000]<00:02.000>Third',
    'Plain',
    '[00:03.000]I said v1: but did not sing a label',
    '[00:04.000]v1:',
  ])
})
