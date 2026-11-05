import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const addons = require('../electron/online/addons.js')
const { headersForLastWave } = require('../electron/online/lastwaveSigning.js')
const KEY = '36d96a751b12ee481c281a8a8e64c482d0c1634a22061ab72f40175017818b85'

function db() {
  const rows = new Map()
  return { prepare: () => ({
    get: key => rows.has(key) ? { value: rows.get(key) } : undefined,
    run: (key, value) => rows.set(key, value),
    all: () => [],
  }) }
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

test('LastWave HMAC signs decoded path and token, excluding the query string', () => {
  const options = { nowMs: 1700000000000, secret: KEY, intent: 'stream' }
  const actual = headersForLastWave('https://addons.example/a/abc123/search?q=kesariya', options)
  assert.deepEqual(actual, {
    'X-LW-TS': '1700000000',
    'X-LW-Sign': 'cc90954e083bd632ba915ba56f748f3b44320fc063ee8b69a8880406f1317adb',
    'X-LW-Intent': 'stream',
  })
  assert.equal(headersForLastWave('https://addons.example/a/abc123/search?q=other', options)['X-LW-Sign'], actual['X-LW-Sign'])
  assert.deepEqual(headersForLastWave('https://addons.example/search?q=other', options), {})
})

test('LastWave manifest, search, playback and download requests use the correct headers', async () => {
  const database = db()
  const calls = []
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, headers: options.headers })
    if (parsed.pathname.endsWith('/manifest.json'))
      return json({ id: 'lastwave-test', name: 'LastWave test', version: '1', resources: ['search', 'stream'] })
    if (parsed.pathname.endsWith('/search'))
      return json({ tracks: [{ id: 'recording', title: 'Track', artist: 'Artist' }] })
    return json({ data: { directUrl: 'https://cdn.example/recording.flac', format: 'flac', quality: 'LOSSLESS' } })
  }

  const installed = await addons.install(database, 'https://addons.example/a/abc123/manifest.json', { fetchImpl })
  const found = await addons.search(database, installed.key, 'Track', { fetchImpl })
  assert.equal(found.length, 1)
  const stream = await addons.resolveStream(database, installed.key, 'recording', { fetchImpl })
  assert.equal(stream.url, 'https://cdn.example/recording.flac')
  const download = await addons.resolveStream(database, installed.key, 'recording', { fetchImpl, download: true })
  assert.equal(download.url, stream.url)
  assert.deepEqual(calls.map(c => c.headers['X-LW-Intent']), [undefined, 'stream', 'stream', 'download'])
  for (const call of calls) {
    assert.match(call.headers['X-LW-Sign'], /^[a-f0-9]{64}$/)
    assert.match(call.headers['X-LW-TS'], /^\d{10}$/)
  }
})

test('unsigned HTTP addons remain unsigned and signatures do not cross redirect origins', async () => {
  const normal = await addons.getJson('https://addons.example/manifest.json', {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['X-LW-Sign'], undefined)
      return json({ id: 'normal' })
    },
  })
  assert.equal(normal.id, 'normal')
  let hops = 0
  await addons.fetchChecked('https://addons.example/a/abc123/manifest.json', {
    fetchImpl: async (_url, options) => {
      hops++
      if (hops === 1) {
        assert.ok(options.headers['X-LW-Sign'])
        return new Response(null, { status: 302, headers: { location: 'https://redirected.example/a/abc123/manifest.json' } })
      }
      assert.equal(options.headers['X-LW-Sign'], undefined)
      return json({ ok: true })
    },
  })
  assert.equal(hops, 2)
})
