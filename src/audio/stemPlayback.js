import { createEqualizerRack, loadImpulseFile } from './equalizerGraph.mjs'
import { loadEqState } from './equalizerConfig.mjs'
// Third-deck, prepared-stem transition for local tracks. Disabled unless the
// user explicitly enables the experimental setting. No model inference or
// network streaming happens here; missing clips retain AutoMix's two-deck mix.
const finite = value => typeof value === 'number' && Number.isFinite(value)

export function eligibleStemTransition(clip, plan, speed = 1) {
  if (!clip || !plan || plan.kind !== 'beatmatch' ||
      !finite(speed) || Math.abs(speed - 1) > 1e-4) return false
  if (!ArrayBuffer.isView(clip.audio) && !(clip.audio instanceof ArrayBuffer)) return false
  const bytes = clip.audio.byteLength
  if (!bytes || bytes < 128 || bytes > 100 * 1024 * 1024) return false
  const { outStart, inStart, resumeIn, durationSeconds, masterGain } = clip
  return [outStart,inStart,resumeIn,durationSeconds,masterGain].every(finite) &&
    outStart >= 15 && inStart >= 0 && resumeIn > inStart &&
    durationSeconds >= 6 && durationSeconds <= 45 &&
    masterGain > 0 && masterGain <= 1.05 &&
    // Source analysis can snap to a beat slightly before a model cue.
    Math.abs(plan.start - outStart) < 1.2 &&
    Math.abs(plan.length - durationSeconds) < 1.2 &&
    Math.abs(plan.inOffset - inStart) < 1.2
}

/** Owns a temporary, pauseable HTMLAudioElement routed through the existing
 * AudioContext analyser/output. The active deck remains the real next track,
 * so queue/seek events and media sessions retain their usual song identity.
 * The third deck is never created for remote, native Atmos or bit-perfect
 * routes by the caller.
 */
