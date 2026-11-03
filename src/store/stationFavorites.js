// Persist the full station record, not just its URL: favorites survive
// changes to Radio Browser discovery results and can be shown offline.
import { create } from 'zustand'

const KEY = 'lokal_station_favorites_v1'
const read = () => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
const save = value => {
  try { localStorage.setItem(KEY, JSON.stringify(value)) } catch {}
}

export const useStationFavorites = create((set, get) => ({
  favorites: read(),
  toggle: station => {
    const favorites = { ...get().favorites }
    if (favorites[station.id]) delete favorites[station.id]
    else favorites[station.id] = station
    save(favorites)
    set({ favorites })
  },
}))
