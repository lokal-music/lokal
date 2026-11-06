import React from 'react'
import { usePlayerStore } from '../store/player'
import { api } from '../api'
import { isStreamed } from '../onlineTracks'
import DiscoveryImage from './DiscoveryImage'

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

export default function StreamArtwork({ track, src, fallback, ...props }) {
  return <DiscoveryImage
    {...props}
    item={track}
    src={src}
    lookup
    fallback={fallback}
    onResolved={image => {
      rememberRecoveredStreamArtwork(track, image)
      // Only public HTTPS URLs can be persisted in the ghost-track database.
      // A local file:// cover can still render in this session.
      if (/^https:\/\//i.test(image) && track?.id) {
        void api.repairOnlineArtwork?.(track.id, track.artwork_url || null, image).catch(() => {})
      }
    }}
  />
}
