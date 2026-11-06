import React, { useEffect, useRef, useState } from 'react'
import { Music } from 'lucide-react'
import { api } from '../api'
import QualityImage from './QualityImage'

/**
 * @param lookup  with no `src` at all, look a cover up too (Last.fm's album
 *                lists often have none)
 */
export default function DiscoveryImage({ item, type = 'track', src, className = '', fallback = null, lookup = false, onResolved, ...imgProps }) {
  const [replacement, setReplacement] = useState('')
  const [failed, setFailed] = useState(false)
  const request = useRef(0)
  const retry = async () => {
    setFailed(true)
    if (replacement) return
    const version = ++request.current
    const [result] = await api.discoveryArtwork([{ type, title: item.title, artist: type === 'artist' ? item.name : item.artist, exclude: src }]).catch(() => [])
    if (version !== request.current) return
    if (result?.image && result.image !== src) { setReplacement(result.image); setFailed(false) }
  }
  useEffect(() => {
    request.current++
    setReplacement('')
    setFailed(false)
    if (!src && lookup && item?.title) retry()
    return () => { request.current++ }
  }, [src, lookup, item?.title]) // eslint-disable-line react-hooks/exhaustive-deps
  if ((!src && !replacement) || failed) return fallback || <div className="flex h-full w-full items-center justify-center text-muted"><Music size={28} /></div>
  return <QualityImage {...imgProps} src={replacement || src} className={className}
    onError={retry}
    onLoad={() => { if (replacement && replacement !== src) onResolved?.(replacement) }} />
}
