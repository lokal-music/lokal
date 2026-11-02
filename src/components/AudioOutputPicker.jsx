import OutputPrecisionSettings from './OutputPrecisionSettings'
import { useTranslation } from '../i18n'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Headphones, Volume2 } from 'lucide-react'
import { usePlayerStore } from '../store/player'
import { audioOutputSupported, listAudioOutputs, outputKind, outputLabel } from '../audioOutput'

function DeviceIcon({ kind }) {
  return kind === 'headphones' ? <Headphones size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />
}

function BrowserAudioOutputPicker() {
  const { t } = useTranslation()
  const outputDeviceId = usePlayerStore(state => state.outputDeviceId)
  const setOutputDevice = usePlayerStore(state => state.setOutputDevice)
  const [devices, setDevices] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selecting, setSelecting] = useState(null)
  const [error, setError] = useState('')
  const root = useRef(null)
  const refreshSeq = useRef(0)
  const supported = audioOutputSupported()

  const refresh = useCallback(async () => {
    if (!supported) return []
    const seq = ++refreshSeq.current
    setLoading(true)
    try {
      const found = await listAudioOutputs()
      const next = found.some(device => device.deviceId === 'default')
        ? found
        : [{ deviceId: 'default', label: t('System default'), kind: 'audiooutput' }, ...found]
      if (seq !== refreshSeq.current) return null
      setDevices(next)
      setError('')
      return next
    } catch (e) {
      if (seq !== refreshSeq.current) return null
      setError(t(e?.message || 'Could not list audio outputs'))
      return []
    } finally {
      if (seq === refreshSeq.current) setLoading(false)
    }
  }, [supported, t])

  useEffect(() => {
    refresh()
    const onDeviceChange = () => refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
  }, [refresh])

  useEffect(() => {
    if (!open) return undefined
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false) } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, refresh])

  const openPicker = async () => {
    const nextOpen = !open
    setOpen(nextOpen)
    // Chromium may expose only the default device until an explicit,
    // user-initiated output permission prompt has been completed.
    if (nextOpen && typeof navigator.mediaDevices?.selectAudioOutput === 'function') {
      const needsPermission = devices.every(device => device.deviceId === 'default' || !device.label)
      if (needsPermission) {
        setSelecting('permission')
        try {
          // Do not await device enumeration before this call: browsers require
          // selectAudioOutput to stay directly within the click gesture.
          const selected = await navigator.mediaDevices.selectAudioOutput()
          if (selected?.deviceId) {
            const apply = window.__lokalSetAudioOutput
            const result = typeof apply === 'function' ? await apply(selected.deviceId) : { ok: true, pending: true }
            if (result && !result.ok) throw new Error(result.error || t('Could not change audio output'))
            setOutputDevice(selected.deviceId)
          }
        } catch (e) {
          // Cancelling the native chooser is not an error; the custom menu remains
          // available with whatever outputs the browser has already disclosed.
          if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') setError(t(e?.message || 'Could not list audio outputs'))
        } finally {
          setSelecting(null)
        }
      }
    }
    if (nextOpen) await refresh()
  }

  const choose = async (device) => {
    const id = device.deviceId || 'default'
    setSelecting(id)
    setError('')
    try {
      const apply = window.__lokalSetAudioOutput
      const result = typeof apply === 'function' ? await apply(id) : { ok: true, pending: true }
      if (result && !result.ok) throw new Error(result.error || t('Could not change audio output'))
      setOutputDevice(id)
      setOpen(false)
    } catch (e) {
      setError(t(e?.message || 'Could not change audio output'))
    } finally {
      setSelecting(null)
    }
  }

  const current = devices.find(device => (device.deviceId || 'default') === outputDeviceId) || devices.find(device => (device.deviceId || 'default') === 'default')
  const currentLabel = current ? outputLabel(current) : t('Audio output')
  const currentKind = outputKind(currentLabel)

  return (
    <div ref={root} className="relative flex items-center justify-center">
      <button type="button" onClick={openPicker} disabled={!supported}
        aria-label={t('Audio output: {label}', { label: t(currentLabel) })} aria-expanded={open} aria-haspopup="menu"
        title={supported ? t('Audio output: {label}', { label: t(currentLabel) }) : t('Audio output selection is unavailable')}
        className={`transition-[color,transform] hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent ${open || outputDeviceId !== 'default' ? 'text-accent' : 'text-text/90 hover:text-accent'} disabled:cursor-not-allowed disabled:opacity-40`}>
        <DeviceIcon kind={currentKind} />
      </button>
      {open && (
        <div role="menu" aria-label={t("Audio output")} className="absolute bottom-full right-0 z-30 mb-2 w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-elevated p-2 shadow-2xl">
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="text-xs font-display uppercase tracking-wider text-muted">{t("Audio output")}</p>
            {loading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />}
          </div>
          <div className="space-y-0.5">
            {devices.map((device, index) => {
              const label = outputLabel(device, index)
              const kind = outputKind(label)
              const id = device.deviceId || 'default'
              const selected = outputDeviceId === id
              return (
                <button key={device.deviceId || `output-${index}`} type="button" role="menuitemradio" aria-checked={selected}
                  disabled={selecting !== null} onClick={() => choose(device)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${selected ? 'bg-accent/15 text-accent' : 'text-text hover:bg-card'} disabled:opacity-50`}>
                  <DeviceIcon kind={kind} />
                  <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
                  {selected && <span className="text-[10px] uppercase tracking-wider">{t("Current")}</span>}
                </button>
              )
            })}
          </div>
          {!devices.length && !loading && <p className="px-2 py-2 text-xs text-muted">{t("No audio outputs detected.")}</p>}
          {error && <p role="alert" className="px-2 pt-2 text-xs text-red-400">{t(error)}</p>}
          <p className="border-t border-border px-2 pt-2 text-[11px] leading-relaxed text-muted">{t("Choose the Windows speaker or headset to use for Lokal.")}</p>
        </div>
      )}
    </div>
  )
}

export default function AudioOutputPicker() {
  const { t } = useTranslation()
  const [native, setNative] = useState(() => window.__lokalOutputStatus?.mode === 'native')
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  useEffect(() => {
    const update = event => setNative(event.detail.mode === 'native')
    window.addEventListener('lokal:output-status', update)
    return () => window.removeEventListener('lokal:output-status', update)
  }, [])
  useEffect(() => {
    if (!open) return
    const close = event => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !root.current?.contains(event.target))) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [open])
  if (!native) return <BrowserAudioOutputPicker />
  return (
    <div ref={root} className="relative flex items-center justify-center">
      <button type="button" onClick={() => setOpen(value => !value)} aria-label={t("Native audio output")} aria-expanded={open} className="text-accent transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent">
        <Volume2 size={14} />
      </button>
      {open && <div className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-elevated p-2 shadow-2xl">
        <OutputPrecisionSettings compact />
      </div>}
    </div>
  )
}
