import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseVisuals, safeURL, acceptedCache, artistVisualsFor } =
  require('../electron/artwork/artistVisuals.js')

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO1P9xMAAAAASUVORK5CYII=', 'base64')
const header = {
  artistLogo: { dictionary: {
    url: 'https://is1-ssl.mzstatic.com/image/thumb/Artist/{w}x{h}bb.{f}',
    width: 2000, height: 400
  } },
  artwork: { dictionary: { url: 'https://is1-ssl.mzstatic.com/image/thumb/Artist/1200x1200.jpg' } },
  videoArtwork: { dictionary: { motionArtistSquare1x1: {
    video: 'https://video-ssl.itunes.apple.com/itunes-assets/artist-square.m3u8'
  } } }
}
const page = h => '<html><script id="serialized-server-data">' +
  JSON.stringify({ data: [{ page: { attributes: h } }] }) + '</script></html>'

test('Apple artist editorial JSON extracts the original transparent logo and square video', () => {
  const result = parseVisuals(page(header))
  assert.ok(result)
  assert.match(result.logoURL, /1000x200bb\.png/)
  assert.equal(result.logoAspect, 5)
  assert.match(result.motionURL, /artist-square\.m3u8/)
})

test('malformed JSON and untrusted artist URLs safely fall back', () => {
  assert.equal(parseVisuals('<script id="serialized-server-data">{bad</script>'), null)
  assert.equal(parseVisuals(page({ ...header, artistLogo: null, videoArtwork: null })), null)
  assert.equal(safeURL('http://music.apple.com/us/artist/a/1'), null)
  assert.equal(safeURL('https://evil.example/hello.png', 'logo'), null)
  assert.equal(safeURL('https://localhost/private.m3u8', 'video'), null)
})

test('a cached namesake requires matching catalogue proof', () => {
  const stored = { name: 'Test Artist', proof: ['known song'], logoFile: '/cached.png' }
  assert.equal(acceptedCache(stored, 'Test Artist', new Set(['known song'])), true)
  assert.equal(acceptedCache(stored, 'Test Artist', new Set(['unrelated song'])), false)
  assert.equal(acceptedCache(stored, 'Other Artist', new Set(['known song'])), false)
})

test('verified logo persists and is reused without refetch; namesakes never get it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-artist-visuals-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let requests = 0
  const fetchImpl = async url => {
    requests++
    const href = String(url)
    if (href.includes('/search?')) return new Response(JSON.stringify({
      results: [{ artistId: 1234, artistName: 'Test Artist' }]
    }), { status: 200 })
    if (href.includes('/lookup?')) return new Response(JSON.stringify({
      results: [{ wrapperType: 'track', trackName: 'Known Song', collectionName: 'Album X' }]
    }), { status: 200 })
    if (href.includes('/artist/-/')) return new Response(page(header), { status: 200 })
    if (href.includes('mzstatic.com')) return new Response(png, { status: 200 })
    throw Error('Unexpected request ' + href)
  }
  const args = { directory, fetchImpl }
  const found = await artistVisualsFor('test-artist', 'Test Artist', ['Known Song'], args)
  assert.ok(found?.logoFile)
  assert.equal(fs.readFileSync(found.logoFile).equals(png), true)
  assert.ok(fs.existsSync(path.join(directory, 'logos')))
  const before = requests
  assert.deepEqual(await artistVisualsFor('test-artist', 'Test Artist', ['Known Song'], args), found)
  assert.equal(requests, before)
  assert.equal(await artistVisualsFor('test-artist', 'Test Artist', ['Unrelated Song'], args), null)
  assert.deepEqual(await artistVisualsFor('test-artist', 'Test Artist', ['Known Song'], args), found)
})
