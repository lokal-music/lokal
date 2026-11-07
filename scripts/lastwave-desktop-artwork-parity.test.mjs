import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { choosePlayerArtwork } from '../src/playerArtworkResolution.mjs'

const require = createRequire(import.meta.url)
const { createArtworkResolver } = require('../electron/discoveryArtwork.js')
const {
  titleKey, artworkMatchConfidence,
} = require('../electron/discoveryArtworkMatch.js')

const image = id => 'https://covers.example.test/' + id + '.jpg'
const respond = value => ({ ok: true, json: async () => value })

test('LastWave uses Mobile-style harmless remaster and featured-credit matching', async () => {
  const resolver = createArtworkResolver({
    fetchImpl: async url => respond(url.includes('deezer.com')
      ? { data: [
        { title: 'Pump It (Live)', artist: { name: 'The Black Eyed Peas' }, album: { cover_xl: image('wrong-live') } },
        { title: 'Pump It', artist: { name: 'The Black Eyed Peas' }, album: { cover_xl: image('correct') } },
      ] } : { results: [] }),
  })
  const [result] = await resolver([{
    type: 'track',
    title: 'Pump It (2011 Remastered) [Explicit]',
    artist: 'The Black Eyed Peas feat. Fergie',
  }])
  assert.equal(result.image, image('correct'))
  assert.equal(titleKey('Pump It (2011 Remastered) [Explicit]'), titleKey('Pump It'))
  assert.equal(artworkMatchConfidence('Pump It (Live)', 'Artist', 'Pump It', 'Artist'), 0)
  assert.equal(artworkMatchConfidence('Pump It', 'Artist', 'Pump It', 'Wrong artist'), 0)
})

test('desktop retries a dead Deezer and US cover through the GB iTunes storefront', async () => {
  const calls = []
  const resolver = createArtworkResolver({
    fetchImpl: async url => {
      calls.push(url)
      if (url.includes('deezer.com')) return respond({ data: [{
        title: 'Different Song', artist: { name: 'Artist' }, album: { cover_xl: image('wrong-title') },
      }] })
      if (url.includes('country=gb')) return respond({ results: [{
        trackName: 'The Song', artistName: 'Artist', artworkUrl100: image('uk-100x100bb'),
      }] })
      return respond({ results: [{
        trackName: 'The Song', artistName: 'Artist', artworkUrl100: image('us-100x100bb'),
      }] })
    },
  })
  const [result] = await resolver([{
    type: 'track', title: 'The Song', artist: 'Artist',
    exclude: image('us-600x600bb'),
    excludes: [image('us-600x600bb')],
    remoteOnly: true,
  }])
  assert.equal(result.image, image('uk-600x600bb'))
  assert(calls.some(url => url.includes('country=gb')))
})

test('exclusions allow a later Deezer candidate without repeating a dead cover', async () => {
  const resolver = createArtworkResolver({
    fetchImpl: async url => respond(url.includes('deezer.com') ? { data: [
      { title: 'Track', artist: { name: 'Artist' }, album: { cover_xl: image('dead') } },
      { title: 'Track', artist: { name: 'Artist' }, album: { cover_xl: image('working') } },
    ] } : { results: [] }),
  })
  assert.deepEqual(await resolver([{
    title: 'Track', artist: 'Artist', remoteOnly: true,
    exclude: image('dead'), excludes: [image('dead')],
  }]), [{ image: image('working') }])
})

test('YouTube Music remains a verified fallback, never an unrelated first result', async () => {
  let searched = 0
  const resolver = createArtworkResolver({
    fetchImpl: async url => respond(url.includes('deezer.com') ? { data: [] } : { results: [] }),
    searchSongs: async () => {
      searched++
      return [
        { title: 'Track', artists: ['Wrong'], thumbnail: image('wrong') },
        { title: 'Track [Explicit]', artists: ['Artist feat. Guest'], thumbnail: image('youtube') },
      ]
    },
  })
  assert.deepEqual(await resolver([{ title: 'Track', artist: 'Artist' }]), [{ image: image('youtube') }])
  assert.equal(searched, 1)
})

test('the full player retries independent sources if the first resolves but does not decode', async () => {
  const bad = image('broken'), good = image('working')
  const requests = []
  const cover = await choosePlayerArtwork('', {
    title: 'Song', artist: 'Artist',
    resolveRemote: async request => {
      requests.push(request)
      return request.excludes.includes(bad) ? good : bad
    },
    inspect: async url => url === good ? { width: 1200, height: 1200 } : null,
  })
  assert.equal(cover, good)
  assert.deepEqual(requests.map(r => r.excludes), [[], [bad]])
})

test('Search and every player surface use multi-source recovery without replacing audio', () => {
  const discovery = readFileSync(new URL('../src/components/DiscoveryImage.jsx', import.meta.url), 'utf8')
  const player = readFileSync(new URL('../src/components/StreamArtwork.jsx', import.meta.url), 'utf8')
  assert.match(discovery, /MAX_ARTWORK_FAILURES = 4/)
  assert.match(discovery, /excludes: excluded/)
  assert.match(discovery, /onLoad=\{\(\) => \{ if \(image !== src\) onResolved\?\.\(image\) \}\}/)
  assert.match(player, /if \(track\.album\)/, 'include exact album-level recovery for LastWave')
  assert.match(player, /rememberRecoveredStreamArtwork\(track, image\)/)
})
