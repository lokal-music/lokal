import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseIcecast, parseAzuraCast, parseShoutcast, shoutcastStatusUrl, statusUrl, broadcasterApiForStation, visibleStationMetadata } = require('../electron/radio/metadata.js')

test('status lookup uses a host Icecast JSON endpoint, not an audio URL', () => {
  assert.equal(statusUrl('https://music.example.test:8443/live.mp3'),
    'https://music.example.test:8443/status-json.xsl')
  assert.equal(statusUrl('file:///var/private'), null)
})

test('parse now playing from the correct Icecast mount', () => {
  const body = { icestats: { source: [
    { listenurl: 'https://radio.example.test/other', title: 'Wrong artist - Wrong song' },
    { listenurl: 'https://radio.example.test/live', title: 'Artist - Correct song' },
  ] } }
  assert.deepEqual(parseIcecast(body, 'https://radio.example.test/live'),
    { artist: 'Artist', title: 'Correct song' })
  assert.equal(parseIcecast(body, 'https://radio.example.test/missing'), null)
})

test('station metadata reads bounded broadcaster JSON and skips private endpoints', async () => {
  let requests = 0
  const fetchImpl = async url => {
    requests++
    assert.equal(url, 'https://public.example.test/status-json.xsl')
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ icestats: { source: { title: 'A - B' } } }),
    }
  }
  const found = await visibleStationMetadata({
    id: 'rb:uuid', url: 'https://public.example.test/live',
  }, { fetchImpl })
  assert.deepEqual(found, { artist: 'A', title: 'B' })
  const internal = await visibleStationMetadata({
    id: 'rb:private', url: 'http://127.0.0.1:8000/live',
  }, { fetchImpl })
  assert.equal(internal, null)
  assert.equal(requests, 1)
})


test('Nova Danse gets the official broadcaster feed without requiring ICY metadata', async () => {
  const station = {
    id: 'rb:nova-dance-uuid',
    title: 'Nova Danse',
    url: 'https://nova-dance.ice.infomaniak.ch/nova-dance-256.aac',
  }
  const api = broadcasterApiForStation(station)
  assert.equal(api.url, 'https://www.nova.fr/radios-data/www.nova.fr/all.json')
  assert.equal(api.match, 'radio.code=nova-danse')
  assert.equal(broadcasterApiForStation({ ...station, url: 'https://other-radio.example/live' }), null)
  const mockFetch = async url => {
    assert.equal(url, api.url)
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => [
        { radio: { code: 'radio-nova' }, currentTrack: { artist: 'Wrong', title: 'Song' } },
        { radio: { code: 'nova-danse' }, currentTrack: {
          artist: 'Dance Artist', title: 'Dance Track',
          image: 'https://www.nova.fr/media/dance-cover.jpg', duration: 215,
        } },
      ],
    }
  }
  const track = await visibleStationMetadata(station, { fetchImpl: mockFetch })
  assert.deepEqual(track, { artist: 'Dance Artist', title: 'Dance Track',
    cover: 'https://www.nova.fr/media/dance-cover.jpg', duration: 215 })
})


test('AzuraCast only assigns a current song to its matching stream or mount', () => {
  const feed = [
    { station: {listen_url:'https://stream.example.com/other'},
      now_playing:{ song:{artist:'Wrong',title:'Not this station',art:'https://example.com/wrong.jpg'}} },
    { station: {listen_url:'https://stream.example.com/main',
        mounts:[{url:'https://stream.example.com/live-256.mp3'}]},
      now_playing:{song:{artist:'Right Artist',title:'Right Track',
        art:'https://example.com/right.jpg'}} },
  ]
  const match = parseAzuraCast(feed,'https://stream.example.com/live-256.mp3')
  assert.deepEqual(match, {artist:'Right Artist',title:'Right Track',cover:'https://example.com/right.jpg'})
  assert.equal(parseAzuraCast(feed,'https://stream.example.com/unknown'),null)
})

test('SHOUTcast stats support explicit SID without using another stream ID', () => {
  assert.equal(shoutcastStatusUrl('https://stream.example.com/stream?sid=3'),
    'https://stream.example.com/stats?sid=3&json=1')
  assert.equal(shoutcastStatusUrl('https://stream.example.com/stream/2'),
    'https://stream.example.com/stats?sid=2&json=1')
  assert.deepEqual(parseShoutcast({streamstatus:1,songtitle:'Artist - Track'}),
    {artist:'Artist',title:'Track'})
  assert.equal(parseShoutcast({streamstatus:0,songtitle:'Artist - Track'}),null)
})

test('generic resolver reads Icecast first, falls back to AzuraCast then SHOUTcast', async () => {
  const urls = []
  const fake = async url => {
    const path = new URL(url).pathname
    urls.push(path)
    if(path === '/status-json.xsl') return {
      ok:false, status:404, headers:{get:()=>null}, text: async()=>''}
    if(path === '/api/nowplaying') return {
      ok:true, status:200, headers:{get:()=>null},
      text:async()=>JSON.stringify([{
        station:{listen_url:'https://stream.example.com/live.mp3'},
        now_playing:{song:{artist:'Generic Artist',title:'Generic Title',
          art:'https://example.com/art.jpg'}}
      }])
    }
    throw new Error('unexpected URL ' + url)
  }
  const result = await visibleStationMetadata({
    id:'rb:test',url:'https://stream.example.com/live.mp3',title:'Generic Radio'
  },{fetchImpl:fake})
  assert.deepEqual(result,{artist:'Generic Artist',title:'Generic Title',
    cover:'https://example.com/art.jpg'})
  assert.deepEqual(urls,['/status-json.xsl','/api/nowplaying'])
})
