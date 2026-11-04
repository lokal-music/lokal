import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { diffPlaylistSnapshots, snapshotFromJournal } = require('../electron/link/reconcile.js')
const { createLinkedLibraryRefresh } = require('../electron/link/libraryRefresh.js')

const member = (key, position) => ({
  track_key: key, position, title: key, artist: 'Artist',
  album: 'Album', duration: 180, file_hash: key, online_ref: false,
  source_ref: null, artwork_url: null
})

test('initial reconciliation exports playlist definitions and ordered members', () => {
  const operations = diffPlaylistSnapshots({}, {
    first: { name: 'My playlist', members: [member('a', 0), member('b', 1)] }
  })
  assert.deepEqual(operations.map(item => item.op), [
    'playlist.create', 'playlist.add', 'playlist.add'
  ])
  assert.deepEqual(operations.slice(1).map(item => item.fields.position), [0, 1])
})

test('subsequent unchanged playlist snapshots generate no redundant operations', () => {
  const state = { p: { name: 'Same', members: [member('a', 0)] } }
  assert.deepEqual(diffPlaylistSnapshots(state, state), [])
})

test('desktop removal and rename are both exported', () => {
  const before = {
    removed: { name: 'Delete me', members: [] },
    renamed: { name: 'Old', members: [] }
  }
  const after = { renamed: { name: 'New', members: [] } }
  const events = diffPlaylistSnapshots(before, after)
  assert.deepEqual(events.map(row => [row.entity_id, row.op]), [
    ['removed', 'playlist.delete'], ['renamed', 'playlist.rename']
  ])
})

test('member removals and ordering changes survive the incremental cursor', () => {
  const before = { p: { name: 'Playlist', members: [member('a', 0), member('b', 1)] } }
  const after = { p: { name: 'Playlist', members: [member('b', 0), member('c', 1)] } }
  const events = diffPlaylistSnapshots(before, after)
  assert.deepEqual(events.map(row => [row.op, row.fields.track_key]), [
    ['playlist.remove', 'a'], ['playlist.move', 'b'], ['playlist.add', 'c']
  ])
})

test('legacy first sync detects desktop playlists deleted without a captured delete event', () => {
  const journal = snapshotFromJournal([
    { entity_id: 'deleted-legacy', op: 'playlist.create', fields_json: JSON.stringify({ name: 'Old' }) },
    { entity_id: 'deleted-legacy', op: 'playlist.add', fields_json: JSON.stringify(member('a', 0)) }
  ])
  const diff = diffPlaylistSnapshots(journal, {})
  assert.deepEqual(diff.map(row => [row.entity_id, row.op]), [
    ['deleted-legacy', 'playlist.delete']
  ])
})

test('a captured delete does not generate a redundant deletion', () => {
  const journal = snapshotFromJournal([
    { entity_id: 'p', op: 'playlist.create', fields_json: '{"name":"Already removed"}' },
    { entity_id: 'p', op: 'playlist.delete', fields_json: '{}' }
  ])
  assert.deepEqual(diffPlaylistSnapshots(journal, {}), [])
})

test('accepted mobile playlist batches refresh the desktop UI once, without a restart', async () => {
  let renders = 0
  const refresh = createLinkedLibraryRefresh({ publish: () => { renders++ }, delayMs: 10 })
  refresh.accepted(0) // duplicate journal page
  refresh.accepted(3) // playlist.create and member operations
  refresh.accepted(2) // next page in the same sync
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(renders, 1)
  refresh.accepted(1) // subsequent mobile rename
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(renders, 2)
  refresh.close()
})

test('closing the desktop link cancels its pending playlist refresh', async () => {
  let renders = 0
  const refresh = createLinkedLibraryRefresh({ publish: () => { renders++ }, delayMs: 20 })
  refresh.accepted(1)
  refresh.close()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(renders, 0)
})
