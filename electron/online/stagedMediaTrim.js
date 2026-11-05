// Staged LastWave DASH/hybrid recordings are held by Chromium's audio
// pipeline, including preloaded and overlapping streams. Desktop reports the
// selected track for remote control, but does not expose *all* live file
// handles. Never trim immediately after publishing a recording: the keep set
// would protect only that one file and could delete an older song still
// being decoded. Instead, defer shared-cache eviction until the selected
// playback session has cleared (or until the next app startup, before a
// player is created).
'use strict'

/** Create a coalescing cache trim request that fires only after playback ends.
 * A pending request is never flushed for an idle state that existed before
 * playback began: the newly staged recording may still be about to start.
 */
function createDeferredTrimmer({ trim, getState, subscribe, schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout }) {
  let pending = false
  let hadSelectedTrack = false
  let timer = null
  const cancelGracePeriod = () => {
    if (timer != null) cancel(timer)
    timer = null
  }
  const onState = (state) => {
    if (!pending || !state?.connected) return
    if (state.currentTrack || state.isPlaying) {
      if (state.currentTrack) hadSelectedTrack = true
      cancelGracePeriod()
      return
    }
    if (!hadSelectedTrack || timer != null) return
    // Transitioning between tracks can briefly report no selected track.
    // Require a sustained idle state, giving Chromium time to close the
    // outgoing song's media handles before evicting anything.
    timer = schedule(() => {
      timer = null
      const latest = getState()
      if (!pending || !latest?.connected || latest.currentTrack || latest.isPlaying) return
      try {
        trim()
        pending = false
        hadSelectedTrack = false
      } catch {
        // Retry on a later idle update or trim during the next cold startup.
      }
    }, 5000)
    timer?.unref?.()
  }
  subscribe(onState)
  return {
    request() {
      pending = true
      if (getState()?.currentTrack) hadSelectedTrack = true
    },
    get pending() { return pending },
  }
}
let singleton = null
function requestTrimAfterPlayback() {
  if (!singleton) {
    const remote = require('../ipc/remote')
    singleton = createDeferredTrimmer({
      trim: () => require('../cache').trim(),
      getState: remote.getRemoteState,
      subscribe: listener => remote.events.on('state', listener),
    })
  }
  singleton.request()
}

module.exports = { createDeferredTrimmer, requestTrimAfterPlayback }
