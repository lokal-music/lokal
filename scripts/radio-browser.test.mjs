import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { MIN_BITRATE, eligibleStation, toStation, browseStations, queryParams } = require('../electron/radio/browser.js')

const station = (codec, bitrate, id) => ({
  stationuuid: id, name: 'Station ' + id, codec, bitrate,
  url_resolved: 'https://streams.example.test/' + id, lastcheckok: 1,
  country: 'France', countrycode: 'FR', tags: 'jazz,deep',
})

test('strict 256 kbps minimum: no low, missing or broken lossy stations', () => {
  assert.equal(MIN_BITRATE, 256)
  assert.equal(eligibleStation(station('MP3', 255, 'low')), false)
  assert.equal(eligibleStation(station('AAC', 256, 'ok')), true)
  assert.equal(eligibleStation(station('OPUS', 320, 'opus')), true)
  assert.equal(eligibleStation(station('UNKNOWN', 999, 'unknown')), false)
  assert.equal(eligibleStation({ ...station('MP3', 320, 'broken'), lastcheckok: 0 }), false)
  assert.equal(eligibleStation({ ...station('MP3', 320, 'url'), url_resolved: 'file:///tmp/audio' }), false)
  assert.equal(eligibleStation(station('FLAC', 0, 'flac')), true)
})

test('server-side query filters bitrate and pagination, with lossless exception', () => {
  const lossy = queryParams({ name: 'Nova', tag: 'jazz', countrycode: 'FR', offset: 40, limit: 50 })
  assert.equal(lossy.get('bitrateMin'), '256')
  assert.equal(lossy.get('hidebroken'), 'true')
  assert.equal(lossy.get('name'), 'Nova')
  assert.equal(lossy.get('offset'), '40')
  const flac = queryParams({ offset: 40 }, true)
  assert.equal(flac.get('bitrateMin'), '0')
  assert.equal(flac.get('codec'), 'FLAC')
  assert.equal(flac.get('offset'), '0')
})

test('maps stable IDs, codec, bitrate, country and tags', () => {
  const result = toStation(station('MP3', 320, 'uuid-1'))
  assert.equal(result.id, 'rb:uuid-1')
  assert.equal(result.bitrate, 320)
  assert.equal(result.genre, 'jazz')
  assert.equal(result.countrycode, 'FR')
})

test('discovery selects only qualifying streams and deduplicates FLAC variants', async () => {
  const calls = []
  const mockFetch = async url => {
    calls.push(new URL(url))
    const lossless = new URL(url).searchParams.get('codec') === 'FLAC'
    return { ok: true, json: async () => lossless
      ? [station('FLAC', 0, 'flac'), station('FLAC', 0, 'flac')]
      : [station('MP3', 128, 'low'), station('AAC', 256, 'aac')] }
  }
  const result = await browseStations({ name: 'Nova', limit: 20 }, { fetchImpl: mockFetch })
  assert.deepEqual(result.stations.map(s => s.id), ['rb:flac', 'rb:aac'])
  assert.equal(result.hasMore, false)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(url => url.searchParams.get('name') === 'Nova'))
})
