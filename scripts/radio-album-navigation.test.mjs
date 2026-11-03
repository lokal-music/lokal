import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { navigateToRadioAlbum, radioAlbumFromLastfm } = await import('../src/radio/stationAlbum.js')

const station = (patch = {}) => ({
  id: 'station-1',
  song_key: 'station-1:artist:title',
  artist: 'The Artist',
  title: 'Real Song',
  album: 'My Radio Station', // NOT the album — radio's placeholder
  station: { title: 'My Radio Station' },
  ...patch,
})
const navSpy = () => {
  const calls = []
  const nav = (path, options) => calls.push({ path, options })
  return { nav, calls }
}

test('radio title opens the verified release, not the station or artist page', async () => {
  const { nav, calls } = navSpy()
  const ok = await navigateToRadioAlbum(nav, station(), {
    resolve: async () => ({ id: 'yt:abc', title: 'Real Song', artist: 'The Artist' }),
    client: {
      lastfmGetTrackInfo: async () => ({
        track: { name: 'Real Song', artist: { name: 'The Artist' },
          album: { title: 'Actual Album' } },
      }),
    },
  })
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path.split('?')[0], '/online/album')
  const params = new URLSearchParams(calls[0].path.split('?')[1])
  assert.equal(params.get('album'), 'Actual Album')
  assert.equal(params.get('artist'), 'The Artist')
  assert.notEqual(params.get('album'), 'My Radio Station')
  assert.equal(calls[0].options.state.highlightTitle, 'Real Song')
})

test('exact matched online track with release metadata opens its album', async () => {
  const { nav, calls } = navSpy()
  const ok = await navigateToRadioAlbum(nav, station(), {
    resolve: async () => ({
      id: 'yt:xyz',
      title: 'Real Song', artist: 'The Artist',
      album: 'Matched Release', provider: 'yt',
    }),
    client: { lastfmGetTrackInfo: async () => { throw Error('Should not fetch Last.fm') } },
  })
  assert.equal(ok, true)
  assert.equal(calls[0].path.split('?')[0], '/online/album')
  assert.equal(new URLSearchParams(calls[0].path.split('?')[1]).get('album'), 'Matched Release')
})

test('wrong artist, wrong track and station placeholder cannot choose album', async () => {
  const { nav, calls } = navSpy()
  let callsToLookup = 0
  const ok = await navigateToRadioAlbum(nav, station(), {
    resolve: async () => ({ title: 'Real Song', artist: 'Another Artist',
      album: 'Wrong Album' }),
    client: { lastfmGetTrackInfo: async () => {
      callsToLookup++
      return { track: { name: 'Real Song', artist: { name: 'Wrong Artist' },
        album: { title: 'Wrong Album' } } }
    } },
  })
  assert.equal(ok, false)
  assert.equal(callsToLookup, 1)
  assert.equal(calls.length, 0)
  assert.equal(radioAlbumFromLastfm({
    track: { name: 'Different Song', artist: { name: 'The Artist' },
      album: { title: 'Wrong Album' } },
  }, station()), null)
})

test('station-provided verified album can open without Last.fm', async () => {
  const { nav, calls } = navSpy()
  const ok = await navigateToRadioAlbum(nav,
    station({ album: 'Broadcast Album' }), {
      resolve: async () => null,
      client: { lastfmGetTrackInfo: async () => { throw Error('not needed') } },
    })
  assert.equal(ok, true)
  assert.equal(new URLSearchParams(calls[0].path.split('?')[1]).get('album'), 'Broadcast Album')
})

test('unknown album does not navigate to artist or an empty album', async () => {
  const { nav, calls } = navSpy()
  assert.equal(await navigateToRadioAlbum(nav, station(), {
    resolve: async () => ({ id: 'yt:abc', title: 'Real Song', artist: 'The Artist',
      album: 'My Radio Station' }),
    client: { lastfmGetTrackInfo: async () => { throw Error('offline') } },
  }), false)
  assert.deepEqual(calls, [])
  assert.equal(await navigateToRadioAlbum(nav, station({ song_key: null }),
    { resolve: async () => null, client: {} }), false)
  assert.deepEqual(calls, [])
})
