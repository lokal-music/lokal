import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')
const { searchTracks, searchArtists, wordsMatch, searchWords } = require('../electron/librarySearch.js')

function library() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, album_artist TEXT, file_path TEXT, play_count INTEGER, download_source TEXT DEFAULT NULL);
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE artist_track_links (artist_id TEXT, track_id TEXT);`)
  const add = db.prepare('INSERT INTO tracks (id, title, artist, album, album_artist, file_path, play_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
  add.run('t1', 'Fame Is for Fools', 'Hallex M', 'Fame Is for Fools', 'Hallex M', '/m/fame.flac', 3)
  add.run('t2', 'Fools Gold', 'Stone Roses', 'Stone Roses', null, '/m/gold.flac', 9)
  add.run('t3', 'Is This Fame', 'Other Band', 'Fame Is for Fools Covers', null, '/m/cover.mp3', 1)
  add.run('t4', 'Fame Is for Fools', 'Hallex M', 'Fame Is for Fools', null, 'ghost://youtube/online/abcdefghijk', 0)
  add.run('t5', '100% Pure', 'Pure Act', 'Percent', null, '/m/pure.mp3', 0)
  add.run('t6', '1000 Pure', 'Pure Act', 'Percent', null, '/m/pure2.mp3', 0)
  db.exec(`INSERT INTO artists VALUES ('a1', 'Hallex M'), ('a2', 'Stone Roses'), ('a3', 'Other Band');
    INSERT INTO artist_track_links VALUES ('a1', 't1'), ('a2', 't2'), ('a3', 't3');`)
  return db
}

const ids = rows => rows.map(row => row.id)

test('words can come from the title and the artist, in any order', () => {
  const db = library()
  assert.deepEqual(ids(searchTracks(db, 'fame is for fools hallex')), ['t1'])
  assert.deepEqual(ids(searchTracks(db, 'hallex fools')), ['t1'])
  assert.deepEqual(ids(searchTracks(db, 'HALLEX   Fame')), ['t1'])
})

test('words can come from the album, and every word must be found', () => {
  const db = library()
  assert.deepEqual(ids(searchTracks(db, 'covers fame')), ['t3'])
  assert.deepEqual(ids(searchTracks(db, 'fools roses')), ['t2'])
  assert.deepEqual(searchTracks(db, 'fame nonsenseword'), [])
})

test('the whole query in the title comes first, and streamed copies are not library songs', () => {
  const db = library()
  // t3 has every word (title + album) but t1 has the phrase in its title.
  assert.deepEqual(ids(searchTracks(db, 'fame is for fools')), ['t1', 't3'])
})

test('% and _ are searched as text, not wildcards', () => {
  const db = library()
  assert.deepEqual(ids(searchTracks(db, '100%')), ['t5'])
  assert.deepEqual(searchTracks(db, '   '), [])
  assert.equal(wordsMatch('', ['title']), null)
  assert.deepEqual(searchWords('a  A b'), ['a', 'b'])
})

test('the artist of a found song shows when their name is one of the words', () => {
  const db = library()
  const tracks = searchTracks(db, 'fame is for fools hallex')
  assert.deepEqual(searchArtists(db, 'fame is for fools hallex', tracks).map(a => a.name), ['Hallex M'])
  // Short words alone ("is", "for") don't bring artists in.
  assert.deepEqual(searchArtists(db, 'fame is for fools', searchTracks(db, 'fame is for fools')).map(a => a.name), [])
  assert.deepEqual(searchArtists(db, 'stone', []).map(a => a.name), ['Stone Roses'])
})
