// Shared desktop artist visual state. The last *verified* logo is restored
// synchronously so revisiting a page never flashes the plain title first.
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'

const KEY = 'lokal:apple-artist-logos:v1'
const memory = new Map()
function readIndex() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} }
}
function fromCache(id, name) {
  const key = String(id || '')
  const value = memory.get(key) || readIndex()[key]
  return value?.name === name && value?.logoSrc ? value : null
}
function store(id, name, value) {
  if (!value?.logoSrc) return
  const item = { name, logoSrc: value.logoSrc, logoAspect: value.logoAspect || 1 }
  const key = String(id)
  memory.set(key, item)
  try {
    const index = readIndex()
    index[key] = item
    // A bounded index; image bytes live in app support, not localStorage.
    const ids = Object.keys(index)
    if (ids.length > 200) for (const oldest of ids.slice(0, ids.length - 200)) delete index[oldest]
    localStorage.setItem(KEY, JSON.stringify(index))
  } catch { /* Private browsing/disabled storage must not break the page. */ }
}

/** No remote network work before mount. Catalogue evidence is checked in the main process. */
export function useArtistVisuals(artistId, artistName, knownTitles, refresh = 0) {
  const key = String(artistId || '')
  const cached = fromCache(key, artistName)
  const [loaded, setLoaded] = useState(null)
  const [motionSrc, setMotionSrc] = useState(null)
  const titles = useMemo(() => [...new Set((knownTitles || []).filter(Boolean))].slice(0, 60),
    [knownTitles])
  const visuals = loaded?.key === key && loaded.name === artistName
    ? loaded : cached ? { key, ...cached } : null

  useEffect(() => {
    let active = true
    setMotionSrc(null)
    if (!api.isElectron || !key || !artistName || titles.length === 0) return () => { active = false }
    ;(async () => {
      try {
        const info = await api.artistVisuals(key, artistName, titles, refresh > 0)
        if (!active) return
        if (info?.logoSrc) {
          store(key, artistName, info)
          setLoaded({ key, name: artistName, ...info })
        } else if (!fromCache(key, artistName)) {
          setLoaded({ key, name: artistName })
        }
        // Motion can involve an HLS remux. Keep the static portrait and
        // stylized logo responsive while the clip is prepared.
        const motion = await api.artistMotion(key, artistName, titles)
        if (active && motion?.src) setMotionSrc(motion.src)
      } catch { /* Static portrait and plain text remain available. */ }
    })()
    return () => { active = false }
  }, [key, artistName, titles, refresh])

  return { logoSrc: visuals?.logoSrc || null, logoAspect: visuals?.logoAspect || 1, motionSrc }
}
