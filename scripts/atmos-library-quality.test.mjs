import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const { atmosProbeCandidate, hasAtmosJocProfile, probeAtmosFile } = require('../electron/quality/atmos')
const backend = require('../electron/quality')
const { findAudioEditionDuplicate } = require('../electron/quality/editionDuplicates')
const source = readFileSync(new URL('../src/quality.js', import.meta.url), 'utf8')
  .replace("import { peekSettings } from './api.js'", 'const peekSettings = () => ({})')
  // A data: URL cannot resolve relative imports. This test only exercises
  // the quality/Atmos tiers, not the resolution-label module itself.
  .replace("import { measuredResolutionLabel } from './resolutionLabel.mjs'", 'const measuredResolutionLabel = () => null')
const frontend = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

test('JOC detection requires actual E-AC-3 codec AND Dolby Atmos profile', () => {
  const joc = [{ codec_name: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos' }]
  assert.equal(hasAtmosJocProfile(joc), true)
  assert.equal(hasAtmosJocProfile([{ codec_name: 'eac3', profile: 'Dolby Digital Plus' }]), false)
  assert.equal(hasAtmosJocProfile([{ codec_name: 'aac', profile: 'Dolby Digital Plus + Dolby Atmos' }]), false)
  assert.equal(hasAtmosJocProfile([{ codec_name: 'eac3', profile: '' }]), false)
})

test('only candidate audio files are probed, and unverified format is never promoted', async () => {
  const get = tracks => ({ stdout: JSON.stringify({ streams: tracks }) })
  const yes = await probeAtmosFile('/music/track.m4a', {
    codec: 'E-AC-3', ffprobe: 'ffprobe',
    runProbe: async (_bin, args) => {
      assert.equal(args.at(-1), '/music/track.m4a')
      return get([{ codec_name: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos' }])
    },
  })
  assert.equal(yes, 1)
  assert.equal(await probeAtmosFile('/music/track.m4a', {
    codec: 'E-AC-3', ffprobe: 'ffprobe',
    runProbe: async () => get([{ codec_name: 'eac3', profile: 'Dolby Digital Plus' }]),
  }), 0)
  assert.equal(await probeAtmosFile('/music/track.m4a', { codec: 'E-AC-3', ffprobe: null }), null)
  assert.equal(await probeAtmosFile('/music/track.mp3', {
    codec: 'MP3', ffprobe: 'ffprobe', runProbe: () => { throw Error('Should not probe MP3') },
  }), null)
  assert.equal(atmosProbeCandidate('/music/track.atmos.m4a', null), true)
})

test('both backend and frontend show actual Atmos rather than bitrate-derived High', () => {
  const verified = { codec: 'E-AC-3', lossless: 0, bitrate: 768, atmos_verified: 1, id: 9, file_path: '/music/song.m4a' }
  const ordinary = { ...verified, atmos_verified: 0 }
  assert.equal(backend.tierOf(verified), 'atmos')
  assert.equal(frontend.tierOf(verified), 'atmos')
  assert.equal(frontend.formatLabel(verified), 'E-AC-3 JOC · Dolby Atmos')
  assert.equal(frontend.canGetLossless(verified), false)
  assert.equal(backend.tierOf(ordinary), 'high')
  assert.equal(frontend.tierOf(ordinary), 'high')
})

test('quality label uses Atmos only for verified files', () => {
  assert.equal(frontend.TIERS.atmos.label, 'Dolby Atmos')
  assert.match(frontend.TIERS.atmos.className, /bg-black/)
  assert.notEqual(frontend.tierOf({ codec: 'E-AC-3', bitrate: 768, lossless: 0 }), 'atmos')
})


test('startup Atmos backfill visits every bounded batch, even when earlier files cannot be read', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, file_path TEXT, codec TEXT, atmos_verified INTEGER)')
    const insert = db.prepare('INSERT INTO tracks (id, file_path, codec) VALUES (?, ?, ?)')
    for (let i = 0; i < 8; i++) {
      insert.run('t-' + String(i).padStart(2, '0'), '/nonexistent-lokal-atmos-backfill-' + i + '.ec3', 'E-AC-3')
    }
    let notified = 0
    const result = await backend.backfillAtmos(db, { limit: 3, onChanged: () => { notified++ } })
    assert.deepEqual(result, { checked: 8, updated: 0 })
    assert.equal(notified, 0)
  } finally {
    db.close()
  }
})

test('single-file imports verify Atmos before their quality transaction', () => {
  const scanner = readFileSync(new URL('../electron/ipc/scanner.js', import.meta.url), 'utf8')
  const single = scanner.split('async function indexSingleFile(filePath, opts = {}) {')[1]
    ?.split('async function applyFileChanges')[0]
  assert.ok(single)
  assert.match(single, /audioQuality\.atmos_verified = await quality\.probeAtmosFile\(filePath, \{ codec: audioQuality\.codec \}\)/)
  assert.match(single, /quality\.saveFields\(db, trackId, audioQuality, \{ fileChanged: true \}\)/)
  assert.match(single, /currentQuality\.atmos_verified = await quality\.probeAtmosFile\(filePath, \{ codec: currentQuality\.codec \}\)/)
})

test('Audio Quality summary arranges all six categories in balanced responsive rows', () => {
  const page = readFileSync(new URL('../src/pages/Quality.jsx', import.meta.url), 'utf8')
  assert.match(page, /grid-cols-2 gap-2 @sm:grid-cols-3 @4xl:grid-cols-6/,
    'two across on small screens, three on medium, six across on wide desktop')
  assert.doesNotMatch(page, /@lg:grid-cols-5/,
    'five columns leave the sixth category orphaned at desktop widths')
  assert.match(page, /\['atmos', 'hires', 'lossless', 'high', 'low', 'suspect'\]\.map\(tier =>/,
    'Atmos and the Suspect diagnostic both remain visible and selectable')
  assert.match(page, /onClick=\{\(\) => selectQualityFilter\(tier\)\}/)
  assert.match(page, /const selectQualityFilter = tier => \{[\s\S]*?\+\+bulkRequestRef\.current[\s\S]*?setBulkLoading\(null\)[\s\S]*?setFilter\(tier\)/,
    'changing quality tier cancels stale in-progress bulk requests')
  assert.match(page, /line-clamp-2/,
    'allow the category descriptions to use two lines instead of clipping')
})

test('Quality page offers lossless replacement only for eligible tracks', () => {
  const page = readFileSync(new URL('../src/pages/Quality.jsx', import.meta.url), 'utf8')
  assert.match(page, /\{canGetLossless\(track\) && \(/)
  assert.equal(frontend.canGetLossless({ id: 9, file_path: '/music/joc.ec3', atmos_verified: 1, lossless: 0 }), false)
})

test('duplicate matching treats stereo and verified Atmos as distinct library editions', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE tracks (
      id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
      duration REAL, file_path TEXT, atmos_verified INTEGER, codec TEXT
    )`)
    const insert = db.prepare('INSERT INTO tracks (id, title, artist, album, duration, file_path, atmos_verified) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('stereo', 'To You', 'Muttonheads', 'Album', 203,
      '/music/stereo.flac', 0)
    const wanted = { title: 'To You', artist: 'Muttonheads', album: 'Album', duration: 203 }
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, atmosVerified: 1 }), undefined,
      'the existing stereo file must not suppress the first Atmos edition')
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, atmosVerified: 0 })?.id, 'stereo')
    assert.equal(findAudioEditionDuplicate(db, wanted)?.id, 'stereo',
      'unverified or unknown profiles remain ordinary audio')
    insert.run('atmos', 'To You', 'Muttonheads', 'Album', 203,
      '/music/joc.atmos.m4a', 1)
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, atmosVerified: 1 })?.id, 'atmos')
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, codec: 'AC-4' }), undefined,
      'neither stereo nor JOC may satisfy an AC-4 download')
    db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'ac4', 'To You', 'Muttonheads', 'Album', 203, '/music/song.ac4.mp4', null, 'AC-4')
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, codec: 'ac4' })?.id, 'ac4')
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, codec: 'FLAC' })?.id, 'stereo')
    const measured = backend.qualityFields({ format: {
      container: 'M4A', trackInfo: [{ codecName: '<ac-4>' }],
    } })
    assert.equal(measured.codec, 'AC-4')
    assert.equal(measured.atmos_verified, null)
    assert.notEqual(frontend.tierOf(measured), 'atmos')
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, atmosVerified: 0 })?.id, 'stereo')
    insert.run('ghost', 'To You', 'Muttonheads', 'Album', 203,
      'ghost://addon/123/song', 1)
    assert.equal(findAudioEditionDuplicate(db, { ...wanted, atmosVerified: 1 })?.id, 'atmos')
  } finally {
    db.close()
  }
})
