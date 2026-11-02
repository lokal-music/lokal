import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const remote = readFileSync(new URL('../server/routes/remote.js', import.meta.url), 'utf8')
const edit = readFileSync(new URL('../src/components/TrackEditModal.jsx', import.meta.url), 'utf8')

test('linked phone can read a track size without transferring the audio', () => {
  assert.match(remote, /router\.get\('\/library\/file-size\/:trackId'/)
  assert.match(remote, /if \(!pairedUser\(req, res\)\) return/)
  assert.match(remote, /promises\.stat\(track\.file_path\)/)
  assert.match(remote, /bytes: stat\.isFile\(\) && stat\.size > 0/)
  assert.match(remote, /Cache-Control', 'private, no-store'/)
})

test('manual catalogue import can request more than the 50-row remote view limit', () => {
  assert.match(remote, /function pagination\(req, fallback = 30, maxLimit = 50\)/)
  assert.match(remote, /pagination\(req, 50, 250\)/)
})

test('Edit Track displays read-only actual file size', () => {
  assert.match(edit, /api\.getTrackFileSize\(track\.id\)/)
  assert.match(edit, /data-testid="track-edit-file-size"/)
  assert.match(edit, /fileSizeBytes \/ 1000000/)
})
