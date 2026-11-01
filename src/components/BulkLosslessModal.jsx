// "Get it in lossless" for several songs at once (right-click a selection):
// each song is looked up on your addon sources, the closest lossless copy is
// suggested (ticked when its length matches), and "Replace" downloads the
// ticked ones, each replacing its song's file while keeping its playlists,
// likes and plays. "More" opens the one-song dialog (stores, Soulseek).
// Opened from anywhere with openLosslessMany(tracks) (src/quality.js).

import { useTranslation } from '../i18n'
import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Blocks, Check, Download, Loader2 } from 'lucide-react'
import Modal from './Modal'
import AddonSetupNotice from './AddonSetupNotice'
import { api } from '../api'
import { formatLabel, openLossless } from '../quality'
import { downloadGhostResult } from '../ghostDownloads'
import { mapLimited } from '../recommendations'
import { bestReplacement, losslessCandidates, replacementSources, searchReplacements } from '../losslessReplacements'
import { plural } from '../plural'

const SEARCHES_AT_ONCE = 3
const REVIEW_ROWS_PER_PAGE = 100
const fmtTime = s => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`

export default function BulkLosslessModal() {
  const { t } = useTranslation()
  const [batch, setBatch] = useState(null) // { eligible, skipped }
  const [sources, setSources] = useState(null) // null: loading; { usable, setup }
  const [rows, setRows] = useState({}) // id -> { status: 'searching' | 'found' | 'none', match, checked, result, error }
  const [replacing, setReplacing] = useState(false)
  const [visibleCount, setVisibleCount] = useState(REVIEW_ROWS_PER_PAGE)
  const run = useRef(0)

  useEffect(() => {
    const open = (event) => {
      const tracks = Array.isArray(event.detail) ? event.detail : []
      if (tracks.length) {
        setVisibleCount(REVIEW_ROWS_PER_PAGE)
        setBatch(losslessCandidates(tracks))
      }
    }
    window.addEventListener('lokal:lossless-many', open)
    return () => window.removeEventListener('lokal:lossless-many', open)
  }, [])

  // Looks every song up, a few at a time; closing the dialog stops it.
  useEffect(() => {
    if (!batch) return undefined
    const token = ++run.current
    const current = () => run.current === token
    setSources(null); setRows({}); setReplacing(false)
    ;(async () => {
      const found = await replacementSources(api)
      if (!current()) return
      setSources(found)
      if (!found.usable.length) return
      await mapLimited(batch.eligible, async track => {
        if (!current()) return
        setRows(state => ({ ...state, [track.id]: { status: 'searching' } }))
        const groups = await searchReplacements(track, found.usable, api)
        if (!current()) return
        const match = bestReplacement(track, groups)
        const error = !match && groups.every(group => group.error) ? groups[0]?.error : ''
        setRows(state => ({ ...state, [track.id]: match ? { status: 'found', match, checked: match.checked } : { status: 'none', error } }))
      }, SEARCHES_AT_ONCE)
    })()
    return () => { run.current++ }
  }, [batch])

  const close = () => { run.current++; setBatch(null) }
  if (!batch) return <Modal open={false} onClose={close} />

  const { eligible, skipped } = batch
  const searched = eligible.filter(track => ['found', 'none'].includes(rows[track.id]?.status)).length
  const searching = !!sources?.usable.length && searched < eligible.length
  // A failed one can be ticked and tried again; a started one is done.
  const started = track => rows[track.id]?.result === 'queued'
  const ticked = eligible.filter(track => rows[track.id]?.checked && !started(track))
  const withMatch = eligible.filter(track => rows[track.id]?.status === 'found' && !started(track))
  const matches = eligible.filter(track => rows[track.id]?.status === 'found').length
  const queued = eligible.filter(started).length
  const allTicked = withMatch.length > 0 && withMatch.every(track => rows[track.id].checked)

  const setChecked = (id, checked) => setRows(state => ({ ...state, [id]: { ...state[id], checked } }))
  const tickAll = (checked) => setRows(state => {
    const next = { ...state }
    for (const track of withMatch) next[track.id] = { ...next[track.id], checked }
    return next
  })

  // You ticked it: a different length is already agreed to.
  const replace = async () => {
    const token = run.current
    setReplacing(true)
    try {
      for (const track of ticked) {
        if (run.current !== token) return
        const { match } = rows[track.id]
        // Closing the dialog stops the one being started too, not only the ones after it.
        const result = await downloadGhostResult({ ...track, missing: true }, match.item, { confirmDuration: () => true, isCurrent: () => run.current === token }).catch(error => ({ error: error.message }))
        if (run.current !== token) return
        setRows(state => ({ ...state, [track.id]: { ...state[track.id], checked: false, result: result?.error ? 'failed' : result?.cancelled ? undefined : 'queued', error: result?.error || '' } }))
      }
    } finally {
      setReplacing(false)
    }
  }

  return (
    <Modal open onClose={close} title={`Get ${plural(eligible.length, 'song')} in lossless`} width="max-w-2xl">
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted">
          Each song is looked up on your addon sources. The closest lossless copy is ticked when its length matches yours; tick the others yourself if they're right.
          Replacing downloads them, and each one replaces its song's file, keeping its playlists, likes and plays.
          {skipped > 0 && ` ${plural(skipped, 'selected song')} ${skipped === 1 ? 'is' : 'are'} left out (already lossless, streamed or missing).`}
        </p>

        {sources?.setup.map(source => <AddonSetupNotice key={source.id} source={source} />)}
        {sources && !sources.usable.length && !sources.setup.length && (
          <p className="rounded-xl border border-border bg-card/40 px-3 py-2.5 text-xs text-muted">{t("No addon sources installed. Add one in Settings → Addons to upgrade songs from it, or use More on a song for stores and Soulseek.")}</p>
        )}

        {!!eligible.length && (
          <div className="flex items-center gap-3 text-[11px] text-muted">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {sources === null || searching ? <><Loader2 size={11} className="animate-spin" />Searching {searched}/{eligible.length}…</> : sources.usable.length ? `${plural(matches, 'match', 'matches')} found for ${plural(eligible.length, 'song')}` : ''}
            </span>
            {withMatch.length > 0 && (
              <button type="button" onClick={() => tickAll(!allTicked)} className="flex-shrink-0 hover:text-white">{allTicked ? t('Untick all') : t('Tick all')}</button>
            )}
          </div>
        )}

        <div className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
          {!eligible.length && <p className="py-6 text-center text-sm text-muted">{t("None of these songs can be upgraded: they're already lossless, streamed or missing.")}</p>}
          {eligible.slice(0, visibleCount).map(track => {
            const row = rows[track.id] || {}
            const match = row.match
            return (
              <div key={track.id} className="flex items-center gap-3 rounded-xl border border-border bg-card/50 px-3 py-2">
                <input type="checkbox" checked={!!row.checked} disabled={!match || row.result === 'queued' || replacing}
                  onChange={event => setChecked(track.id, event.target.checked)}
                  aria-label={`Replace ${track.title}`} className="h-3.5 w-3.5 flex-shrink-0 accent-[rgb(var(--accent-rgb))] disabled:opacity-30" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">{track.title}<span className="text-muted"> · {track.artist}</span></p>
                  <p className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-muted">
                    <span className="flex-shrink-0">{formatLabel(track) || 'Quality not read'}</span>
                    <span className="flex-shrink-0 text-muted/50">→</span>
                    {row.status === 'searching' || (!row.status && sources?.usable.length) ? <span className="inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" />{t("Searching")}</span>
                      : match ? <span className="inline-flex min-w-0 items-center gap-1 truncate">
                          {match.source.icon ? <img src={match.source.icon} alt="" className="h-3 w-3 flex-shrink-0 rounded-sm object-cover" referrerPolicy="no-referrer" /> : <Blocks size={10} className="flex-shrink-0 text-accent" />}
                          <span className="truncate">{[match.source.label, match.item.quality, match.item.duration ? fmtTime(match.item.duration) : ''].filter(Boolean).join(' · ')}</span>
                          {match.lengthUnknown && <span className="flex-shrink-0 text-muted" title={t("This copy's length (or yours) isn't known: check it before ticking")}>{t("· length unknown")}</span>}
                          {match.lengthDiffers && <span className="inline-flex flex-shrink-0 items-center gap-0.5 text-yellow-200" title={`This copy is ${fmtTime(match.item.duration)} long; yours is ${fmtTime(track.duration)}`}><AlertTriangle size={10} />{t("length differs")}</span>}
                        </span>
                      : row.status === 'none' ? <span className="truncate">{row.error || 'No close match on your addon sources'}</span>
                      : null}
                  </p>
                </div>
                {row.result === 'queued' ? <span className="inline-flex flex-shrink-0 items-center gap-1 text-[11px] text-accent"><Check size={12} />{t("Downloading")}</span>
                  : row.result === 'failed' ? <span className="max-w-[9rem] flex-shrink-0 truncate text-[11px] text-red" title={row.error}>{row.error || 'Failed'}</span>
                  : null}
                <button type="button" onClick={() => openLossless(track)} title={t("Stores, Soulseek and every match for this song")}
                  className="flex-shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] text-muted hover:border-accent/40 hover:text-white">{t("More")}</button>
              </div>
            )
          })}
          {eligible.length > visibleCount && (
            <div className="flex items-center justify-center gap-3 py-3 text-xs text-muted">
              <span>{t('Showing {shown} of {total}', { shown: visibleCount.toLocaleString(), total: eligible.length.toLocaleString() })}</span>
              <button type="button" onClick={() => setVisibleCount(count => count + REVIEW_ROWS_PER_PAGE)}
                className="rounded-lg border border-border px-3 py-1.5 hover:border-accent/40 hover:text-white">
                {t('Show next {count}', { count: Math.min(REVIEW_ROWS_PER_PAGE, eligible.length - visibleCount) })}
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border pt-3">
          {queued > 0 && <p className="mr-auto text-[11px] text-muted">{plural(queued, 'download')} started. Each song is replaced when its download finishes.</p>}
          <button type="button" onClick={close} className="rounded-lg px-3 py-2 text-xs text-muted hover:text-white">{queued ? 'Done' : 'Cancel'}</button>
          <button type="button" onClick={replace} disabled={!ticked.length || replacing}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[rgb(var(--bg-rgb))] disabled:opacity-40">
            {replacing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {ticked.length ? `Replace ${plural(ticked.length, 'song')}` : 'Replace'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

