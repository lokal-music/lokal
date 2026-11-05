import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDeferredTrimmer } = require('../electron/online/stagedMediaTrim.js')

const selected = id => ({ connected: true, currentTrack: { id }, isPlaying: true })
const idle = { connected: true, currentTrack: null, isPlaying: false }

function harness(initial, trimCallback) {
  let state = initial
  let emit
  let trims = 0
  let nextId = 0
  const timers = new Map()
  const trimmer = createDeferredTrimmer({
    trim: () => { trims++; trimCallback?.(trims) },
    getState: () => state,
    subscribe: fn => { emit = fn },
    schedule(fn, duration) {
      assert.equal(duration, 5000)
      const id = ++nextId
      timers.set(id, fn)
      return id
    },
    cancel(id) { timers.delete(id) },
  })
  return {
    trimmer,
    set(next) { state = next; emit(next) },
    advance() {
      const callbacks = [...timers.values()]
      timers.clear()
      callbacks.forEach(callback => callback())
    },
    get trims() { return trims },
    get timers() { return timers.size },
  }
}

test('DASH publication never evicts the outgoing track during the handoff', () => {
  const t = harness(selected('old'))
  t.trimmer.request()
  assert.equal(t.trims, 0, 'publishing a song does not trim any file')
  t.set(selected('new'))
  assert.equal(t.trims, 0, 'old and new may overlap in an audio crossfade')
  t.set({ ...selected('new'), isPlaying: false })
  assert.equal(t.trims, 0, 'paused playback still holds the selected file')
  t.set(idle)
  assert.equal(t.trims, 0, 'even idle transition waits for audio handles to close')
  assert.equal(t.timers, 1)
  t.advance()
  assert.equal(t.trims, 1)
  assert.equal(t.trimmer.pending, false)
})

test('DASH/hybrid publications coalesce into one shared-cache-budget trim', () => {
  const t = harness(selected('track'))
  t.trimmer.request()
  t.trimmer.request()
  t.set(idle)
  t.advance()
  assert.equal(t.trims, 1)
  t.set(idle)
  t.advance()
  assert.equal(t.trims, 1)
})

test('preloaded files stay protected until a selected playback session completes', () => {
  const t = harness(idle)
  t.trimmer.request()
  t.set(idle)
  t.advance()
  assert.equal(t.trims, 0, 'idle before playback does not prove prepared file unused')
  t.set(selected('prepared'))
  t.set(idle)
  t.advance()
  assert.equal(t.trims, 1)
})

test('transient idle between songs cancels pending trim', () => {
  const t = harness(selected('a'))
  t.trimmer.request()
  t.set(idle)
  assert.equal(t.timers, 1)
  t.set(selected('b'))
  assert.equal(t.timers, 0, 'resume cancels any impending eviction')
  t.advance()
  assert.equal(t.trims, 0)
  t.set(idle)
  t.advance()
  assert.equal(t.trims, 1)
})

test('a failed cache trim remains pending for another safe idle attempt', () => {
  const t = harness(selected('a'), attempts => {
    if (attempts === 1) throw new Error('Disk busy')
  })
  t.trimmer.request()
  t.set(idle)
  t.advance()
  assert.equal(t.trimmer.pending, true)
  t.set(idle)
  t.advance()
  assert.equal(t.trims, 2)
  assert.equal(t.trimmer.pending, false)
})

test('unreported playback state must not authorize cache eviction', () => {
  const t = harness({ connected: false, currentTrack: null, isPlaying: false })
  t.trimmer.request()
  t.set({ connected: false, currentTrack: null, isPlaying: false })
  t.advance()
  assert.equal(t.trims, 0, 'cold-start cleanup occurs before any player exists')
})
