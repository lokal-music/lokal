import { create } from 'zustand'

export const SPEED_MIN = 0.1
export const SPEED_MAX = 2.5
export const SPEED_STEP = 0.01
const STORAGE_KEY = 'lokal-playback-speed'

export function normalizeSpeed(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, n)) * 100) / 100
}

function readStoredSpeed() {
  try { return normalizeSpeed(localStorage.getItem(STORAGE_KEY) ?? 1) } catch { return 1 }
}

export const usePlaybackSpeed = create(set => ({
  speed: readStoredSpeed(),
  setSpeed: value => {
    const speed = normalizeSpeed(value)
    set({ speed })
    try { localStorage.setItem(STORAGE_KEY, String(speed)) } catch {}
  },
}))

/** Read the current speed outside React, e.g. in media synchronization. */
export const playbackSpeed = () => usePlaybackSpeed.getState().speed
