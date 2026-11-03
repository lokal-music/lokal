import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createDiscordPublisher } from '../src/discord.js'

const require = createRequire(import.meta.url)
const { buildActivity } = require('../electron/discord/activity.js')
const flush = () => new Promise(resolve => setImmediate(resolve))
const song = { id: 'one', title: 'Song', artist: 'Artist', album: 'Album', duration: 240 }
const now = 1800000000000

test('listening payload has real progress, source cover, and both buttons', () => {
  const activity = buildActivity({ ...song, position_ms: 30000, source_ref: 'yt:abcdefghijk', artwork_url: 'https://covers.example/album.jpg' }, true, { now })
  assert.equal(activity.type, 2)
  assert.equal(activity.status_display_type, 1)
  assert.equal(activity.details, 'Song')
  assert.equal(activity.state, 'Artist')
  assert.deepEqual(activity.timestamps, { start: now - 30000, end: now + 210000 })
  assert.equal(activity.assets.large_image, 'https://covers.example/album.jpg')
  assert.deepEqual(activity.buttons, [
    { label: 'Search on YouTube', url: 'https://www.youtube.com/results?search_query=Artist%20Song' },
    { label: 'View App on GitHub', url: 'https://github.com/lokal-music/Desktop' },
  ])
})

test('milliseconds, short songs, seek limits, and delayed artwork keep accurate timestamps', () => {
  const activity = buildActivity({ ...song, duration_ms: 60000, position_ms: 10000 }, true, { now, receivedAt: now - 5000 })
  assert.deepEqual(activity.timestamps, { start: now - 15000, end: now + 45000 })
  assert.deepEqual(buildActivity({ ...song, position: 30 }, true, { now }).timestamps, { start: now - 30000, end: now + 210000 })
  assert.deepEqual(buildActivity({ ...song, position: 500 }, true, { now }).timestamps, { start: now - 240000, end: now })
  const paused = buildActivity({ ...song, position: 30 }, false, { now })
  assert.equal(paused.timestamps, undefined)
  assert.equal(paused.assets.small_text, 'Paused')
  assert.equal(buildActivity(null, false), null)
})

test('local files get a search button, never a file URL or private addon media link', () => {
  for (const source_url of ['file:///music/private.flac', 'https://localhost/secret', 'https://addon.example/audio?token=secret']) {
    const activity = buildActivity({ ...song, source_url, artwork_url: 'file:///cover.png' }, true, { now })
    assert.equal(activity.buttons[0].label, 'Search on YouTube')
    assert.equal(activity.assets.large_image, 'lokal_music')
    assert.equal(JSON.stringify(activity).includes('secret'), false)
    assert.equal(JSON.stringify(activity).includes('file:'), false)
  }
  const publicSong = buildActivity({ ...song, source_url: 'https://soundcloud.com/artist/song?tracking=private' }, true)
  assert.equal(publicSong.buttons[0].url, 'https://www.youtube.com/results?search_query=Artist%20Song')
  assert.equal(publicSong.buttons[0].label, 'Search on YouTube')
})

test('short and Unicode labels and invalid timing produce valid activity fields', () => {
  const activity = buildActivity({ title: '曲', artist: 'A', duration: Infinity, position: NaN }, true, { now })
  assert.ok(activity.details.length >= 2)
  assert.ok(activity.state.length >= 2)
  assert.deepEqual(activity.timestamps, { start: now })
  assert.ok(buildActivity({ title: '🎵'.repeat(300), artist: 'A' }, true).buttons[0].url.length <= 512)
})

test('publisher throttles progress, follows seeks/pause/crossfade, and clears on stop', async () => {
  let at = 0
  const audio = { currentTime: 10, duration: 240, dataset: { lokalTrackId: 'one' } }
  const state = { currentTrack: song, isPlaying: true, progress: 0, duration: 240, activeAudioElement: 'primary', audioRef: { current: audio } }
  const calls = []
  const publish = createDiscordPublisher({ getState: () => state, now: () => at, send: (...args) => calls.push(args) })
  publish(); await flush()
  assert.equal(calls[0][0].position_ms, 10000)
  for (let i = 1; i <= 14; i++) { at = i * 1000; audio.currentTime = 10 + i; publish() }
  await flush()
  assert.equal(calls.length, 1)
  at = 15000; audio.currentTime = 25; publish(); await flush()
  assert.equal(calls.length, 2)
  at = 16000; audio.currentTime = 120; publish(); await flush()
  assert.equal(calls.at(-1)[0].position_ms, 120000)
  state.isPlaying = false; publish(); await flush()
  assert.equal(calls.at(-1)[1], false)
  const pausedCalls = calls.length
  at += 60000; publish(); await flush()
  assert.equal(calls.length, pausedCalls)
  state.activeAudioElement = 'cf'
  state.currentTrack = { ...song, id: 'two', title: 'Second song' }
  state.cfAudioRef = { current: { currentTime: 4, duration: 180, dataset: { lokalTrackId: 'two' } } }
  state.isPlaying = true; publish(); await flush()
  assert.equal(calls.at(-1)[0].position_ms, 4000)
  assert.equal(calls.at(-1)[0].duration_ms, 180000)
  state.currentTrack = null; publish(); await flush()
  assert.deepEqual(calls.at(-1), [null, false])
})

