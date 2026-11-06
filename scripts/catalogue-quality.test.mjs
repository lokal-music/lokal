import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { streamQuality } = require('../electron/online/streamQuality.js')
import test from 'node:test'
import assert from 'node:assert/strict'

// The renderer utility is an ESM module loaded by Vite; importing a data URL
// avoids changing Electron's CommonJS package type just for this test.
const source = readFileSync(new URL('../src/catalogueQuality.js', import.meta.url), 'utf8')
const { advertisedQuality } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

test('show known bit depth and kHz without inventing missing sample rate', () => {
  assert.equal(advertisedQuality({ quality: '24bit/96kHz' }), '24-bit / 96 kHz')
  assert.equal(advertisedQuality({ quality: '16bit/44.1kHz' }), '16-bit / 44.1 kHz')
  assert.equal(advertisedQuality({ quality: '24bit' }), '24-bit')
  assert.equal(advertisedQuality({ quality: 'HI_RES_LOSSLESS' }), 'Hi-res lossless')
  assert.equal(advertisedQuality({}), '')
  assert.equal(advertisedQuality({ bit_depth: 24, sample_rate: 96000 }), '24-bit / 96 kHz')
})

test('parse complete Tidal Hz and kHz values without partial matches', () => {
  assert.deepEqual(
    { ...streamQuality('24bit/44100Hz') },
    { codec: null, lossless: 1, bit_depth: 24, sample_rate: 44100, bitrate: null }
  )
  assert.equal(streamQuality('24bit/44100').sample_rate, 44100)
  assert.equal(streamQuality('FLAC 16/44.1').sample_rate, 44100)
  assert.equal(streamQuality('FLAC 24-bit / 96 kHz').sample_rate, 96000)
  assert.equal(streamQuality('24bit').sample_rate, null)
  assert.equal(streamQuality('24bit/441000Hz').sample_rate, null)
  assert.equal(streamQuality('24bit/44100Hznot-a-format').sample_rate, null)
})

test('only parsed positive lossy bitrates can yield a tier', () => {
  const aac = streamQuality('AAC')
  const mp3 = streamQuality('MP3 320 kbps')
  assert.equal(aac.lossless, 0)
  assert.equal(aac.bitrate, null)
  assert.equal(mp3.lossless, 0)
  assert.equal(mp3.bitrate, 320)
})

test('Atmos mode alone is not stereo catalogue quality', () => {
  assert.equal(advertisedQuality({ audio_quality: 'DOLBY_ATMOS' }), '')
  assert.equal(advertisedQuality({ quality: 'ATMOS' }), '')
  assert.equal(advertisedQuality({ quality: '24bit/96kHz', audio_quality: 'DOLBY_ATMOS' }), '24-bit / 96 kHz')
  assert.equal(advertisedQuality({ audio_quality: 'DOLBY_ATMOS', bit_depth: 24, sample_rate: 96000 }), '24-bit / 96 kHz')
})

test('LastWave search FLAC advertises lossless without fabricating bit depth', () => {
  assert.equal(advertisedQuality({ quality: 'flac' }), 'FLAC · Lossless')
  assert.equal(advertisedQuality({ quality: 'flac', bit_depth: 24, sample_rate: 44100 }), '24-bit / 44.1 kHz')
  assert.equal(advertisedQuality({ quality: 'LOSSLESS', bit_depth: 16, sample_rate: 48000 }), '16-bit / 48 kHz')
})

