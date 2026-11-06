import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const addons = require('../electron/online/addons.js')
const { stageAddonDash } = require('../electron/online/addonDash.js')
const base = 'https://lastwave.example/a/private-hmac-token'
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
function fixtureDb() {
  const settings = new Map()
  return { prepare: () => ({
    get: key => settings.has(key) ? { value: settings.get(key) } : undefined,
    run: (key, value) => settings.set(key, value),
    all: () => [],
  }) }
}
function diagnostic() {
  const events = []
  return { events, onDiagnostic: item => events.push(item) }
}
const manifest = { id: 'diagnostic-lastwave', name: 'LastWave', version: '1', resources: ['search', 'stream'] }

test('LastWave search diagnostics expose response shape and artwork count, never tokens or queries', async () => {
  const db = fixtureDb()
  const { events, onDiagnostic } = diagnostic()
  const fetchImpl = async url => url.includes('/manifest.json') ? json(manifest) : json({
    data: { tracks: [
      { id: 'private-song-id', title: 'Private search text', artist: 'Artist', artworkURL: 'https://cdn.example/signed-cover.jpg?token=do-not-log' },
      { id: 'another-private-id', title: 'Another', artist: 'Artist' },
    ] },
  })
  const addon = await addons.install(db, base + '/manifest.json', { fetchImpl })
  const results = await addons.search(db, addon.key, 'Private search text', { fetchImpl, onDiagnostic })
  assert.equal(results.length, 2)
  assert.ok(events.some(e => e.event === 'addon-http-status' && e.status === 200))
  assert.ok(events.some(e => e.event === 'search-payload' && e.shape === 'data.tracks' && e.received === 2))
  assert.ok(events.some(e => e.event === 'search-normalized' && e.withArtwork === 1))
  const printed = JSON.stringify(events)
  for (const secret of ['private-hmac-token', 'Private search text', 'private-song-id', 'do-not-log']) {
    assert.ok(!printed.includes(secret), 'diagnostics must not contain ' + secret)
  }
})

test('LastWave stream diagnostics distinguish endpoint, nested payload and transport', async () => {
  const db = fixtureDb()
  const { events, onDiagnostic } = diagnostic()
  const fetchImpl = async url => url.includes('/manifest.json') ? json(manifest) : json({
    data: { stream: { streamURL: 'https://cdn.example/media/recording.flac?sig=private', format: 'flac' } },
  })
  const addon = await addons.install(db, base + '/manifest.json', { fetchImpl })
  const stream = await addons.resolveStream(db, addon.key, 'secret-playback-id', { fetchImpl, onDiagnostic })
  assert.equal(stream.format, 'flac')
  assert.ok(events.some(e => e.event === 'resolve-start' && e.source === 'stream-endpoint'))
  assert.ok(events.some(e => e.event === 'stream-payload' && e.nestedStream))
  assert.ok(events.some(e => e.event === 'transport-selected' && e.transport === 'url'))
  assert.ok(events.some(e => e.event === 'resolve-complete'))
  assert.ok(!JSON.stringify(events).includes('secret-playback-id'))
  assert.ok(!JSON.stringify(events).includes('sig=private'))
})

test('DASH staging reports segment failure position without revealing its signed URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lokal-dash-diagnostics-'))
  const xml = '<MPD type="static"><Period><AdaptationSet mimeType="audio/mp4">' +
    '<Representation id="audio" bandwidth="100000"><SegmentTemplate ' +
    'initialization="https://cdn.example/init.m4a?sig=private" ' +
    'media="https://cdn.example/fragment-$Number$.m4s?sig=private" ' +
    'startNumber="1"><SegmentTimeline><S d="48000" r="1"/></SegmentTimeline>' +
    '</SegmentTemplate></Representation></AdaptationSet></Period></MPD>'
  const { events, onDiagnostic } = diagnostic()
  try {
    await assert.rejects(stageAddonDash({ xml, base }, base, {
      directory: dir, key: 'diagnostics',
      fetchImpl: async url => new Response('bad', { status: url.includes('fragment-1') ? 503 : 200 }),
      onDiagnostic,
    }), /could not be fetched/)
    assert.ok(events.some(e => e.event === 'dash-plan' && e.segments === 2))
    assert.ok(events.some(e => e.event === 'dash-segment-response' && e.index === 1 && e.status === 503))
    assert.ok(events.some(e => e.event === 'dash-stage-failed'))
    assert.ok(!JSON.stringify(events).includes('sig=private'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('LastWave failed artwork recovery is connected through search and all player covers', async () => {
  const { readFileSync } = await import('node:fs')
  const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  const search = read('src/components/OnlineResults.jsx')
  const player = read('src/components/PlayerBar.jsx')
  const mini = read('src/components/MiniPlayer.jsx')
  const full = read('src/components/FullscreenPlayer.jsx')
  const component = read('src/components/StreamArtwork.jsx')
  const backend = read('electron/ipc/online.js')
  assert.match(search, /<DiscoveryImage item=\{item\} src=\{item\.thumbnail\} lookup/)
  assert.match(search, /onResolved=\{image => setResults/)
  for (const text of [player, mini, full]) assert.match(text, /<StreamArtwork track=\{/)
  assert.match(component, /rememberRecoveredStreamArtwork\(track, image\)/)
  assert.match(component, /repairOnlineArtwork\?\./)
  assert.match(backend, /online:repairArtwork/)
  assert.match(backend, /file_path LIKE 'ghost:\/\/addon\/%'/)
})