test('publisher never attributes the previous audio position to a newly selected track', async () => {
  let sent
  const publish = createDiscordPublisher({
    getState: () => ({ currentTrack: song, isPlaying: true, progress: 150, duration: 600,
      audioRef: { current: { currentTime: 150, duration: 600, dataset: { lokalTrackId: 'previous', lokalTrackPending: 'one' } } } }),
    send: track => { sent = track },
  })
  publish(); await flush()
  assert.equal(sent.position_ms, 0)
  assert.equal(sent.duration_ms, 240000)
})

function service({ rpc, fetchImpl } = {}) {
  const filename = require.resolve('../electron/ipc/discord.js')
  const localRequire = createRequire(filename)
  const context = vm.createContext({
    require: id => id === 'discord-rpc' && rpc ? rpc : localRequire(id), module: { exports: {} },
    process: { pid: process.pid, on() {}, exit() {} }, console, setTimeout, clearTimeout,
    fetch: fetchImpl || (() => { throw new Error('Unexpected network lookup') }), AbortSignal, URL,
  })
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  const handlers = new Map()
  context.module.exports.registerDiscordHandlers({ handle: (name, handler) => handlers.set(name, handler) })
  return (name, ...args) => handlers.get(`discord:${name}`)(null, ...args)
}

test('artwork arriving after a skip or pause cannot restore old playback', async () => {
  const sent = []
  class Client extends EventEmitter {
    async login() { this.user = { id: 'fixture' } }
    async request(command, args) { sent.push(args.activity) }
    async clearActivity() { sent.push(null) }
    async destroy() {}
  }
  const lookups = []
  const call = service({ rpc: { Client }, fetchImpl: () => new Promise(resolve => lookups.push(resolve)) })
  await call('connect', '123')
  await call('setActivity', { ...song, album: '' }, true)
  const next = { ...song, id: 'two', title: 'Second song', album: '' }
  await call('setActivity', next, true)
  lookups[0]({ ok: true, json: async () => ({ data: [{ title: 'Song', artist: { name: 'Artist' }, album: { cover_big: 'https://covers.example/first.jpg' } }] }) })
  await flush()
  assert.equal(sent.at(-1).details, 'Second song')
  await call('setActivity', next, false)
  lookups[1]({ ok: true, json: async () => ({ data: [{ title: 'Second song', artist: { name: 'Artist' }, album: { cover_big: 'https://covers.example/second.jpg' } }] }) })
  await flush()
  assert.equal(sent.at(-1).details, 'Second song')
  assert.equal(sent.at(-1).timestamps, undefined)
  assert.match(sent.at(-1).assets.large_image, /second\.jpg/)
  await call('setActivity', null, false)
  assert.equal(sent.at(-1), null)
  await call('disconnect')
})

test('cached playback is published when Discord connects after playback starts', async () => {
  const sent = []
  class Client extends EventEmitter {
    async login() { this.user = { id: 'fixture' } }
    async request(command, args) { sent.push(args.activity) }
    async clearActivity() {}
    async destroy() {}
  }
  const call = service({ rpc: { Client } })
  await call('setActivity', { ...song, artwork_url: 'https://covers.example/album.jpg', position_ms: 60000 }, false)
  assert.equal(sent.length, 0)
  assert.equal(await call('connect', '123'), true)
  assert.equal(sent[0].details, 'Song')
  assert.equal(sent[0].timestamps, undefined)
  await call('disconnect')
})

test('real discord-rpc client sends Listening and buttons over the IPC transport', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-discord-'))
  const previousDir = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = dir
  const frames = []
  const sockets = new Set()
  const encode = (op, data) => {
    const payload = Buffer.from(JSON.stringify(data))
    const header = Buffer.alloc(8)
    header.writeInt32LE(op, 0); header.writeInt32LE(payload.length, 4)
    return Buffer.concat([header, payload])
  }
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes])
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readInt32LE(4)) {
        const op = buffer.readInt32LE(0), length = buffer.readInt32LE(4)
        const data = JSON.parse(buffer.subarray(8, 8 + length))
        buffer = buffer.subarray(8 + length)
        if (op === 0) socket.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { id: 'synthetic' } } }))
        else if (op === 1) {
          frames.push(data)
          socket.write(encode(1, { cmd: data.cmd, nonce: data.nonce, data: {} }))
        } else if (op === 2) socket.end()
      }
    })
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    if (previousDir === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousDir
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(path.join(dir, 'discord-ipc-0'), resolve))
  const call = service()
  assert.equal(await call('connect', '1473597925581131919'), true)
  await call('setActivity', { ...song, source_ref: 'yt:abcdefghijk', position: 30 }, true)
  const frame = frames.find(item => item.args?.activity)
  assert.equal(frame.cmd, 'SET_ACTIVITY')
  assert.equal(frame.args.pid, process.pid)
  assert.equal(frame.args.activity.type, 2)
  assert.deepEqual(frame.args.activity.buttons, [
    { label: 'Search on YouTube', url: 'https://www.youtube.com/results?search_query=Artist%20Song' },
    { label: 'View App on GitHub', url: 'https://github.com/lokal-music/Desktop' },
  ])
  assert.equal(frame.args.activity.timestamps.end - frame.args.activity.timestamps.start, 240000)
  await call('disconnect')
  assert.equal(frames.at(-1).cmd, 'SET_ACTIVITY')
  assert.deepEqual(frames.at(-1).args, { pid: process.pid })
  assert.equal((await call('status')).connected, false)
})

