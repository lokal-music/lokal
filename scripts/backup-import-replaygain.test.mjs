import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const { initDB, getDB, importAppData } = require('../electron/ipc/db.js')

test('backup import works when upgrading a database without replaygain', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-backup-import-'))
  const previous = process.env.LOKAL_DATA_DIR
  process.env.LOKAL_DATA_DIR = dir
  let db
  t.after(() => {
    db?.close()
    if (previous === undefined) delete process.env.LOKAL_DATA_DIR
    else process.env.LOKAL_DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const legacyDb = new Database(path.join(dir, 'lokal.db'))
  legacyDb.exec(`
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      file_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      album_artist TEXT,
      track_num INTEGER,
      year INTEGER,
      genre TEXT,
      genres TEXT,
      record_label TEXT,
      explicit INTEGER DEFAULT 0,
      instrumental INTEGER,
      danceability REAL,
      energy REAL,
      track_key INTEGER,
      loudness REAL,
      mode INTEGER,
      speechiness REAL,
      acousticness REAL,
      instrumentalness REAL,
      liveness REAL,
      valence REAL,
      tempo REAL,
      time_signature INTEGER,
      duration REAL,
      artwork_path TEXT,
      bitrate INTEGER,
      last_modified INTEGER,
      play_count INTEGER DEFAULT 0,
      liked INTEGER DEFAULT 0,
      added_at INTEGER DEFAULT (unixepoch())
    )
  `)
  legacyDb.close()

  initDB()
  db = getDB()
  const result = importAppData({
    version: 1,
    tracks: [{
      id: 'backup-track',
      file_path: '/music/song.flac',
      file_hash: 'backup-hash',
      title: 'Song',
      artist: 'Artist',
      replaygain: '-3.5 dB',
    }],
  })

  assert.equal(result.ok, true)
  assert.equal(db.prepare('SELECT replaygain FROM tracks WHERE id = ?').get('backup-track').replaygain, '-3.5 dB')
})
