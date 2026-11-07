import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  choosePlayerArtwork, isAmazonMusicAddonLabel, resolvePlayerArtwork,
} from '../src/playerArtworkResolution.mjs'

test('Amazon source labels are matched without affecting unrelated addons', () => {
  for (const source of ['Amazon', 'Amazon Music', 'Amazon (New)', 'amazon-new', 'AMAZON [Mornye]']) {
    assert.equal(isAmazonMusicAddonLabel(source), true, source)
  }
  for (const source of ['', 'Tidal', 'LastWave', 'Amazonian Folk']) {
    assert.equal(isAmazonMusicAddonLabel(source), false, source)
  }
})

test('Amazon always checks the independent catalogue FIRST, even when addon artwork is 1500px', async () => {
  const addon = 'https://m.media-amazon.com/images/I/track._SL1500_.jpg'
  const independent = 'https://is2-ssl.mzstatic.com/image/thumb/album/1200x1200bb.jpg'
  const inspected = [], requested = []
  const result = await choosePlayerArtwork(addon, {
    title: 'Song', artist: 'Artist', preferIndependent: true,
    inspect: async url => {
      inspected.push(url)
      return { width: 1200, height: 1200 }
    },
    resolveRemote: async request => { requested.push(request); return independent },
  })
  assert.equal(result, independent)
  assert.deepEqual(inspected, [independent], 'do not choose addon on URL size alone')
  assert.deepEqual(requested, [{
    type: 'track', title: 'Song', artist: 'Artist', exclude: addon, excludes: [addon], remoteOnly: true,
  }])
})

test('Amazon keeps its addon cover if the independent catalogue is unavailable', async () => {
  const addon = 'https://m.media-amazon.com/images/I/hash._SX120_.jpg'
  const result = await choosePlayerArtwork(addon, {
    title: 'Song', artist: 'Artist', preferIndependent: true,
    inspect: async () => ({ width: 600, height: 600 }),
    resolveRemote: async () => '',
  })
  assert.equal(result, 'https://m.media-amazon.com/images/I/hash.jpg')
})

test('A tiny independent placeholder is rejected before falling back to Amazon', async () => {
  const addon = 'https://amazon.example/cover.jpg'
  const remote = 'https://itunes.example/cover.jpg'
  const seen = []
  const result = await choosePlayerArtwork(addon, {
    title: 'Song', artist: 'Artist', preferIndependent: true,
    resolveRemote: async () => remote,
    inspect: async url => {
      seen.push(url)
      return url === remote ? { width: 120, height: 120 } : { width: 500, height: 500 }
    },
  })
  assert.deepEqual(seen, [remote, addon])
  assert.equal(result, addon)
})

test('Promoting an independent cover does not trigger a second lookup that excludes it', async () => {
  const track = {
    id: 'amazon-regression-immutable-identity',
    file_path: 'ghost://addon/0123456789/hash',
    title: 'Amazon Song', artist: 'Artist',
  }
  const source = 'https://source.example/thumbnail.jpg'
  const independent = 'https://catalogue.example/large.jpg'
  let count = 0
  const lookup = async () => { count++; return independent }
  const oldImage = globalThis.Image
  globalThis.Image = class {
    set src(value) {
      this.naturalWidth = 1200
      this.naturalHeight = 1200
      queueMicrotask(() => this.onload?.())
    }
  }
  try {
    const first = await resolvePlayerArtwork(track, source, lookup, { preferIndependent: true })
    assert.equal(first, independent)
    const afterPromotion = await resolvePlayerArtwork(track, independent, lookup, { preferIndependent: true })
    assert.equal(afterPromotion, independent)
    assert.equal(count, 1, 'an independently recovered cover must not be excluded and replaced again')
  } finally {
    if (oldImage === undefined) delete globalThis.Image
    else globalThis.Image = oldImage
  }
})

test('Amazon full player resolves source names and sets the independent-first policy', () => {
  const stream = readFileSync(new URL('../src/components/StreamArtwork.jsx', import.meta.url), 'utf8')
  const full = readFileSync(new URL('../src/components/FullscreenPlayer.jsx', import.meta.url), 'utf8')
  assert.match(stream, /loadAddonNames\(\)/)
  assert.match(stream, /isAmazonMusicAddonLabel\(names\?\.\[ref\.provider\]\)/)
  assert.match(stream, /resolvePlayerArtwork\(track, src/)
  assert.match(stream, /\{ preferIndependent \}/)
  assert.match(full, /<StreamArtwork track=\{track\} src=\{full\}/)
})
