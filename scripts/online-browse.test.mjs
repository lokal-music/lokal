import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isConnected, setConnected, onlineByDefault, setOnlineByDefault, libraryAlbum, loadArtistChannel, loadOnlineAlbum, loadOnlineArtistAlbums, onlineAlbumPath, trackAlbumPath } from '../src/onlineBrowse.js'
import { classifyOnlineReleases, groupReleases } from '../src/releaseTypes.js'
import { isContextNavigable, navigateToTrackAlbum } from '../src/playbackContext.js'

test('album pages are addressed by artist and album (and YouTube album id)', () => {
  const path = onlineAlbumPath({ artist: 'Earth, Wind & Fire', album: 'I Am', albumId: 'MPREiam' })
  const params = new URLSearchParams(path.split('?')[1])
  assert.equal(path.split('?')[0], '/online/album')
  assert.deepEqual([params.get('artist'), params.get('album'), params.get('albumId')], ['Earth, Wind & Fire', 'I Am', 'MPREiam'])
  assert.equal(new URLSearchParams(onlineAlbumPath({ artist: 'A', album: 'B', albumId: 'javascript:x' }).split('?')[1]).get('albumId'), null)
})

test('a streamed add-on track uses its persisted source album id', () => {
  const path = trackAlbumPath({
    file_path: 'ghost://addon/0123456789/track-123',
    title: 'Song',
    artist: 'Artist',
    album: 'Amazon Album',
    source_album_id: 'B012345678',
  })
  const params = new URLSearchParams(path.split('?')[1])
  assert.equal(params.get('source'), 'a-0123456789')
  assert.equal(params.get('sourceAlbum'), 'B012345678')
  assert.equal(params.get('album'), 'Amazon Album')
})

test('the player album shortcut forwards a streamed add-on album id', () => {
  const calls = []
  const track = {
    file_path: 'ghost://addon/0123456789/track-123',
    title: 'Song',
    artist: 'Artist',
    album: 'Amazon Album',
    source_album_id: 'B012345678',
  }
  assert.equal(navigateToTrackAlbum((...args) => calls.push(args), track), true)
  const [path, options] = calls[0]
  const params = new URLSearchParams(path.split('?')[1])
  assert.equal(params.get('source'), 'a-0123456789')
  assert.equal(params.get('sourceAlbum'), 'B012345678')
  assert.equal(options.state.anchor.title, 'Song')
})

test('an add-on track with an album id but no album name still has an album link', () => {
  const track = {
    file_path: 'ghost://addon/0123456789/track-123',
    title: 'Song',
    artist: 'Artist',
    source_album_id: 'B012345678',
  }
  const path = trackAlbumPath(track)
  const params = new URLSearchParams(path.split('?')[1])
  assert.equal(params.get('source'), 'a-0123456789')
  assert.equal(params.get('sourceAlbum'), 'B012345678')
  assert.equal(params.get('album'), '')
  let destination = null
  assert.equal(navigateToTrackAlbum((...args) => { destination = args }, track), true)
  assert.equal(destination[0], path)
})

test('an add-on track falls back to alternate album-name fields', () => {
  const path = trackAlbumPath({
    file_path: 'ghost://addon/0123456789/track-123',
    title: 'Song',
    artist: 'Artist',
    album_name: 'Album from snake case',
  })
  assert.equal(new URLSearchParams(path.split('?')[1]).get('album'), 'Album from snake case')
})

test('an album opened by source id loads and displays the add-on album title', async () => {
  let discoveryLookups = 0
  const client = {
    onlineProviders: async () => [{ id: 'a-0123456789', addon: true, album: true }],
    getSettings: async () => ({}),
    discoveryCatalogue: async () => { discoveryLookups++; return { tracks: [] } },
    addonAlbum: async (provider, id) => ({ id, title: 'Amazon Album', artist: 'Resolved Artist', tracks: [{ id: '1', title: 'Song', artist: 'Resolved Artist', provider }] }),
  }
  const result = await loadOnlineAlbum({ artist: 'Artist', album: '', provider: 'a-0123456789', sourceAlbumId: 'B012345678' }, client)
  assert.equal(result.title, 'Amazon Album')
  assert.equal(result.artist, 'Resolved Artist')
  assert.equal(result.tracks[0].title, 'Song')
  assert.equal(discoveryLookups, 0)
})

