
import { useSyncExternalStore } from 'react'

const KEY = 'lokal-tv-mode'
const listeners = new Set()

function readMode() {
  try {
    return localStorage.getItem(KEY) || 'auto'
  } catch {
    return 'auto'
  }
}

let mode = typeof window !== 'undefined' ? readMode() : 'off'

function notify() {
  listeners.forEach(listener => listener())
}

export function getTvMode() {
  return mode
}

export function setTvMode(value) {
  if (!['auto', 'on', 'off'].includes(value)) return

  mode = value

  try {
    localStorage.setItem(KEY, value)
  } catch {}

  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle(
      'lokal-tv-mode',
      value === 'on' ||
        (value === 'auto' &&
          window.matchMedia('(pointer: coarse)').matches)
    )
  }

  notify()
}

export function useTvMode() {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getTvMode,
    () => 'off'
  )
}
