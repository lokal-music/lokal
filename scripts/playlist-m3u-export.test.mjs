import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildM3u } = require('../electron/playlists/exportM3u.js')
const win = path.win32
const make = (tracks, output, roots = [], fileExists = () => true) =>
  buildM3u(tracks, output, { pathApi: win, roots, fileExists })
const entries = result => result.content.split('\r\n').filter(line => line && !line.startsWith('#'))

test('M3U8 uses UTF-8-friendly names and forward-slash paths relative to playlist directory', () => {
  const result = make([
    { file_path: 'D:\\Music\\Björk\\Vespertine\\01 - Hidden Place.flac' },
    { file_path: 'D:\\Music\\Daft Punk\\Discovery\\One More Time.flac' },
    { file_path: 'D:\\Music\\Björk\\Vespertine\\01 - Hidden Place.flac' },
  ], 'D:\\Music\\My Mix.m3u8', ['D:\\Music'])
  assert.deepEqual(entries(result), [
    'Björk/Vespertine/01 - Hidden Place.flac',
    'Daft Punk/Discovery/One More Time.flac',
    'Björk/Vespertine/01 - Hidden Place.flac',
  ])
  assert.equal(result.exported, 3)
  assert.equal(result.skipped, 0)
  assert.ok(result.content.startsWith('#EXTM3U\r\n'))
  assert.ok(result.content.endsWith('\r\n'))
  assert.equal(result.content.includes('D:\\'), false)
})

test('export to an SD card maps tracks from other drive to portable music root', () => {
  const result = make([
    { file_path: 'C:\\Users\\Alice\\Music\\Daft Punk\\Discovery\\01 - One More Time.flac' },
  ], 'E:\\My Playlist.m3u8', ['C:\\Users\\Alice\\Music'])
  assert.deepEqual(entries(result), ['Music/Daft Punk/Discovery/01 - One More Time.flac'])
  assert.deepEqual(result.portableRoots, ['Music'])
  assert.equal(result.externalRelative, 0)
})

test('files under output directory take precedence over configured root mapping', () => {
  const result = make([
    { file_path: 'E:\\SD\\Music\\Artist\\track.mp3' },
  ], 'E:\\SD\\mix.m3u', ['E:\\SD\\Music'])
  assert.deepEqual(entries(result), ['Music/Artist/track.mp3'])
  assert.deepEqual(result.portableRoots, [])
})

test('skip stream URLs, ghosts, missing files, and cross-volume tracks with no configured root', () => {
  const result = make([
    { file_path: 'ghost://tidal/track' },
    { file_path: 'https://music.example/song.flac' },
    { file_path: 'C:\\Music\\missing.flac' },
    { file_path: 'D:\\Other\\track.flac' },
  ], 'C:\\Music\\export.m3u8', [], value => !value.includes('missing'))
  assert.deepEqual(entries(result), [])
  assert.equal(result.skippedUnusable, 2)
  assert.equal(result.skippedMissing, 1)
  assert.equal(result.skippedCrossVolume, 1)
  assert.equal(result.skipped, 4)
})

test('unconfigured same-drive parent references remain relative and are counted', () => {
  const result = make(['C:\\Music\\Album\\file.wav'], 'C:\\Playlists\\mix.m3u8')
  assert.deepEqual(entries(result), ['../Music/Album/file.wav'])
  assert.equal(result.externalRelative, 1)
})

test('different music folders sharing a name do not collide when mapped to portable root', () => {
  const result = make([
    'C:\\Music\\A\\song.flac',
    'D:\\Music\\B\\song.flac',
  ], 'E:\\mix.m3u8', ['C:\\Music', 'D:\\Music'])
  assert.deepEqual(entries(result), ['Music/A/song.flac', 'Music-2/B/song.flac'])
  assert.deepEqual(result.portableRoots, ['Music', 'Music-2'])
})

test('M3U treats an entry starting with a hash as a path instead of comment', () => {
  const result = make(['C:\\Music\\#song.flac'], 'C:\\Music\\mix.m3u')
  assert.deepEqual(entries(result), ['./#song.flac'])
})

test('invalid destination is rejected and multiline filenames do not inject entries', () => {
  assert.throws(() => make(['C:\\Music\\a.flac'], 'mix.m3u'), /absolute/)
  const result = buildM3u(['C:\\Music\\hi\nbad.flac'], 'C:\\Music\\mix.m3u', {
    pathApi: win, fileExists: () => true,
  })
  assert.equal(result.exported, 0)
  assert.equal(result.skippedUnusable, 1)
})