test('the library album opens instead when the library has its songs as files', async () => {
  const client = tracks => ({ getAlbumTracks: async () => tracks })
  assert.deepEqual(await libraryAlbum({ artist: 'A', album: 'B' }, client([{ file_path: '/music/b.flac' }])), { title: 'B', album_artist: 'A' })
  assert.equal(await libraryAlbum({ artist: 'A', album: 'B' }, client([{ file_path: 'ghost://addon/a-0123456789/1' }])), null)
  assert.equal(await libraryAlbum({ artist: 'A', album: 'B' }, client([])), null)
})

test("album songs fall back to the album's cover, and to the playback sources", async () => {
  const searched = []
  const client = {
    discoveryCatalogue: async () => ({ tracks: [] }),
    getSettings: async () => ({}),
    onlineProviders: async () => [{ id: 'a-0123456789', addon: true, label: 'Addon' }],
    onlineSearch: async (query, source) => { searched.push([query, source]); return { results: [
      { title: 'In the Stone', artist: 'Earth, Wind & Fire', album: 'I Am', track_num: 1 },
      { title: 'Boogie Wonderland', artist: 'Earth, Wind & Fire', album: 'The Essential Earth, Wind & Fire' },
      { title: "Can't Let Go", artist: 'Earth, Wind & Fire', album: 'I Am', track_num: 2, thumbnail: 'https://addon.example/iam.jpg' },
    ] } },
  }
  const result = await loadOnlineAlbum({ artist: 'Earth, Wind & Fire', album: 'I Am', artwork: 'https://shown.example/iam.jpg' }, client)
  assert.deepEqual(result.tracks.map(track => track.title), ['In the Stone', "Can't Let Go"])
  assert.deepEqual(result.tracks.map(track => track.artwork_url), ['https://shown.example/iam.jpg', 'https://addon.example/iam.jpg'])
  assert.ok(searched.some(([query]) => query === 'Earth, Wind & Fire I Am'))
})

test("an artist's albums: the catalogue's, then their songs' albums, once each", async () => {
  const client = { discoveryCatalogue: async ({ source }) => source === 'youtube' ? { albums: [{ title: 'I Am', artist: 'Earth, Wind & Fire', albumId: 'MPREiam' }] } : { error: 'no' } }
  const albums = await loadOnlineArtistAlbums('Earth, Wind & Fire', [
    {
      title: 'September',
      album: 'The Best of Earth, Wind & Fire, Vol. 1',
      artwork_url: 'https://x.example/best.jpg',
      album_release_type: 'Compilation',
      album_track_count: 17,
      album_is_main_artist: false,
    },
    { title: 'Boogie Wonderland', album: 'I am', artwork_url: 'https://x.example/iam.jpg' },
  ], client)
  assert.deepEqual(albums.map(album => album.title), ['I Am', 'The Best of Earth, Wind & Fire, Vol. 1'])
  assert.equal(albums[0].artwork_url, 'https://x.example/iam.jpg')
  assert.equal(albums[1].release_type, 'Compilation')
  assert.equal(albums[1].track_count, 17)
  assert.equal(albums[1].is_main_artist, false)
  assert.deepEqual(groupReleases(classifyOnlineReleases(albums)).map(group => [group.type, group.items.map(item => item.title)]), [
    ['album', ['I Am']], ['feature', ['The Best of Earth, Wind & Fire, Vol. 1']],
  ])
})

test('channel feature metadata is merged into an existing catalogue release', async () => {
  const channel = await loadArtistChannel('Artist', {}, {
    discoveryCatalogue: async () => ({
      name: 'Artist',
      tracks: [{ title: 'Guest song', artist: 'Other', album: 'Collaboration', album_is_main_artist: false }],
      albums: [{ title: 'Collaboration', artist: 'Artist', release_type: 'album' }],
    }),
  })
  assert.equal(channel.albums.length, 1)
  assert.equal(channel.albums[0].is_main_artist, false)
  assert.deepEqual(groupReleases(classifyOnlineReleases(channel.albums)).map(group => [group.type, group.items.map(item => item.title)]), [
    ['feature', ['Collaboration']],
  ])
})

