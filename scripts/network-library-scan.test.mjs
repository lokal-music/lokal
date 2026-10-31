import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scanNetworkRoots, withTimeout, verifiedMissingPaths } = require('../electron/ipc/networkLibrary.js')
const { discardPendingForRoot } = require('../electron/libraryWatcher.js')
const local = path.resolve('/music/local')
const nas = path.resolve('/mnt/nas')
const missing = path.resolve('/mnt/not-found')

test('preserves offline NAS root and scans only currently reachable music roots', async () => {
  const saved = []
  const db = {
    prepare: sql => ({
      run: value => saved.push({ sql, value }),
    }),
  }
  const scans = []
  const result = await scanNetworkRoots(
    [local, nas, local],
    {
      existing: [local, nas],
      db,
      scan: async roots => {
        scans.push(roots)
        return { results: [{ songs: 2 }], status: { done: 2 } }
      },
      isReadable: async folder => folder === local,
    },
  )

  assert.deepEqual(scans, [[local]])
  assert.deepEqual(result.folders, [local, nas])
  assert.deepEqual(result.offlineFolders, [nas])
  assert.equal(JSON.parse(saved[0].value)[1], nas)
  assert.equal(saved[1].value, local)
})

test('keeps all previously saved roots if the NAS is offline', async () => {
  const saved = []
  let stopped = 0
  const result = await scanNetworkRoots([nas], {
    existing: [nas],
    db: { prepare: () => ({ run: value => saved.push(value) }) },
    scan: () => { throw new Error('Should not scan an offline server') },
    isReadable: async () => false,
    closeWatchers: () => { stopped++ },
  })
  assert.deepEqual(result.folders, [nas])
  assert.deepEqual(result.offlineFolders, [nas])
  assert.equal(saved.length, 2)
  assert.equal(stopped, 1)
})

test('rejects a newly entered inaccessible network root', async () => {
  const result = await scanNetworkRoots([missing], {
    existing: [local],
    db: { prepare: () => ({ run: () => { throw new Error('Should not save') } }) },
    scan: () => { throw new Error('Should not scan') },
    isReadable: async () => false,
  })
  assert.match(result.error, /accessible/)
})

test('restores offline NAS preference even when metadata scan throws', async () => {
  const saved = []
  await assert.rejects(() => scanNetworkRoots([local, nas], {
    existing: [local, nas],
    db: { prepare: () => ({ run: value => saved.push(value) }) },
    scan: async () => { throw new Error('NAS disconnected mid-scan') },
    isReadable: async folder => folder === local,
  }), /disconnected/)

  assert.deepEqual(JSON.parse(saved[0]), [local, nas])
  assert.equal(saved[1], local)
})

test('initial network probe has a bounded response time', async () => {
  const bounded = withTimeout(() => new Promise(() => {}), 10)
  await assert.rejects(() => bounded(), /timed out/)
})

test('late NAS disconnect never turns watcher notifications into deletions', async () => {
  const fileOne = path.join(nas, 'Album', '01.flac')
  const fileTwo = path.join(nas, 'Album', '02.flac')
  let probes = 0
  const missing = await verifiedMissingPaths(
    [fileOne, fileTwo],
    () => nas,
    new Map([[nas, true]]),
    async root => { probes++; assert.equal(root, nas); return false },
  )
  assert.deepEqual(missing, [])
  assert.equal(probes, 1, 'a rename batch should probe each root once')

  const localPath = path.join(local, 'song.flac')
  const mixed = await verifiedMissingPaths(
    [fileOne, localPath],
    file => file.startsWith(nas) ? nas : local,
    new Map([[nas, true], [local, true]]),
    async root => root === local,
  )
  assert.deepEqual(mixed, [localPath])
})

test('NAS watcher overflow discards only events belonging to its root', () => {
  const a = path.resolve('/mnt/a')
  const b = path.resolve('/mnt/b')
  const localRoot = path.resolve('/music/local')
  const aSong = path.join(a, 'Album', 'song.flac')
  const bSong = path.join(b, 'Album', 'other.flac')
  const localSong = path.join(localRoot, 'song.mp3')
  const changes = new Map([[aSong, true], [a, true], [bSong, true], [localSong, false]])
  const owner = value => [a, b, localRoot].find(root => {
    const relative = path.relative(root, value)
    return relative && relative !== '..' &&
      !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }) || null

  discardPendingForRoot(changes, a, owner)
  assert.deepEqual([...changes.keys()], [bSong, localSong])
})
