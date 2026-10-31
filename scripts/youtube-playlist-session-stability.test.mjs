import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { youtubePlaylistAccountId } = require('../electron/online/youtubePlaylistIdentity.js')
const { createSpotifyPlaylistCache } = require('../electron/ipc/spotifyPlaylistCache.js')

const profile = {
  yt_account_session: '1',
  yt_account_revision: 'sign-in-100',
  yt_account_partition: 'persist:lokal-ytmusic-profile-a',
}
const credentials = (cookie, authuser = '0', pageid = '') => ({
  cookies: JSON.stringify({
    Cookie: cookie,
    'x-goog-authuser': authuser,
    'x-goog-pageid': pageid,
    'user-agent': 'Lokal desktop',
    'x-youtube-client-version': '1.0',
  }),
})

test('rotating cookies and client metadata do not change the saved Music account identity', () => {
  const first = credentials('SID=login; SAPISID=auth; YSC=initial; SIDCC=a')
  const rotated = credentials('SID=login; SAPISID=auth; SIDCC=b; YSC=new; VISITOR_INFO1_LIVE=visit')
  const upgraded = { cookies: first.cookies.replace('Lokal desktop', 'Lokal 12.5') }
  assert.equal(youtubePlaylistAccountId(first, profile), youtubePlaylistAccountId(rotated, profile))
  assert.equal(youtubePlaylistAccountId(first, profile), youtubePlaylistAccountId(upgraded, profile))
  assert.match(youtubePlaylistAccountId(first, profile), /^[a-f0-9]{64}$/)
  assert.ok(!youtubePlaylistAccountId(first, profile).includes('auth'))
})

test('new sign-in, a different Music channel, or partition changes the identity', () => {
  const auth = credentials('SID=login; SAPISID=auth')
  const before = youtubePlaylistAccountId(auth, profile)
  assert.notEqual(before, youtubePlaylistAccountId(auth, { ...profile, yt_account_revision: 'sign-in-101' }))
  assert.notEqual(before, youtubePlaylistAccountId(auth, { ...profile, yt_account_partition: 'persist:lokal-ytmusic-other' }))
  assert.notEqual(before, youtubePlaylistAccountId(credentials('SID=login; SAPISID=auth', '1'), profile))
  assert.notEqual(before, youtubePlaylistAccountId(credentials('SID=login; SAPISID=auth', '0', 'channel-two'), profile))
})

test('legacy sessions ignore transient cookies but respect authentication account changes', () => {
  const legacy = { yt_account_session: '1' }
  const one = youtubePlaylistAccountId(credentials('SID=primary; SAPISID=auth; YSC=a'), legacy)
  const rotated = youtubePlaylistAccountId(credentials('SID=primary; SAPISID=auth; YSC=b'), legacy)
  const other = youtubePlaylistAccountId(credentials('SID=different; SAPISID=auth; YSC=b'), legacy)
  assert.equal(one, rotated)
  assert.notEqual(one, other)
})

test('provider playlists remain cached after cookie refresh and clear on actual account change', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-youtube-playlists-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filename = path.join(dir, 'youtube-playlists-v1.json')
  const first = credentials('SID=login; SAPISID=auth; YSC=initial')
  const rotated = credentials('SID=login; SAPISID=auth; YSC=rotated')
  const firstId = youtubePlaylistAccountId(first, profile)
  let clock = 1000
  const disk = createSpotifyPlaylistCache(filename, { now: () => clock })
  disk.save(firstId, 'libraryPlaylists', { playlists: [{ id: 'PLhello', title: 'Saved list' }] })
  clock += 1000
  const sameId = youtubePlaylistAccountId(rotated, profile)
  assert.deepEqual(disk.read(sameId, 'libraryPlaylists')?.value?.playlists, [
    { id: 'PLhello', title: 'Saved list' },
  ])
  assert.equal(disk.due(sameId, 'libraryPlaylists', true), false)
  assert.equal(disk.read(sameId, 'libraryPlaylist:PLhello'), null)
  const nextId = youtubePlaylistAccountId(rotated, { ...profile, yt_account_revision: 'sign-in-101' })
  assert.equal(disk.read(nextId, 'libraryPlaylists'), null)
  assert.equal(disk.read(firstId, 'libraryPlaylists'), null)
})