test('"Playing from" leads back to an online album or artist page', () => {
  assert.equal(isContextNavigable({ type: 'discovery', name: 'I Am', path: '/online/album?artist=A&album=B' }), true)
  assert.equal(isContextNavigable({ type: 'discovery', name: 'Fresh Finds' }), false)
  assert.equal(isContextNavigable({ type: 'discovery', name: 'x', path: 'https://evil.example' }), false)
})

import { mergeWithLibrary, isConnected, releaseTitleKey } from '../src/onlineBrowse.js'

test('the full album keeps its order, with the library copies in place of the songs it has', () => {
  const lib = [
    { id: 'l1', title: 'Boogie Wonderland', artist: 'Earth, Wind & Fire', file_path: '/m/bw.flac' },
    { id: 'l2', title: 'Bonus Jam', artist: 'Earth, Wind & Fire', file_path: '/m/bonus.flac' },
    { id: 'g1', title: 'In the Stone', artist: 'Earth, Wind & Fire', file_path: 'ghost://youtube/online/abcdefghijk' },
  ]
  const online = [
    { title: 'In the Stone (Album Version)', artist: 'Earth, Wind & Fire' },
    { title: 'Boogie Wonderland (with The Emotions)(Album Version)', artist: 'Earth, Wind & Fire' },
    { title: "Can't Let Go", artist: 'Earth, Wind & Fire' },
  ]
  const merged = mergeWithLibrary(online, lib)
  assert.deepEqual(merged.tracks.map(track => track.id || track.title), ['In the Stone (Album Version)', 'l1', "Can't Let Go", 'l2'])
  assert.deepEqual(merged.missing.map(track => track.title), ['In the Stone (Album Version)', "Can't Let Go"])
  assert.equal(merged.owned, 2)
})

test('release titles compare without edition labels; nothing remembered without storage', () => {
  assert.equal(releaseTitleKey('I Am (Expanded Edition)'), releaseTitleKey('I am'))
  assert.equal(isConnected('album:x|y'), false)
})

import { libraryAlbumCounts, releaseOwnership } from '../src/onlineBrowse.js'

test('releases the library has all or part of', () => {
  const counts = libraryAlbumCounts([
    { album: 'I Am', file_path: '/m/1.flac' }, { album: 'I Am (Expanded Edition)', file_path: '/m/2.flac' },
    { album: 'Raise!', file_path: 'ghost://youtube/online/abcdefghijk' }, { album: 'Spirit', file_path: '/m/3.flac' },
  ])
  assert.deepEqual(releaseOwnership({ title: 'I Am', track_count: 9 }, counts), { owned: 2, total: 9, full: false })
  assert.deepEqual(releaseOwnership({ title: 'Spirit', track_count: 1 }, counts), { owned: 1, total: 1, full: true })
  assert.deepEqual(releaseOwnership({ title: 'Spirit' }, counts), { owned: 1, total: 0, full: false })
  // Streamed songs aren't in the library.
  assert.equal(releaseOwnership({ title: 'Raise!', track_count: 9 }, counts), null)
  assert.equal(releaseOwnership({ title: 'Gratitude' }, counts), null)
})

test('album and artist pages use the online default while respecting manual page choices', () => {
  const previousStorage = globalThis.localStorage
  const storage = new Map()
  globalThis.localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
  }
  try {
    // Fresh installs open both kinds of page online.
    assert.equal(onlineByDefault(), true)
    assert.equal(isConnected('album:artist|album'), true)
    assert.equal(isConnected('artist:123'), true)
    assert.equal(isConnected(''), false)

    setOnlineByDefault(false)
    assert.equal(onlineByDefault(), false)
    assert.equal(isConnected('album:artist|album'), false)
    assert.equal(isConnected('artist:123'), false)

    // Explicit per-page selections survive global default changes.
    setConnected('album:artist|album', true)
    assert.equal(isConnected('album:artist|album'), true)
    setOnlineByDefault(true)
    setConnected('artist:123', false)
    assert.equal(isConnected('artist:123'), false)
    assert.equal(isConnected('album:artist|album'), true)
    assert.equal(isConnected('artist:new'), true)

    // Existing saved ON selections are retained after upgrading.
    setOnlineByDefault(false)
    storage.set('lokal-online-connected', JSON.stringify(['artist:legacy']))
    assert.equal(isConnected('artist:legacy'), true)
    assert.equal(isConnected('artist:new'), false)
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})
