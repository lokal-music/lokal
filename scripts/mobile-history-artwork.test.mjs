import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { LinkStore, hash } = require('../electron/link/store')
const { trackKey } = require('../electron/link/protocol')

function setup() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE playlists (id TEXT PRIMARY KEY, uuid TEXT);
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY, file_path TEXT UNIQUE, file_hash TEXT,
      title TEXT, artist TEXT, album TEXT, album_artist TEXT, duration REAL,
      download_source TEXT, artwork_url TEXT, artwork_path TEXT
    );
    CREATE TABLE play_history (
      user_id TEXT, track_id TEXT, seconds_played INTEGER, played_at INTEGER
    );
    CREATE TABLE listening_events (
      user_id TEXT, track_id TEXT, event_type TEXT, source_type TEXT,
      source_id TEXT, seconds_played INTEGER, started_at INTEGER,
      ended_at INTEGER, created_at INTEGER
    );
  `)
  return { db, store: new LinkStore(db) }
}

const event = (name, extras = {}) => ({
  event_id: 'phoneEvent_12345',
  device_id: 'phone_12345678',
  track_key: trackKey({ artist: name, title: 'Collaboration', duration: 180 }),
  played_at: Date.now(),
  ms_played: 85000,
  source: 'phone',
  track: {
    id: 'mobile123', title: 'Collaboration', artist: name,
    album_artist: 'SZA', album: 'Soundtrack', duration: 180,
    ...extras
  }
})

test('mobile artist-credit variants match the existing album owner and never create a ghost', () => {
  const { db, store } = setup()
  try {
    db.prepare('INSERT INTO tracks(id,file_path,file_hash,title,artist,album,album_artist,duration) VALUES (?,?,?,?,?,?,?,?)')
      .run('real', '/music/collaboration.flac', 'localhash', 'Collaboration',
        'SZA feat. Kendrick Lamar', 'Soundtrack', 'SZA', 180)
    assert.equal(store.pushHistory([event('Kendrick Lamar, SZA')], 'guest', 'phone_12345678'), 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 1)
    assert.equal(db.prepare('SELECT track_id FROM play_history').get().track_id, 'real')
  } finally { db.close() }
})

test('unmatched phone play retains source and public cover without pretending audio exists', () => {
  const { db, store } = setup()
  try {
    const play = event('Unknown Singer', { artwork_url: 'https://example.org/cover.jpg' })
    assert.equal(store.pushHistory([play], 'guest', 'phone_12345678'), 1)
    const ghost = db.prepare('SELECT * FROM tracks WHERE id=?').get('link_' + hash(play.track_key))
    assert.equal(ghost.download_source, 'mobile')
    assert.equal(ghost.artwork_url, 'https://example.org/cover.jpg')
    assert.equal(ghost.file_path, 'ghost://link/' + ghost.id)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_history').get().n, 1)
    assert.equal(store.pushHistory([play], 'guest', 'phone_12345678'), 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_history').get().n, 1)
  } finally { db.close() }
})

test('signed mobile artwork links are never imported as reusable cover URLs', () => {
  const { db, store } = setup()
  try {
    const play = event('Unknown Singer', {
      artwork_url: 'https://example.org/cover.jpg?token=private'
    })
    store.pushHistory([play], 'guest', 'phone_12345678')
    assert.equal(
      db.prepare('SELECT artwork_url FROM tracks WHERE id=?').get('link_' + hash(play.track_key)).artwork_url,
      null
    )
  } finally { db.close() }
})

test('artwork endpoint requires pairing, source ownership and bounded JPEG bytes', () => {
  const source = readFileSync(new URL('../server/routes/remote.js', import.meta.url), 'utf8')
  const icon = readFileSync(new URL('../src/components/SourceIcon.jsx', import.meta.url), 'utf8')
  assert.match(source, /router\.post\('\/history\/artwork'/)
  assert.match(source, /const userId = pairedUser\(req, res\)/)
  assert.match(source, /WHERE user_id=\? AND device_id=\? AND track_key=\?/)
  assert.match(source, /bytes\.length < 20 \|\| bytes\.length > 180000/)
  assert.match(source, /file_path LIKE 'ghost:\/\/link\/%'/)
  assert.match(icon, /Played on Lokal Mobile · audio not stored on this PC/)
})
