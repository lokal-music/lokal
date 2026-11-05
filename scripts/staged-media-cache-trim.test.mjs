import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createDeferredTrimmer } = require('../electron/online/stagedMediaTrim.js')

function harness(initial) {
  let state = initial
  let emit
  let trims = 0
  const keep = ['previous-dash.m4a', 'current-hybrid.m4a']
  const trimmer = createDeferredTrimmer({
    trim: () => { trims++ },
    getState: () => state,
    subscribe: fn => { emit = fn },
  })
  return {
    trimmer,
    keep,
    set(next) { state = next; emit(next) },
    get trims() { return trims },
  }
}

test('review: publishing a DASH file does not evict the preceding active track', () => {
  const playing = { connected: true, currentTrack: { id: 'old' }, isPlaying: true }
  const t = harness(playing)
  t.trimmer.request()
  assert.equal(t.trims, 0, 'publication must not run shared trim')
  t.set({ ...playing, currentTrack: { id: 'new' } })
  assert.equal(t.trims, 0, 'song changes and crossfades may still use old file')
  t.set({ ...playing, currentTrack: { id: 'new' }, isPlaying: false })
  assert.equal(t.trims, 0, 'paused playback can still hold the current file')
  t.set({ connected: true, currentTrack: null, isPlaying: false })
  assert.equal(t.trims, 1, 'only the cleared player state permits eviction')
  assert.equal(t.trimmer.pending, false)
})

test('review: DASH and hybrid publications coalesce into one shared-limit trim', () => {
  const playing = { connected: true, currentTrack: { id: 'recording' }, isPlaying: true }
  const t = harness(playing)
  t.trimmer.request()
  t.trimmer.request()
  t.set({ connected: true, currentTrack: null, isPlaying: false })
  assert.equal(t.trims, 1)
  t.set({ connected: true, currentTrack: null, isPlaying: false })
  assert.equal(t.trims, 1)
})

test('review: preloaded files are not evicted before a selected song begins', () => {
  const t = harness({ connected: true, currentTrack: null, isPlaying: false })
  t.trimmer.request()
  t.set({ connected: true, currentTrack: null, isPlaying: false })
  assert.equal(t.trims, 0, 'an idle report before playback is not evidence that the file is unused')
  t.set({ connected: true, currentTrack: { id: 'prepared' }, isPlaying: true })
  assert.equal(t.trims, 0)
  t.set({ connected: true, currentTrack: null, isPlaying: false })
  assert.equal(t.trims, 1)
})

test('review: failed cache trim remains deferred for a later safe retry', () => {
  let emit
  let attempts = 0
  const playing = { connected: true, currentTrack: { id: 'a' }, isPlaying: true }
  const trimmer = createDeferredTrimmer({
    trim: () => { attempts++; if (attempts === 1) throw new Error('Disk busy') },
    getState: () => playing,
    subscribe: fn => { emit = fn },
  })
  trimmer.request()
  emit({ connected: true, currentTrack: null, isPlaying: false })
  assert.equal(trimmer.pending, true)
  emit({ connected: true, currentTrack: null, isPlaying: false })
  assert.equal(attempts, 2)
  assert.equal(trimmer.pending, false)
})

test('review: an unreported playback state must never authorize a trim', () => {
  const t = harness({ connected: false, currentTrack: null, isPlaying: false })
  t.trimmer.request()
  t.set({ connected: false, currentTrack: null, isPlaying: false })
  assert.equal(t.trims, 0, 'cold-start orphan cleanup runs before player creation instead')
})