test('local album cover resolves by exact artist and album when the song is absent', async () => {
  const sent = []
  const requests = []
  class Client extends EventEmitter {
    async login() { this.user = { id: 'fixture' } }
    async request(command, args) { sent.push(args.activity) }
    async clearActivity() {}
    async destroy() {}
  }
  const call = service({ rpc: { Client }, fetchImpl: async url => {
    requests.push(url)
    return { ok: true, json: async () => ({ data: [
      { title: 'New Beginnings', artist: { name: 'Voice Of Reason' }, cover_big: 'https://covers.example/wrong.jpg' },
      { title: 'New Beginnings', artist: { name: 'REASON' }, cover_big: 'https://covers.example/reason.jpg' },
    ] }) }
  } })
  await call('connect', '123')
  await call('setActivity', { ...song, title: 'Flick It Up', artist: 'Reason', album: 'New Beginnings', artwork_path: '/private/cover.jpg' }, true)
  await flush()
  assert.equal(sent.at(-1).assets.large_image, 'https://covers.example/reason.jpg')
  assert.equal(sent.at(-1).details, 'Flick It Up')
  assert.equal(requests.length, 1)
  assert.match(requests[0], /^https:\/\/api.deezer.com\/search\/album\?/)
  assert.equal(JSON.stringify(sent).includes('/private/'), false)
  await call('disconnect')
})

test('album lookup falls back to iTunes and retains both buttons when source art is missing', async () => {
  const sent = []
  const requests = []
  class Client extends EventEmitter {
    async login() { this.user = { id: 'fixture' } }
    async request(command, args) { sent.push(args.activity) }
    async clearActivity() {}
    async destroy() {}
  }
  const call = service({ rpc: { Client }, fetchImpl: async url => {
    requests.push(url)
    return { ok: true, json: async () => url.includes('deezer') ? { data: [] } : { results: [
      { collectionName: 'Album', artistName: 'Artist', artworkUrl100: 'https://covers.example/100x100bb.jpg' },
    ] } }
  } })
  await call('connect', '123')
  await call('setActivity', song, true)
  await flush()
  assert.equal(sent.at(-1).assets.large_image, 'https://covers.example/600x600bb.jpg')
  assert.equal(sent.at(-1).buttons.length, 2)
  assert.equal(requests.length, 2)
  await call('disconnect')
})

test('YouTube search retains long song names within Discord URL limits', () => {
  const track = { artist: 'An Artist', title: 'A Song Title That Is Longer Than Thirty Two Characters' }
  const activity = buildActivity(track, true)
  assert.equal(new URL(activity.buttons[0].url).searchParams.get('search_query'), `${track.artist} ${track.title}`)
  assert.equal(activity.buttons[1].url, 'https://github.com/lokal-music/Desktop')
  const unicode = buildActivity({ artist: '🎵'.repeat(100), title: '長い曲名' }, true)
  assert.ok(unicode.buttons[0].url.length <= 512)
})

test('fallback artwork is independent of private track metadata', () => {
  const { fallbackArtwork } = require('../electron/discord/activity.js')
  assert.equal(fallbackArtwork({ artist: 'Private Artist', title: 'Unreleased Song' }), fallbackArtwork())
  assert.equal(new URL(fallbackArtwork()).protocol, 'https:')
})

test('generated fallback art retries after five minutes and catalogue art keeps the long TTL', async () => {
  let at = now, calls = 0
  const filename = require.resolve('../electron/ipc/discord.js')
  const localRequire = createRequire(filename)
  const context = vm.createContext({
    module: { exports: {} }, process: { on() {} }, console,
    Date: { now: () => at },
    require: id => id === '../discoveryArtwork'
      ? { createArtworkResolver: () => async () => { calls++; return calls === 1 ? [] : [{ image: 'https://covers.example/found.jpg' }] } }
      : localRequire(id),
  })
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  context.track = { ...song, album: '' }
  const request = async () => { vm.runInContext('requestArtwork(track)', context); await flush() }
  await request()
  assert.equal(calls, 1)
  at += 299999
  await request()
  assert.equal(calls, 1)
  at++
  await request()
  assert.equal(calls, 2)
  at += 300000
  await request()
  assert.equal(calls, 2)
})
