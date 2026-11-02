import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { searchTracks } = require('../electron/librarySearch')

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
    album_artist TEXT, duration REAL, download_source TEXT,
    file_path TEXT, play_count INTEGER DEFAULT 0
  )`)
  const insert = db.prepare(`INSERT INTO tracks
    (id, title, artist, album, album_artist, duration, download_source, file_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  return { db, insert }
}

test('desktop local search never includes an imported phone song, even with mismatched tags', () => {
  const { db, insert } = fixture()
  insert.run('desktop', '30 For 30 (with Kendrick Lamar)', 'SZA', 'SOS Deluxe: LANA',
    'SZA', 278, null, '/music/sza.flac')
  insert.run('mobile', 'SZA - 30 For 30 (with Kendrick Lamar)', 'Unknown Artist',
    'Unknown Album', 'Unknown Artist', 278, 'mobile', '/phone-downloads/sza.flac')
  assert.deepEqual(searchTracks(db, '30 for 30').map(x => x.id), ['desktop'])
  db.close()
})

test('mobile-only uploads do not leak into desktop search while own downloads remain', () => {
  const { db, insert } = fixture()
  insert.run('phone', 'Phone recording', 'Singer', 'Release',
    null, 210, 'mobile', '/phone-downloads/song.flac')
  insert.run('owned-download', 'Owned recording', 'Singer', 'Release',
    null, 210, 'yt', '/music/download.flac')
  assert.deepEqual(searchTracks(db, 'recording').map(x => x.id), ['owned-download'])
  db.close()
})
