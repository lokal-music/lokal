import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseIcecast, statusUrl, visibleStationMetadata } = require('../electron/radio/metadata.js')

test('status lookup uses a host Icecast JSON endpoint, not an audio URL', () => {
  assert.equal(statusUrl('https://music.example.test:8443/live.mp3'),
    'https://music.example.test:8443/status-json.xsl')
  assert.equal(statusUrl('file:///var/private'), null)
})

test('parse now playing from the correct Icecast mount', () => {
  const body = { icestats: { source: [
    { listenurl: 'https://radio.example.test/other', title: 'Wrong artist - Wrong song' },
    { listenurl: 'https://radio.example.test/live', title: 'Artist - Correct song' },
  ] } }
  assert.deepEqual(parseIcecast(body, 'https://radio.example.test/live'),
    { artist: 'Artist', title: 'Correct song' })
  assert.equal(parseIcecast(body, 'https://radio.example.test/missing'), null)
})

test('station metadata reads bounded broadcaster JSON and skips private endpoints', async () => {
  let requests = 0
  const fetchImpl = async url => {
    requests++
    assert.equal(url, 'https://public.example.test/status-json.xsl')
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ icestats: { source: { title: 'A - B' } } }),
    }
  }
  const found = await visibleStationMetadata({
    id: 'rb:uuid', url: 'https://public.example.test/live',
  }, { fetchImpl })
  assert.deepEqual(found, { artist: 'A', title: 'B' })
  const internal = await visibleStationMetadata({
    id: 'rb:private', url: 'http://127.0.0.1:8000/live',
  }, { fetchImpl })
  assert.equal(internal, null)
  assert.equal(requests, 1)
})