export function createStemPlayback({
  clip, ctx, analyser, outgoing, incoming,
  outFade, inFade, outGain, inGain, equalizer = [],
  getVolume, onFinish, onAbort,
}) {
  if (!ctx || !analyser || !outgoing || !incoming || !outFade?.gain ||
      !inFade?.gain || !outGain?.gain || !inGain?.gain || !clip?.audio) return null
  const bytes = clip.audio instanceof ArrayBuffer
    ? clip.audio : clip.audio.buffer.slice(clip.audio.byteOffset,
      clip.audio.byteOffset + clip.audio.byteLength)
  const objectURL = URL.createObjectURL(new Blob([bytes], { type:'audio/wav' }))
  const element = new Audio(objectURL)
  element.preload = 'auto'
  const source = ctx.createMediaElementSource(element)
  const mixGain = ctx.createGain()
  // Prefer a full copy of the main deck's DSP rack: stems otherwise bypass
  // preamp, tone, parametric filters, dynamics and FX during transitions.
  // Limited test/platform contexts without the necessary Web Audio nodes retain
  // the earlier simple filter clone as a compatibility fallback.
  const canUseRack = ['createBiquadFilter','createGain','createDynamicsCompressor',
    'createChannelSplitter','createChannelMerger','createStereoPanner',
    'createDelay','createConvolver'].every(name => typeof ctx[name] === 'function')
  const stemRack = canUseRack ? createEqualizerRack(ctx) : null
  const stemFilters = []
  let previous = source
  if (stemRack) {
    source.connect(stemRack.input)
    stemRack.output.connect(mixGain)
    stemRack.apply(loadEqState())
    const state = loadEqState()
    if (state.enabled && state.convolver.enabled && state.convolver.irPath) {
      loadImpulseFile().then(async raw => {
        if (!raw || finished) return
        const buffer = await ctx.decodeAudioData(raw.slice(0))
        if (finished) return
        stemRack.setImpulse(buffer)
        stemRack.apply(loadEqState())
      }).catch(() => {})
    }
  } else {
    if (ctx.createBiquadFilter && Array.isArray(equalizer)) {
      for (const reference of equalizer) {
        if (!reference?.frequency || !reference?.gain || !reference?.Q) continue
        const filter = ctx.createBiquadFilter()
        filter.type = reference.type
        filter.frequency.value = reference.frequency.value
        filter.Q.value = reference.Q.value
        filter.gain.value = reference.gain.value
        previous.connect(filter)
        previous = filter
        stemFilters.push({ filter, reference })
      }
    }
    previous.connect(mixGain)
  }
  const onEqChanged = () => stemRack?.apply(loadEqState())
  if (stemRack && typeof window !== 'undefined') window.addEventListener('lokal:eq-changed', onEqChanged)
  let finished = false
  let startupTimer = null
  let preparedHandoff = false
  let expectedInternalSeek = null
  let playing = false
  let startupPaused = false

  const silenceClip = () => {
    mixGain.gain.cancelScheduledValues(ctx.currentTime)
    mixGain.gain.setValueAtTime(0,ctx.currentTime)
    try { element.pause() } catch {}
  }
  const detach = () => {
    if (startupTimer) clearTimeout(startupTimer)
    startupTimer = null
    element.removeEventListener('timeupdate', onProgress)
    element.removeEventListener('ended', complete)
    element.removeEventListener('error', abort)
    outgoing.removeEventListener('pause', mirrorPause)
    outgoing.removeEventListener('play', mirrorPlay)
    incoming.removeEventListener('pause', mirrorPause)
    incoming.removeEventListener('play', mirrorPlay)
    incoming.removeEventListener('seeking', onSeek)
    silenceClip()
    try { element.removeAttribute('src'); element.load() } catch {}
    try { source.disconnect(); mixGain.disconnect(); stemRack?.output.disconnect() } catch {}
    if (stemRack && typeof window !== 'undefined') window.removeEventListener('lokal:eq-changed', onEqChanged)
    for (const { filter } of stemFilters) {
      try { filter.disconnect() } catch {}
    }
    URL.revokeObjectURL(objectURL)
  }
  const complete = () => {
    if (finished) return
    finished = true
    try {
      if (!preparedHandoff) {
        expectedInternalSeek = clip.resumeIn
        incoming.currentTime = clip.resumeIn
      }
      const t = ctx.currentTime
      for (const fade of [outFade.gain, inFade.gain]) fade.cancelScheduledValues(t)
      outFade.gain.setValueAtTime(0,t)
      inFade.gain.setValueAtTime(1,t)
      incoming.playbackRate = 1
      incoming.play().catch(() => {})
    } catch {}
    detach()
    onFinish?.()
  }
  const abort = () => {
    if (finished) return
    finished = true
    const t = ctx.currentTime
    try {
      for (const fade of [outFade.gain,inFade.gain]) fade.cancelScheduledValues(t)
      outFade.gain.setValueAtTime(0,t)
      inFade.gain.setValueAtTime(1,t)
      incoming.playbackRate = 1
      incoming.play().catch(() => {})
    } catch {}
    detach()
    onAbort?.()
  }
  function onProgress() {
    if (finished || !playing) return
    const duration = element.duration
    if (!Number.isFinite(duration)) return
    // User EQ changes should still apply during the short third-deck window.
    for (const { filter, reference } of stemFilters) {
      if (filter.type !== reference.type) filter.type = reference.type
      for (const name of ['gain','frequency','Q']) {
        if (filter[name].value !== reference[name].value) {
          filter[name].setTargetAtTime(reference[name].value,ctx.currentTime,.025)
        }
      }
    }
    const left = duration - element.currentTime
    // The next track is pre-decoded and played quietly before the boundary,
    // then both decks are blended for 350 ms to hide codec seek jitter.
    if (left <= 0.45 && !preparedHandoff) {
      preparedHandoff = true
      try {
        expectedInternalSeek = Math.max(0, clip.resumeIn - Math.max(0, left))
        incoming.currentTime = expectedInternalSeek
        incoming.play().catch(() => {})
      } catch {}
      const now = ctx.currentTime
      const fade = Math.max(0.04,left)
      inFade.gain.cancelScheduledValues(now)
      inFade.gain.setValueAtTime(0, now)
      inFade.gain.linearRampToValueAtTime(1, now + fade)
      mixGain.gain.cancelScheduledValues(now)
      mixGain.gain.setValueAtTime(Math.max(0,mixGain.gain.value),now)
      mixGain.gain.linearRampToValueAtTime(0,now+fade)
    } else if (!preparedHandoff) {
      const now = ctx.currentTime
      mixGain.gain.setTargetAtTime(Math.max(0, getVolume()),now,.08)
    }
  }
  function mirrorPause() {
    if (finished) return
    startupPaused = true
    element.pause()
  }
  function mirrorPlay() {
    if (!finished && playing && element.paused) element.play().catch(abort)
  }
  function onSeek() {
    // Ignore only our own precise resume seek. A seek that produces no event
    // cannot consume the next *user* seek and leave the stem clip playing.
    if (expectedInternalSeek != null &&
        Math.abs(incoming.currentTime - expectedInternalSeek) < 0.05) {
      expectedInternalSeek = null
      return
    }
    expectedInternalSeek = null
    abort()
  }
  element.addEventListener('timeupdate',onProgress)
  element.addEventListener('ended',complete)
  element.addEventListener('error',abort)
  outgoing.addEventListener('pause',mirrorPause)
  outgoing.addEventListener('play',mirrorPlay)
  incoming.addEventListener('pause',mirrorPause)
  incoming.addEventListener('play',mirrorPlay)
  incoming.addEventListener('seeking',onSeek)

  return {
    element,
    async start() {
      if (finished) return false
      startupPaused = false
      try {
        // HTMLAudioElement.play() may never settle if the system's decoder
        // hangs while opening a damaged WAV. Bound this optional path, then
        // let the real incoming song play through instead of holding the
        // queue under a permanent crossfade lock.
        const startupDeadline = () => {
          if (finished) return
          if (startupPaused || outgoing.paused) {
            // User pause during decoder startup must not turn an elapsed
            // timeout into an unsolicited queue advance.
            startupTimer = setTimeout(startupDeadline, 5000)
          } else {
            abort()
          }
        }
        startupTimer = setTimeout(startupDeadline, 5000)
        await element.play() // Do not mute the real decks until audible.
        // A user may have paused while the decoder was opening the WAV.
        // Do not play through a completed asynchronous startup request.
        if (startupPaused || outgoing.paused) element.pause()
        if (startupTimer) clearTimeout(startupTimer)
        startupTimer = null
        if (finished) return false
        playing = true
        const now = ctx.currentTime
        // Both normal gain nodes must be open. The inactive deck normally
        // has main gain zero; opening only its fade node would leave the
        // actual incoming song silent at the stem-to-source handoff.
        for (const gain of [outGain.gain,inGain.gain]) {
          gain.cancelScheduledValues(now)
          gain.setValueAtTime(Math.max(0,getVolume()),now)
        }
        for(const fade of [outFade.gain,inFade.gain]) fade.cancelScheduledValues(now)
        outFade.gain.setValueAtTime(1,now)
        outFade.gain.linearRampToValueAtTime(0,now+.15)
        inFade.gain.setValueAtTime(0,now)
        mixGain.gain.setValueAtTime(0,now)
        mixGain.gain.linearRampToValueAtTime(Math.max(0,getVolume()),now+.15)
        return true
      } catch { abort(); return false }
    },
    stop() {
      if (finished) return
      finished = true
      detach()
    },
    complete, abort,
  }
}
