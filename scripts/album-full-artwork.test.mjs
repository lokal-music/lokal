import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const api = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8')
const albums = readFileSync(new URL('../src/pages/Albums.jsx', import.meta.url), 'utf8')
const scanner = readFileSync(new URL('../electron/ipc/scanner.js', import.meta.url), 'utf8')

test('pre-existing library album rows retain a trusted artwork track id', () => {
  assert.match(scanner, /artwork_track_id:\s*artworkTrackId/)
  assert.match(api, /albumFullArtURL:\s*\(album\)\s*=>\s*album\?\.artwork_track_id/)
  assert.match(api, /api\.fullArtworkURL\(album\.artwork_track_id\)/)
})

test('album cards and hero load originals over existing thumbnails with fallback', () => {
  assert.match(albums, /function getAlbumFullArtwork\(album\)/)
  assert.match(albums, /const fullArtSrc = getAlbumFullArtwork\(album\)/)
  assert.match(albums, /<FadeImg src=\{artSrc\}/, 'old thumbnail stays visible initially')
  assert.match(albums, /<FadeImg src=\{fullArtSrc\}/, 'lazy full art upgrades the album card')
  assert.match(albums, /<ImageZoom src=\{fullArtSrc\}/, 'zoom uses the original image')
  assert.match(albums, /fullArtSrc !== artSrc/, 'original load is conditional')
})
