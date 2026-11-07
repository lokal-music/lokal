import React, { useEffect, useRef, useState } from 'react'
import { Music } from 'lucide-react'
import { api } from '../api'
import QualityImage from './QualityImage'

const MAX_ARTWORK_FAILURES = 4
const usable = image => typeof image === 'string' && /^(?:https:\/\/|file:\/\/)/i.test(image)

/**
 * Shared image fallback for Search and Now Playing.
 * As on Mobile, do not stop after one metadata image that is dead, blocked
 * or otherwise undecodable. Request the next verified source, excluding
 * every URL that was actually tried, and only promote a cover after it loads.
 */
export default function DiscoveryImage({ item, type = 'track', src, className = '', fallback = null, lookup = false, onResolved, ...imgProps }) {
  const [image, setImage] = useState(src || '')
  const [failed, setFailed] = useState(false)
  const request = useRef(0)
  const currentImage = useRef(src || '')
  const discarded = useRef(new Set())
  const requesting = useRef(false)
  const identity = JSON.stringify([type, item?.id, item?.title, item?.artist, item?.name, src])

  async function recover(broken = currentImage.current) {
    if (requesting.current) return
    if (broken) discarded.current.add(broken)
    if (discarded.current.size >= MAX_ARTWORK_FAILURES) {
      setFailed(true)
      return
    }
    const title = type === 'artist' ? item?.name : item?.title
    const artist = type === 'artist' ? item?.name : item?.artist
    if (!artist || (type !== 'artist' && !title)) { setFailed(true); return }
    const generation = ++request.current
    requesting.current = true
    setFailed(true)
    try {
      const excluded = [...discarded.current]
      const [result] = await api.discoveryArtwork([{
        type, title, artist, exclude: broken || '', excludes: excluded,
        // Local library art is still a valid first fallback; previously
        // failed local files are excluded on the next attempt.
        remoteOnly: false,
      }])
      if (request.current !== generation) return
      const found = result?.image
      if (!usable(found) || discarded.current.has(found)) return
      currentImage.current = found
      setImage(found)
      setFailed(false)
    } catch { /* Artwork must never stop searching or audio playback. */ }
    finally {
      if (request.current === generation) requesting.current = false
    }
  }

  useEffect(() => {
    request.current++
    requesting.current = false
    discarded.current = new Set()
    currentImage.current = src || ''
    setImage(src || '')
    setFailed(false)
    if (!src && lookup && item?.title) void recover('')
    return () => { request.current++ }
  }, [identity, lookup]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!image || failed) {
    return fallback || <div className="flex h-full w-full items-center justify-center text-muted"><Music size={28} /></div>
  }
  return <QualityImage {...imgProps} src={image} className={className}
    onError={() => { void recover(image) }}
    onLoad={() => { if (image !== src) onResolved?.(image) }} />
}
