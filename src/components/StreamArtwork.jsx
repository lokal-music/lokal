import React, { useEffect, useState } from 'react'
import { usePlayerStore } from '../store/player'
import { api } from '../api'
import { isStreamed, isAddonProvider, streamRef, loadAddonNames } from '../onlineTracks'
import DiscoveryImage from './DiscoveryImage'
import { isAmazonMusicAddonLabel, resolvePlayerArtwork } from '../playerArtworkResolution.mjs'

// Search covers may already have been saved to queue/history before their
// source stopped serving the URL. Repair the active track and queued copy once
// a metadata fallback has actually loaded, without changing playback identity.
export function rememberRecoveredStreamArtwork(track, image) {
  if (!isStreamed(track) || !image || !/^(?:https:\/\/|file:\/\/)/i.test(image)) return
  const same = row => row?.id === track.id && row.file_path === track.file_path && isStreamed(row)
  usePlayerStore.setState(state => {
    let changed = false
    let currentTrack = state.currentTrack
    if (same(currentTrack) && currentTrack.artwork_url !== image) {
      currentTrack = { ...currentTrack, artwork_url: image }
      changed = true
    }
    const queue = state.queue.map(row => {
      if (!same(row) || row.artwork_url === image) return row
      changed = true
      return { ...row, artwork_url: image }
    })
    return changed ? { currentTrack, queue } : {}
  })
}

function promoteStreamArtwork(track, image) {
  if (!image || !track || image === track.artwork_url) return
  rememberRecoveredStreamArtwork(track, image)
  // Persist only a successfully loaded HTTPS cover, and only when the old
  // stored URL has not changed. This survives restart without touching audio.
  if (/^https:\/\//i.test(image) && track.id) {
    void api.repairOnlineArtwork?.(track.id, track.artwork_url || null, image).catch(() => {})
  }
}

export default function StreamArtwork({ track, src, fallback, ...props }) {
  const [selected, setSelected] = useState({ key: '', url: '' })
  const key = JSON.stringify([track?.id, track?.file_path, src])
  const large = selected.key === key ? selected.url : ''

  useEffect(() => {
    let active = true
    setSelected({ key: '', url: '' })
    const ref = streamRef(track)
    if (!isAddonProvider(ref?.provider)) return () => { active = false }
    // For Amazon, always try a separate Deezer/iTunes/YouTube catalogue cover
    // FIRST. Source-owned thumbnails are used only if that lookup fails.
    // Other HTTP addons keep the normal size-based fallback policy.
    void (async () => {
      const names = await loadAddonNames()
      if (!active) return
      const preferIndependent = isAmazonMusicAddonLabel(names?.[ref.provider])
      const url = await resolvePlayerArtwork(track, src, async request => {
        const [result] = await api.discoveryArtwork([request])
        if (result?.image) return result.image
        // A recording can have different featured-artist/title credits in
        // Amazon and the public catalogues. An exact album match is a safer
        // second independent source than an arbitrary song thumbnail.
        if (track.album) {
          const [album] = await api.discoveryArtwork([{
            ...request, type: 'album', title: track.album,
            artist: track.album_artist || track.artist,
          }])
          return album?.image || ''
        }
        return ''
      }, { preferIndependent })
      if (!active || !url || url === src) return
      setSelected({ key, url })
      promoteStreamArtwork(track, url)
    })().catch(() => {})
    return () => { active = false }
  }, [key, track?.title, track?.artist])

  return <DiscoveryImage
    {...props}
    item={track}
    src={large || src}
    lookup
    fallback={fallback}
    onResolved={image => {
      if (!large) promoteStreamArtwork(track, image)
    }}
  />
}
