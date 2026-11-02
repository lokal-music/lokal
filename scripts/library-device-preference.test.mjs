import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { listTracks } = require('../electron/trackErrors')
const { desktopPreferredLibraryClause, shouldPreferDesktop } =
  require('../electron/libraryDevicePreference')

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, album_artist TEXT,
    duration REAL, download_source TEXT, file_path TEXT
  )`)
  const add = db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  function insert(id, title, artist, album, duration, source, albumArtist = null) {
    add.run(id, title, artist, album, albumArtist, duration, source,
      '/library/' + id + '.flac')
  }
  return { db, insert }
}

function visible(db, opts = {}) {
  const where = ["file_path NOT LIKE 'ghost://%'"]
  const params = []
  if (opts.source === 'mobile') {
    where.push('download_source = ?')
    params.push('mobile')
  }
  const rows = listTracks(db, { source: opts.source || 'all', limit: 100,
    sort: 'id ASC' }, { where, params, exists: () => true })
  return rows.map(track => track.id)
}

test('desktop version replaces equivalent synced phone upload in All sources', () => {
  const { db, insert } = fixture()
  insert('desktop', 'Sun Is Rising', 'Ships of the Pharaohs', 'Album', 243, null)
  insert('mobile', 'Sun Is Rising', 'Ships of the Pharaohs, Last Nubian', 'Album', 242, 'mobile')
  insert('mobile-only', 'Phone recording', 'Solo', 'Singles', 200, 'mobile')
  assert.deepEqual(visible(db), ['desktop', 'mobile-only'])
  // Explicit source filters remain available for inspecting synced uploads.
  assert.deepEqual(visible(db, { source: 'mobile' }), ['mobile', 'mobile-only'])
  db.close()
})

test('album artist wins for multi-artist credits when matching phone copies', () => {
  const { db, insert } = fixture()
  insert('desktop', 'All the Stars', 'Kendrick Lamar, SZA', 'Black Panther', 232, null, 'SZA')
  insert('mobile', 'All the Stars', 'SZA', 'Black Panther', 232, 'mobile', 'SZA')
  assert.deepEqual(visible(db), ['desktop'])
  assert.deepEqual(visible(db, { source: 'mobile' }), ['mobile'])
  db.close()
})

test('desktop-owned downloads also supersede synced phone copies', () => {
  const { db, insert } = fixture()
  insert('desktop-downloaded', 'Track', 'Artist', 'Release', 210, 'yt')
  insert('phone-upload', 'Track', 'Artist', 'Release', 210, 'mobile')
  assert.deepEqual(visible(db), ['desktop-downloaded'])
  assert.deepEqual(visible(db, { source: 'mobile' }), ['phone-upload'])
  db.close()
})

test('different duration, album or artist do not hide distinct recordings', () => {
  const { db, insert } = fixture()
  insert('pc', 'Song', 'Artist', 'Album', 180, null)
  insert('different-duration', 'Song', 'Artist', 'Album', 189, 'mobile')
  insert('different-album', 'Song', 'Artist', 'Other Album', 180, 'mobile')
  insert('different-artist', 'Song', 'Other Band', 'Album', 180, 'mobile')
  insert('remix', 'Song (Remix)', 'Artist', 'Album', 180, 'mobile')
  assert.deepEqual(visible(db),
    ['different-album', 'different-artist', 'different-duration', 'pc', 'remix'])
  db.close()
})

test('blank album tags and unknown duration do not cause false duplicates', () => {
  const { db, insert } = fixture()
  insert('pc', 'Known Recording', 'Artist', '', 180, null)
  insert('mobile', 'Known Recording', 'Artist', 'Album', 180, 'mobile')
  insert('pc-no-duration', 'Other Song', 'Artist', 'Album', 0, null)
  insert('mobile-unknown', 'Other Song', 'Artist', 'Album', 0, 'mobile')
  assert.deepEqual(visible(db), ['mobile-unknown', 'pc', 'pc-no-duration'])
  db.close()
})

test('preference skips explicit record and diagnostic lookups', () => {
  assert.equal(shouldPreferDesktop({ source: 'mobile' }), false)
  assert.equal(shouldPreferDesktop({ source: 'all', id: 'single' }), false)
  assert.equal(shouldPreferDesktop({ problems: 'true' }), false)
  assert.equal(shouldPreferDesktop({ includeGhosts: true }), false)
  assert.equal(shouldPreferDesktop({ source: 'all' }), true)
  assert.match(desktopPreferredLibraryClause(), /NOT \(COALESCE\(tracks\.download_source/)
})

test('SZA/Kendrick collaboration is owned by the credited main album artist', () => {
  const { db, insert } = fixture()
  insert('pc', 'All the Stars', 'Kendrick Lamar, SZA', 'Black Panther',
    236, null, 'SZA')
  insert('phone', 'All the Stars', 'SZA', 'Black Panther', 236,
    'mobile', 'SZA')
  assert.deepEqual(visible(db), ['pc'])
  assert.deepEqual(visible(db, { source: 'mobile' }), ['phone'])
  db.close()
})

test('same title and duration from different album owners remain separate', () => {
  const { db, insert } = fixture()
  insert('pc', 'Overture', 'Guest feat. Artist', 'Soundtrack', 181, null, 'Guest')
  insert('phone', 'Overture', 'Artist', 'Soundtrack', 181, 'mobile', 'Artist')
  assert.deepEqual(visible(db), ['pc', 'phone'])
  db.close()
})

test('unrelated compilation tracks with the same title/duration remain separate', () => {
  const { db, insert } = fixture()
  insert('desktop', 'Intro', 'Singer Alpha', 'Various Hits', 72, null, 'Various Artists')
  insert('phone', 'Intro', 'Singer Beta', 'Various Hits', 72, 'mobile', 'Various Artists')
  assert.deepEqual(visible(db), ['desktop', 'phone'])
  db.close()
})

test('shared credited album owner allows differently ordered collaboration credits', () => {
  const { db, insert } = fixture()
  insert('desktop', 'Collaboration', 'First Artist, Second Artist',
    'Collaboration Album', 235, null, 'Second Artist')
  insert('phone', 'Collaboration', 'Second Artist, First Artist',
    'Collaboration Album', 235, 'mobile', 'Second Artist')
  assert.deepEqual(visible(db), ['desktop'])
  assert.deepEqual(visible(db, { source: 'mobile' }), ['phone'])
  db.close()
})

test('Mornye FLAC split ARTIST values collapse phone upload in desktop All', () => {
  // Actual file: ARTIST=SZA + ARTIST=Kendrick Lamar, ALBUMARTIST=SZA.
  // Android can surface the second value; desktop keeps the album owner.
  const { db, insert } = fixture()
  insert('desktop', '30 For 30 (with Kendrick Lamar)', 'SZA',
    'SOS Deluxe: LANA', 278.277, null, 'SZA')
  insert('phone', '30 For 30 (with Kendrick Lamar)', 'Kendrick Lamar',
    'SOS Deluxe: LANA', 278, 'mobile')
  assert.deepEqual(visible(db), ['desktop'])
  assert.deepEqual(visible(db, { source: 'mobile' }), ['phone'])
  db.close()
})

test('split-credit exception never hides different versions or unrelated artists', () => {
  const { db, insert } = fixture()
  insert('pc', '30 For 30 (with Kendrick Lamar)', 'SZA',
    'SOS Deluxe: LANA', 278.277, null, 'SZA')
  insert('remix', '30 For 30 (with Kendrick Lamar) [Remix]', 'Kendrick Lamar',
    'SOS Deluxe: LANA', 278, 'mobile')
  insert('other-album', '30 For 30 (with Kendrick Lamar)', 'Kendrick Lamar',
    'Other Album', 278, 'mobile')
  insert('other-artist', '30 For 30 (with Kendrick Lamar)', 'Other Artist',
    'SOS Deluxe: LANA', 278, 'mobile')
  insert('other-master', '30 For 30 (with Kendrick Lamar)', 'Kendrick Lamar',
    'SOS Deluxe: LANA', 289, 'mobile')
  assert.deepEqual(visible(db), [
    'other-album', 'other-artist', 'other-master', 'pc', 'remix'
  ])
  db.close()
})


test('desktop local search suppresses phone duplicate before LIMIT', () => {
  const { searchTracks } = require('../electron/librarySearch')
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT,
    album_artist TEXT, duration REAL, download_source TEXT,
    file_path TEXT, play_count INTEGER DEFAULT 0
  )`)
  const add = db.prepare(`INSERT INTO tracks (id,title,artist,album,album_artist,
    duration,download_source,file_path) VALUES (?,?,?,?,?,?,?,?)`)
  add.run('pc', '30 For 30 (with Kendrick Lamar)', 'SZA', 'SOS Deluxe: LANA',
    'SZA', 278.277, null, '/library/song.flac')
  add.run('mobile', '30 For 30 (with Kendrick Lamar)', 'Kendrick Lamar',
    'SOS Deluxe: LANA', null, 278, 'mobile', '/phone-downloads/song.flac')
  const found = searchTracks(db, '30 for 30', 1)
  assert.deepEqual(found.map(row => row.id), ['pc'])
  db.close()
})
