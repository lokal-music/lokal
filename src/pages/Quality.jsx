// Audio Quality: what the library is made of (hi-res, lossless, high and low
// bitrate lossy files), lossless files that were made from lossy ones (the
// spectrum check), and a list of what's worth getting again in lossless.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AudioWaveform, Download, Gem, Loader2, Play, RefreshCw, ScanLine, Square } from 'lucide-react'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { peekCache, useCachedState, usePageReady, writeCache } from '../pageCache'
import AnimatedNumber from '../components/AnimatedNumber'
import SectionSwap, { ReadyWhen } from '../components/SectionSwap'
import { usePlayerStore } from '../store/player'
import { TIERS, canGetLossless, formatLabel, isSuspect, openLossless, openLosslessMany, tierOf, verdictText } from '../quality'
import { canBulkUpgradeQuality, collectQualityUpgradeTracks } from '../qualityBulk'

// Worst to best after "Worth upgrading".
const FILTERS = [
  ['upgradable', 'Worth upgrading'],
  ['suspect', 'Suspect'],
  ['low', 'Low'],
  ['high', 'High'],
  ['lossless', 'Lossless'],
  ['hires', 'Hi-res'],
  ['atmos', 'Dolby Atmos'],
]
const FILTER_IDS = new Set(FILTERS.map(([id]) => id))
const PAGE = 200

