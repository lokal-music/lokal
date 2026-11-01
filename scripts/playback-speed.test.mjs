import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSpeed, SPEED_MIN, SPEED_MAX, SPEED_STEP } from '../src/playbackSpeed.mjs'

test('normalizes invalid values to normal speed', () => {
  for (const value of [undefined, null, '', NaN, 0, -1, 'not-a-number']) {
    assert.equal(normalizeSpeed(value), 1)
  }
})

test('clamps to the supported range and rounds to hundredths', () => {
  assert.equal(normalizeSpeed(0.01), SPEED_MIN)
  assert.equal(normalizeSpeed(9), SPEED_MAX)
  assert.equal(normalizeSpeed(1.237), 1.24)
})

test('supports precise 0.01x playback speed steps', () => {
  assert.equal(SPEED_STEP, 0.01)
  assert.equal(normalizeSpeed(1 + SPEED_STEP), 1.01)
  assert.equal(normalizeSpeed(1.01 + SPEED_STEP), 1.02)
  assert.equal(normalizeSpeed(1.02 - SPEED_STEP), 1.01)
  assert.equal(normalizeSpeed(0.99), 0.99)
})

test('keeps a valid speed', () => {
  assert.equal(normalizeSpeed(1.5), 1.5)
})
