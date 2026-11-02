// Silent, optional artist-page motion inside the existing circular portrait.
// The source is a local MP4 prepared by the shared artwork cache.
import React, { useEffect, useRef, useState } from 'react'
import { usePerformanceMode } from '../performanceMode'
import { isWindowHidden, onWindowVisibility } from '../windowVisibility'

export function ArtistTitle({ name, logoSrc, logoAspect = 1 }) {
  return (
    <h1 className="min-w-0 text-3xl font-display text-white" aria-label={name}>
      {logoSrc
        ? <img src={logoSrc} alt={name} draggable={false}
            className="block max-w-full object-contain object-left"
            style={{ height: 52, width: Math.min(420, Math.max(72, 52 * logoAspect)) }}
            onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement.dataset.logoFailed = 'true' }} />
        : name}
      {logoSrc && <span className="sr-only">{name}</span>}
    </h1>
  )
}

export function ArtistMotionPortrait({ src }) {
  const video = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [visible, setVisible] = useState(true)
  const [reduced, setReduced] = useState(() =>
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
  const performanceMode = usePerformanceMode()
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return undefined
    const update = () => setReduced(query.matches)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  useEffect(() => {
    if (!video.current || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false), { threshold: .15 })
    observer.observe(video.current)
    return () => observer.disconnect()
  }, [src, reduced, performanceMode])
  useEffect(() => {
    const element = video.current
    if (!element || !src || reduced || performanceMode) return undefined
    const sync = () => {
      if (isWindowHidden() || !visible) {
        element.pause()
        setPlaying(false)
      } else {
        element.play().catch(() => setPlaying(false))
      }
    }
    sync()
    const stop = onWindowVisibility(sync)
    return () => { stop(); element.pause() }
  }, [src, reduced, visible, performanceMode])
  if (!src || reduced || performanceMode) return null
  return (
    <video ref={video} src={src} muted loop playsInline preload="metadata"
      aria-hidden="true" tabIndex={-1}
      onPlaying={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onError={() => setPlaying(false)}
      className={`pointer-events-none absolute inset-0 h-full w-full rounded-full object-cover transition-opacity duration-500 ${playing ? 'opacity-100' : 'opacity-0'}`} />
  )
}