// Every tile has the same rows, each one line high (badge, number, share,
// description), so the badges, numbers and texts line up across the row.
function StatTile({ tier, count, share, active, onClick, rollFrom }) {
  const { t } = useTranslation()
  const info = TIERS[tier]
  return (
    <button onClick={onClick} title={t(info.hint)}
      className={`flex h-full min-w-0 flex-col items-start justify-start gap-1.5 rounded-2xl border p-3 text-left transition-colors @4xl:px-2.5 ${active ? 'border-accent/50 bg-accent/10' : 'border-border bg-card/50 hover:bg-card'}`}>
      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase leading-4 tracking-wide ${info.className}`}>{t(info.label)}</span>
      <AnimatedNumber value={count} from={rollFrom} className="mt-1 font-display text-2xl leading-8 tabular-nums text-white" />
      <span className="w-full truncate text-[11px] leading-4 text-muted/80 tabular-nums">{share}</span>
      <span className="w-full min-h-8 line-clamp-2 text-[11px] leading-4 text-muted">{t(info.desc)}</span>
    </button>
  )
}

export default function Quality() {
  const { t } = useTranslation()
  // Kept across visits: coming back shows the numbers as they were (and they
  // roll to any new value); the first visit counts them up from zero.
  const [summary, setSummary, summaryWasCached] = useCachedState('quality:summary', null)
  const [job, setJob] = useState({ running: false })
  // The player bar's quality badge opens this page on that badge's list
  // (navigation state { tier }). Applied before the first render, so the
  // page doesn't show the last list first and then switch.
  const location = useLocation()
  const linkedTier = FILTER_IDS.has(location.state?.tier) ? location.state.tier : null
  const appliedLinkRef = useRef(null)
  if (linkedTier && appliedLinkRef.current !== location.key && peekCache('quality:filter') !== linkedTier) writeCache('quality:filter', linkedTier)
  const [filter, setFilter] = useCachedState('quality:filter', linkedTier || 'upgradable')
  // Already on this page when the badge is clicked: switch to its list.
  useEffect(() => {
    if (!linkedTier || appliedLinkRef.current === location.key) return
    appliedLinkRef.current = location.key
    ++bulkRequestRef.current
    setBulkLoading(null)
    setFilter(linkedTier)
  }, [linkedTier, location.key, setFilter])
  const [rows, setRowsState] = useState(() => peekCache(`quality:rows:${filter}`) || [])
  const [rowsLoaded, setRowsLoaded] = useState(() => !!peekCache(`quality:rows:${filter}`))
  // The filter the rows on screen belong to: a switched-to filter shows (and
  // plays) nothing of another's while its own rows load.
  const [rowsFor, setRowsFor] = useState(() => (peekCache(`quality:rows:${filter}`) ? filter : null))
  const [rowsError, setRowsError] = useState('')
  const [loading, setLoading] = useState(false)
  // Only the latest list request (the filter selected now) is applied.
  const rowsRequestRef = useRef(0)
  usePageReady(!!summary && rowsLoaded)
  const [message, setMessage] = useState('')
  const [bulkLoading, setBulkLoading] = useState(null) // { tier, scanned, eligible }
  const bulkRequestRef = useRef(0)
  const selectQualityFilter = tier => {
    ++bulkRequestRef.current
    setBulkLoading(null)
    setFilter(tier)
  }
  const playQueue = usePlayerStore(s => s.playQueue)
  const pollRef = useRef(null)
  const wasRunning = useRef(false)

  // A failed read still lets the page show (with zeros) instead of waiting on it.
  const loadSummary = useCallback(() => Promise.resolve(api.qualitySummary()).then(s => { if (s && !s.error) setSummary(s); else setSummary(prev => prev || {}) }).catch(() => setSummary(prev => prev || {})), [setSummary])
  const loadRows = useCallback(async () => {
    const request = ++rowsRequestRef.current
    // Switching filter shows that filter's last list at once, or none at all
    // (never another filter's rows under this filter's name).
    const seen = peekCache(`quality:rows:${filter}`)
    setRowsState(seen || [])
    setRowsFor(seen ? filter : null)
    setRowsError('')
    setLoading(true)
    const list = await Promise.resolve(api.qualityList({ tier: filter, limit: PAGE })).catch(e => ({ error: e?.message }))
    if (request !== rowsRequestRef.current) return
    if (Array.isArray(list)) {
      writeCache(`quality:rows:${filter}`, list)
      // The quiet refresh of a list already shown usually brings the same
      // rows: re-rendering 200 of them then (mid fade-in) only costs frames.
      if (!(seen && JSON.stringify(seen) === JSON.stringify(list))) setRowsState(list)
      setRowsFor(filter)
    } else {
      // A failed request keeps this filter's cached rows, and says so.
      setRowsError(list?.error || 'Could not load this list')
    }
    setRowsLoaded(true)
    setLoading(false)
  }, [filter])
  // The poll loop outlives filter switches: it reloads the filter shown now.
  const loadRowsRef = useRef(loadRows)
  useLayoutEffect(() => { loadRowsRef.current = loadRows }, [loadRows])

  // Poll the background job (reading details / checking spectra) while it runs.
  const poll = useCallback(async () => {
    clearTimeout(pollRef.current)
    const s = await Promise.resolve(api.qualityStatus()).catch(() => null)
    if (s && !s.error) setJob(s)
    if (s?.running) {
      wasRunning.current = true
      pollRef.current = setTimeout(poll, 1000)
      if (s.done % 25 === 0) loadSummary()
    } else if (wasRunning.current) {
      wasRunning.current = false
      loadSummary()
      loadRowsRef.current()
    }
  }, [loadSummary])

  useEffect(() => { loadSummary(); poll(); return () => clearTimeout(pollRef.current) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadRows() }, [loadRows])

  // Once the page is up, fetch the other filters' lists in the background
  // (one at a time), so switching filter shows its rows at once.
  const pageUp = !!summary && rowsLoaded
  useEffect(() => {
    if (!pageUp) return
    let cancelled = false
    ;(async () => {
      for (const [tier] of FILTERS) {
        if (cancelled) return
        if (peekCache(`quality:rows:${tier}`)) continue
        await new Promise(r => setTimeout(r, 150))
        if (cancelled) return
        const list = await Promise.resolve(api.qualityList({ tier, limit: PAGE })).catch(() => null)
        if (Array.isArray(list) && !peekCache(`quality:rows:${tier}`)) writeCache(`quality:rows:${tier}`, list)
      }
    })()
    return () => { cancelled = true }
  }, [pageUp])
  useEffect(() => {
    const refresh = () => { loadSummary(); loadRows() }
    window.addEventListener('lokal:quality-changed', refresh)
    window.addEventListener('lokal:refresh', refresh)
    return () => { window.removeEventListener('lokal:quality-changed', refresh); window.removeEventListener('lokal:refresh', refresh) }
  }, [loadSummary, loadRows])

  const start = async (fn) => {
    setMessage('')
    const r = await Promise.resolve(fn()).catch(e => ({ error: e.message }))
    if (r?.error) setMessage(r.error)
    poll()
  }

  // The visible Quality table only contains PAGE (200) rows. Fetch the full
  // selected tier before handing the eligible originals to the existing
  // review-and-replace dialog. Never auto-replace files on a button press.
  const getAllLossless = async () => {
    if (bulkLoading) return
    const tier = filter
    const token = ++bulkRequestRef.current
    const isCurrent = () => bulkRequestRef.current === token
    setMessage('')
    setBulkLoading({ tier, scanned: 0, eligible: 0 })
    try {
      const eligible = await collectQualityUpgradeTracks(api.qualityList, tier, {
        isCurrent,
        onProgress: progress => {
          if (isCurrent()) setBulkLoading({ tier, ...progress })
        },
      })
      if (!isCurrent() || !eligible) return
      if (eligible.length) openLosslessMany(eligible)
      else setMessage(t('No tracks in this category need a lossless upgrade.'))
    } catch (error) {
      if (isCurrent()) setMessage(error?.message || t('Could not load songs for lossless upgrades.'))
    } finally {
      if (isCurrent()) setBulkLoading(null)
    }
  }

  // A filter change or page exit cancels stale pagination results; ongoing
  // IPC requests may finish, but can no longer open a dialog for another tab.
  useEffect(() => () => { ++bulkRequestRef.current }, [filter])

  const tiers = summary?.tiers || {}
  const total = summary?.total || 0
  const unread = tiers.unknown || 0
  const running = job.running
  const known = total - unread
  const checked = (tiers.hires || 0) + (tiers.lossless || 0) - (summary?.unchecked || 0)
  // Tiers: share of the tracks read. Suspect: out of the lossless files checked.
  const rollFrom = (n) => (summaryWasCached ? n : 0)
  const shareText = (tier) => {
    if (tier === 'suspect') return checked > 0 ? <>of <AnimatedNumber value={checked} from={rollFrom(checked)} /> checked</> : 'Not checked yet'
    if (!known) return '—'
    const pct = Math.round(((tiers[tier] || 0) / known) * 100)
    return <><AnimatedNumber value={pct} from={rollFrom(pct)} />% of tracks</>
  }

  return (
    <div className="w-full max-w-5xl mx-auto space-y-6 px-4 pb-12 pt-6">
      <section className="rounded-[24px] border border-border bg-card/60 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <AudioWaveform size={18} className="text-accent" />
          <h1 className="font-display text-lg uppercase tracking-[0.28em] text-white">{t("Quality")}</h1>
          <span className="text-xs text-muted tabular-nums"><AnimatedNumber value={total} from={rollFrom(total)} /> {t("tracks")}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {running ? (
              <>
                <span className="flex items-center gap-2 text-xs text-muted">
                  <Loader2 size={13} className="animate-spin" />
                  {job.kind === 'check' ? t('Checking spectra') : t('Reading file details')} · {job.done.toLocaleString()} / {job.total.toLocaleString()}
                </span>
                <button onClick={() => start(api.qualityCancel)} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-white">
                  <Square size={11} /> {t("Stop")}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => start(() => api.qualityRead({ all: !unread }))}
                  title={unread ? t('Read codec, bitrate, sample rate, bit depth and ISRC of the tracks indexed before Lokal kept them') : t('Read every file again')}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-white">
                  <RefreshCw size={12} /> {unread ? `${t("Read details of")} ${unread.toLocaleString()} ${t("tracks")}` : t("Read all again")}
                </button>
                <button onClick={() => start(() => api.qualityCheck({}))} disabled={!summary?.unchecked}
                  title={t("Look at the spectrum of lossless files to spot ones made from MP3/AAC (needs ffmpeg, about 1.5 s a file)")}
                  className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-[rgb(var(--bg-rgb))] hover:bg-accent/80 disabled:opacity-40">
                  <ScanLine size={12} /> {summary?.unchecked ? `${t("Check")} ${summary.unchecked.toLocaleString()} ${t("lossless files")}` : t("All lossless files checked")}
                </button>
              </>
            )}
          </div>
        </div>
        {message && <p className="mt-3 rounded-xl border border-red/25 bg-red/10 px-3 py-2 text-xs text-red">{message}</p>}
        {unread > 0 && !running && (
          <p className="mt-3 text-xs text-muted">{unread.toLocaleString()} {t("tracks were added before Lokal kept their format: read their details to see them here.")}</p>
        )}

        {/* Six metrics: 2×3 on phones, 3×2 on medium layouts, a single
            balanced row on wide desktops. Never leave Suspect orphaned. */}
        <div className="mt-4 grid grid-cols-2 gap-2 @sm:grid-cols-3 @4xl:grid-cols-6">
          {['atmos', 'hires', 'lossless', 'high', 'low', 'suspect'].map(tier => (
            <StatTile key={tier} tier={tier} count={tiers[tier]} rollFrom={rollFrom(tiers[tier] || 0)} share={shareText(tier)} active={filter === tier} onClick={() => selectQualityFilter(tier)} />
          ))}
        </div>
      </section>

      <section className="rounded-[24px] border border-border bg-card/60 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {FILTERS.map(([id, label]) => (
            <button key={id} onClick={() => selectQualityFilter(id)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${filter === id ? 'bg-accent/15 text-accent border border-accent/30' : 'border border-border text-muted hover:text-white'}`}>
              {t(label)}{id === 'upgradable' && tiers.upgradable ? ` · ${tiers.upgradable.toLocaleString()}` : ''}
            </button>
          ))}
          {rows.length > 0 && rowsFor === filter && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {canBulkUpgradeQuality(filter, rows) && (
                <button type="button" onClick={getAllLossless} disabled={!!bulkLoading}
                  title={t("Find lossless replacements for every eligible song in this quality category")}
                  className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50">
                  {bulkLoading?.tier === filter
                    ? <Loader2 size={11} className="animate-spin" />
                    : <Download size={11} />}
                  {bulkLoading?.tier === filter
                    ? t('Finding {count} songs…', { count: bulkLoading.scanned.toLocaleString() })
                    : t('Get all in lossless')}
                </button>
              )}
              <button type="button" onClick={() => playQueue(rows, 0, { type: 'quality', id: filter, name: `Audio quality: ${FILTERS.find(f => f[0] === filter)?.[1]}` })}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted hover:text-white">
                <Play size={11} fill="currentColor" /> {t("Play these")}
              </button>
            </div>
          )}
        </div>
        {/* Switching filter: the new list fades in once its rows are in (not the
            previous filter's rows, then "Loading…", then the new ones). */}
        <SectionSwap id={filter} gated>
        <ReadyWhen ready={rowsFor === filter || !!rowsError} />
        {filter === 'upgradable' && <p className="mb-3 text-xs text-muted">{t("Lossy files, and lossless files the spectrum check found were made from lossy ones. Lowest quality first.")}</p>}

        {loading && rowsFor !== filter && <p className="flex items-center gap-2 py-6 text-xs text-muted"><Loader2 size={13} className="animate-spin" /> {t('Loading…')}</p>}
        {rowsError && (
          <p className="flex items-center gap-2 py-3 text-xs text-red">
            {t("Couldn't load this list")} ({rowsError}).
            <button onClick={loadRows} className="rounded-full border border-border px-2.5 py-0.5 text-muted hover:text-white">{t("Retry")}</button>
          </p>
        )}
        {rowsFor === filter && !loading && !rowsError && !rows.length && <p className="py-6 text-center text-xs text-muted">{t("Nothing here.")}</p>}

        <div className="space-y-0.5">
          {rowsFor === filter && rows.map((track, i) => {
            const tier = isSuspect(track) ? 'suspect' : tierOf(track)
            const info = TIERS[tier]
            const verdict = verdictText(track)
            return (
              <div key={track.id} onDoubleClick={() => playQueue(rows, i, { type: 'quality', id: filter, name: 'Audio quality' })}
                className="group grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-elevated"
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 48px' }}>
                <div className="min-w-0">
                  <p className="truncate text-sm text-white">{track.title}</p>
                  <p className="truncate text-xs text-muted" title={verdict || undefined}>
                    {track.artist}{track.album ? ` · ${track.album}` : ''}
                    {tier === 'suspect' && track.spectral_cutoff ? <span className="text-red/80"> · nothing above {track.spectral_cutoff / 1000} kHz</span> : null}
                  </p>
                </div>
                {/* Fixed-width columns: the format, badge and button sit at the
                    same place on every row and in every list (sized to their
                    content they moved with each list's widest format). */}
                <div className="grid grid-cols-[4.75rem_auto] items-center gap-2.5 @sm:grid-cols-[10rem_4.75rem_auto]">
                  <span className="hidden truncate text-right text-[11px] text-muted tabular-nums @sm:block" title={formatLabel(track)}>{formatLabel(track)}</span>
                  <span className={`justify-self-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${info.className}`}>{info.label}</span>
                  {canGetLossless(track) && (
                    <button onClick={() => openLossless(track)} title={t("Get it in lossless")}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-muted opacity-70 transition-all hover:text-accent group-hover:opacity-100">
                      <Gem size={12} /> Lossless
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {rowsFor === filter && rows.length === PAGE && <p className="mt-3 text-center text-[11px] text-muted">{t("Showing the first")} {PAGE}.</p>}
        </SectionSwap>
      </section>
    </div>
  )
}
