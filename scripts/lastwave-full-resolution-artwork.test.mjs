import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { choosePlayerArtwork, PLAYER_ARTWORK_TARGET } from '../src/playerArtworkResolution.mjs'

const require = createRequire(import.meta.url)
const { createArtworkResolver } = require('../electron/discoveryArtwork.js')

test('mobile parity: compare decoded pixels, not URL sizes or HTTP success', async () => {
  const small = 'https://e-cdns-images.dzcdn.net/images/cover/hash/150x150-000000-80-0-0.jpg'
  const large = 'https://e-cdns-images.dzcdn.net/images/cover/hash/1000x1000-000000-80-0-0.jpg'
  const alternate = 'https://is1-ssl.mzstatic.com/image/thumb/other/1200x1200bb.jpg'
  const inspected = []
  const image = await choosePlayerArtwork(small, {
    title: 'Example Song', artist: 'Example Artist',
    inspect: async url => {
      inspected.push(url)
      if (url === large) return { width: 150, height: 150 } // CDN returned a tiny placeholder
      if (url === small) return { width: 150, height: 150 }
      if (url === alternate) return { width: 1200, height: 1200 }
      return null
    },
    resolveRemote: async request => {
      assert.equal(request.type, 'track')
      assert.equal(request.remoteOnly, true)
      assert.equal(request.exclude, small)
      return alternate
    },
  })
  assert.equal(PLAYER_ARTWORK_TARGET, 1000)
  assert.deepEqual(inspected, [large, small, alternate])
  assert.equal(image, alternate, 'prefer the truly larger image over a nominal 1000px placeholder')
})

test('large original artwork needs no separate metadata fetch', async () => {
  const cover = 'https://is1-ssl.mzstatic.com/image/thumb/id/1200x1200bb.jpg'
  let called = 0
  assert.equal(await choosePlayerArtwork(cover, {
    title: 'Example', artist: 'Artist',
    inspect: async () => ({ width: 1200, height: 1200 }),
    resolveRemote: async () => { called++; return '' },
  }), cover)
  assert.equal(called, 0)
})

test('metadata replacement must improve decoded resolution', async () => {
  const thumbnail = 'https://example.test/thumb.jpg?sig=private'
  const downgrade = 'https://other.example.test/smaller.jpg'
  const result = await choosePlayerArtwork(thumbnail, {
    title: 'Song', artist: 'Artist',
    inspect: async url => url === thumbnail ? { width: 640, height: 640 } : { width: 120, height: 120 },
    resolveRemote: async () => downgrade,
  })
  assert.equal(result, thumbnail, 'never substitute a smaller catalogue hit')
})

test('failed full-size rendition falls back to a valid original thumbnail', async () => {
  const thumb = 'https://is3-ssl.mzstatic.com/image/thumb/id/100x100bb.jpg'
  const image = await choosePlayerArtwork(thumb, {
    title: '', artist: '',
    inspect: async url => url === thumb ? { width: 100, height: 100 } : null,
  })
  assert.equal(image, thumb)
})

test('player metadata lookup bypasses local ghost thumbnail only when requested', async () => {
  const thumb = 'https://small.example/album-150.jpg'
  const full = 'https://cover.example/album-1000.jpg'
  let lookups = 0
  const getDB = () => ({
    prepare: () => ({
      get: () => ({ artwork_path: null, artwork_url: thumb }),
    }),
  })
  const fetchImpl = async url => {
    lookups++
    if (!url.startsWith('https://api.deezer.com/search')) throw Error('Unexpected metadata lookup')
    return new Response(JSON.stringify({ data: [{
      title: 'Example Song', artist: { name: 'Example Artist' },
      album: { cover_xl: full },
    }] }), { status: 200 })
  }
  const resolver = createArtworkResolver({ getDB, fetchImpl })
  const item = { type: 'track', title: 'Example Song', artist: 'Example Artist' }
  assert.deepEqual(await resolver([item]), [{ image: thumb }])
  assert.equal(lookups, 0)
  assert.deepEqual(await resolver([{ ...item, remoteOnly: true, exclude: thumb }]), [{ image: full }])
  assert.equal(lookups, 1)
})

test('fullscreen, mini-player and player bar all use the full-resolution artwork selector', () => {
  const streamArtwork = readFileSync(new URL('../src/components/StreamArtwork.jsx', import.meta.url), 'utf8')
  assert.match(streamArtwork, /resolvePlayerArtwork\(track, src/)
  assert.match(streamArtwork, /isAddonProvider\(streamRef\(track\)\?\.provider\)/)
  assert.match(streamArtwork, /rememberRecoveredStreamArtwork\(track, image\)/)
  for (const path of ['PlayerBar', 'MiniPlayer', 'FullscreenPlayer']) {
    const source = readFileSync(new URL('../src/components/' + path + '.jsx', import.meta.url), 'utf8')
    assert.match(source, /<StreamArtwork track=\{/, path + ' must use the full-res component')
  }
})
