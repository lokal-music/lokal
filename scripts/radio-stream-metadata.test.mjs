import test from 'node:test'
import assert from 'node:assert/strict'
import { stationMetadataTypes, streamTitleFromMetadata } from '../src/radio/streamMetadata.mjs'

test('ordinary MP3 and AAC stations read ICY stream titles', () => {
  assert.deepEqual(stationMetadataTypes('https://example.org/live.mp3', 'MP3'), ['icy'])
  assert.deepEqual(stationMetadataTypes('https://example.org/live.aac', 'AAC'), ['icy'])
  assert.equal(streamTitleFromMetadata({ StreamTitle: 'Artist - Current Song' }), 'Artist - Current Song')
})

test('Ogg and Opus streams enable Vorbis comment metadata as well as ICY', () => {
  assert.deepEqual(stationMetadataTypes('https://example.org/live.opus', ''), ['icy', 'ogg'])
  assert.deepEqual(stationMetadataTypes('https://example.org/live', 'OPUS'), ['icy', 'ogg'])
  assert.equal(streamTitleFromMetadata({ ARTIST: 'Performer', TITLE: 'Track Name' }),
    'Performer - Track Name')
  assert.equal(streamTitleFromMetadata({ TITLE: 'Single Track Title' }), 'Single Track Title')
})

test('empty audio metadata cannot overwrite live song state', () => {
  assert.equal(streamTitleFromMetadata({}), null)
  assert.equal(streamTitleFromMetadata(null), null)
  assert.equal(streamTitleFromMetadata({ StreamTitle: '', TITLE: 'Ogg Song' }), 'Ogg Song')
})
