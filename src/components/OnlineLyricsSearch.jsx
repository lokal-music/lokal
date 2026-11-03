import React, { useEffect, useRef, useState } from 'react'
import LyricsSearchResult from './LyricsSearchResult'
import { lyricsSearchSnippet } from '../lyricsSearchSnippet.mjs'
import { useTranslation } from '../i18n'
import { playRecommendationPool } from '../recommendationPlayback'
import { showLoadingToast, showToast } from './Toaster'

/** LRCLIB has lyric-record search by title, artist and album; it does NOT
 * index lyric-line text. Never pretend a keyword search checked the words
 * inside the lyrics. Only show records containing actual lyrics. */
export default function OnlineLyricsSearch({ query }) {
  const { t } = useTranslation()
  const q = String(query || '').trim()
  const [records, setRecords] = useState([])
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    const id = ++seq.current
    const abort = new AbortController()
    setRecords([]); setError('')
    if (q.length < 2) { setStatus('idle'); return () => abort.abort() }
    setStatus('loading')
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q.slice(0, 120))}`, {
          signal: abort.signal,
          headers: { Accept: 'application/json', 'Lrclib-Client': 'Lokal desktop (https://github.com/lokal-music/Desktop)' },
        })
        if (!response.ok) throw new Error(response.status === 429
          ? 'Lyrics provider is rate-limiting searches. Try later.'
          : 'Online lyrics catalogue unavailable.')
        const rows = await response.json()
        if (seq.current !== id) return
        setRecords((Array.isArray(rows) ? rows : [])
          .filter(r => !r.instrumental && r.trackName && r.artistName &&
            (r.plainLyrics || r.syncedLyrics))
          .slice(0, 20))
        setStatus('ready')
      } catch (e) {
        if (seq.current !== id || abort.signal.aborted) return
        setError(e?.message || 'Online lyrics unavailable.')
        setStatus('error')
      }
    }, 350)
    return () => { clearTimeout(timer); abort.abort(); seq.current++ }
  }, [q])

  const play = async record => {
    if (playing) return
    setPlaying(true)
    const toast = showLoadingToast('Finding “' + record.trackName + '” through your playback sources…')
    try {
      const candidates = records.map(row => ({
        id: 'lrclib:' + row.id,
        title: row.trackName, artist: row.artistName,
        album: row.albumName || '', duration: Number(row.duration) || 0,
      }))
      const selected = candidates.find(row => row.id === 'lrclib:' + record.id)
      if (!selected) throw new Error('Selected lyric record is no longer in the results.')
      // Playback matches metadata and can collapse the same title/artist across
      // album editions. Put the clicked record first so its album wins.
      const ordered = [selected, ...candidates.filter(row => row.id !== selected.id)]
      const ok = await playRecommendationPool(ordered, {
        selected, context: { type: 'global', id: q, name: 'Online lyrics: ' + q }, returnAfterStart: true,
      })
      toast.close()
      if (ok === false) showToast('Could not resolve this song through playback sources.')
    } catch (e) {
      toast.close()
      showToast(e?.message || 'Could not start playback.')
    } finally { setPlaying(false) }
  }

  if (q.length < 2) return null
  return <section className="space-y-2">
    <h2 className="text-xs font-display uppercase tracking-widest text-white">Online lyrics</h2>
    <p className="text-[11px] text-muted">LRCLIB · lyrics records searched by song, artist and album name (not lyric-line text)</p>
    {status === 'loading' && <p role="status" className="text-xs text-muted">Searching online lyrics…</p>}
    {status === 'error' && <p role="alert" className="text-xs text-muted">{error}</p>}
    {status === 'ready' && !records.length && <p className="text-xs text-muted">No matching lyrics records found.</p>}
    <div className="space-y-2">
      {records.map((row, index) => <LyricsSearchResult
        key={row.id} title={row.trackName} artist={row.artistName} album={row.albumName}
        snippet={lyricsSearchSnippet(row, q)} index={index} playLabel={t('Play')}
        disabled={playing} onPlay={() => play(row)}
      />)}
    </div>
  </section>
}
