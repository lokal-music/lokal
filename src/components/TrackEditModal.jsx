import { useTranslation } from '../i18n'
import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Camera, Save, RefreshCw, Check, AlertCircle } from 'lucide-react'
import { api } from '../api'
import Modal from './Modal'
import GenreValueInput from './GenreValueInput'
import { usePlayerStore } from '../store/player'
import { clipVideoLink, formatClipTime, parseClipTime } from '../clipVideo'

function asInput(value) {
  return value === null || value === undefined ? '' : String(value)
}

function normalizeGenres(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .join(', ')
}

function parseIntegerField(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return null
  const parsed = parseInt(trimmed, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function parseNumberField(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return null
  const parsed = parseFloat(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

function trackArtworkPreview(track) {
  if (!track?.artwork_path) return null
  return api.isElectron ? api.fileURL(track.artwork_path) : api.artworkURL(track.id)
}

export default function TrackEditModal({ track, open, onClose, onSave }) {
  const { t } = useTranslation()
  const syncTrack = usePlayerStore(s => s.syncTrack)
  const [formData, setFormData] = useState({
    title: '',
    artist: '',
    album: '',
    album_artist: '',
    track_num: '',
    year: '',
    genre: '',
    genres: '',
    record_label: '',
    explicit: false,
    instrumental: '',
    danceability: '',
    energy: '',
    track_key: '',
    loudness: '',
    mode: '',
    speechiness: '',
    acousticness: '',
    instrumentalness: '',
    liveness: '',
    valence: '',
    tempo: '',
    time_signature: '',
    clip_url: '',
    clip_start: '',
    clip_end: '',
  })
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null)
  const [artworkPreview, setArtworkPreview] = useState(null)
  const [genreOptions, setGenreOptions] = useState([])
  const [fileSizeBytes, setFileSizeBytes] = useState(null)

  useEffect(() => {
    if (!open || !track?.id || !api.isElectron) {
      setFileSizeBytes(null)
      return undefined
    }
    let active = true
    const refresh = () => {
      Promise.resolve(api.getTrackFileSize(track.id))
        .then(result => {
          if (active) {
            const bytes = Number(result?.bytes)
            setFileSizeBytes(Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null)
          }
        })
        .catch(() => { if (active) setFileSizeBytes(null) })
    }
    refresh()
    window.addEventListener('lokal:refresh', refresh)
    return () => {
      active = false
      window.removeEventListener('lokal:refresh', refresh)
    }
  }, [open, track?.id])

  useEffect(() => {
    if (!open) return
    let active = true
    api.getAllGenres().then((result) => {
      if (!active) return
      setGenreOptions(Array.isArray(result) ? result : [])
    }).catch(() => {
      if (active) setGenreOptions([])
    })
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (track) {
      setFormData({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        album_artist: track.album_artist || '',
        track_num: asInput(track.track_num),
        year: asInput(track.year),
        genre: track.genre || '',
        genres: normalizeGenres(track.genres || track.genre || ''),
        record_label: track.record_label || '',
        explicit: !!track.explicit,
        instrumental: track.instrumental === null || track.instrumental === undefined ? '' : String(track.instrumental),
        danceability: asInput(track.danceability),
        energy: asInput(track.energy),
        track_key: asInput(track.track_key),
        loudness: asInput(track.loudness),
        mode: asInput(track.mode),
        speechiness: asInput(track.speechiness),
        acousticness: asInput(track.acousticness),
        instrumentalness: asInput(track.instrumentalness),
        liveness: asInput(track.liveness),
        valence: asInput(track.valence),
        tempo: asInput(track.tempo),
        time_signature: asInput(track.time_signature),
        clip_url: track.clip_url || '',
        clip_start: asInput(track.clip_start),
        clip_end: asInput(track.clip_end),
      })
      
      if (track.artwork_path) {
        setArtworkPreview(trackArtworkPreview(track))
      } else {
        setArtworkPreview(null)
      }
      setStatus(null)
    }
  }, [track])

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleSelectArtwork = async () => {
    if (!api.isElectron) return
    
    const fp = await api.openFile([{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }])
    if (!fp) return
    
    const dataUrl = await api.readFileAsDataURL(fp)
    setArtworkPreview(dataUrl)
    
    setSaving(true)
    try {
      const updatedTrack = await api.trackSetArtwork(track.id, dataUrl)
      if (updatedTrack?.error) {
        setArtworkPreview(trackArtworkPreview(track))
        setStatus({ type: 'error', message: updatedTrack.error })
        setSaving(false)
        return
      }
      if (!updatedTrack?.id) throw new Error('Could not update artwork')
      syncTrack(updatedTrack)
      if (onSave) onSave(updatedTrack)
      setStatus({ type: 'success', message: 'Artwork updated in the audio file.' })
      setTimeout(() => setStatus(null), 2000)
    } catch (e) {
      setArtworkPreview(trackArtworkPreview(track))
      setStatus({ type: 'error', message: e.message })
    }
    setSaving(false)
  }

  const handleSave = async () => {
    if (!track) return
    
    setSaving(true)
    setStatus(null)
    
    try {
      const updateData = {}
      if (formData.title && formData.title !== track.title) updateData.title = formData.title
      if (formData.artist && formData.artist !== track.artist) updateData.artist = formData.artist
      if (formData.album !== track.album) updateData.album = formData.album || null
      if (formData.album_artist !== track.album_artist) updateData.album_artist = formData.album_artist || null
      if (String(formData.track_num) !== String(track.track_num ?? '')) updateData.track_num = parseIntegerField(formData.track_num)
      if (String(formData.year) !== String(track.year ?? '')) updateData.year = parseIntegerField(formData.year)
      if (formData.genre !== track.genre) updateData.genre = formData.genre || null
      if (normalizeGenres(formData.genres) !== normalizeGenres(track.genres || track.genre || '')) updateData.genres = normalizeGenres(formData.genres) || null
      if (formData.record_label !== (track.record_label || '')) updateData.record_label = formData.record_label || null
      const clipUrl = formData.clip_url.trim()
      if (clipUrl && !clipVideoLink(clipUrl)) {
        setStatus({ type: 'error', message: t('The music video must be a link or a video file on this computer') })
        setSaving(false)
        return
      }
      if (clipUrl !== (track.clip_url || '')) updateData.clip_url = clipUrl || null
      if (String(formData.clip_start) !== String(track.clip_start ?? '')) updateData.clip_start = formData.clip_start.trim() ? parseClipTime(formData.clip_start) : null
      if (String(formData.clip_end) !== String(track.clip_end ?? '')) updateData.clip_end = formData.clip_end.trim() ? parseClipTime(formData.clip_end) : null
      if (Number.isNaN(updateData.clip_start) || Number.isNaN(updateData.clip_end) || (updateData.clip_start != null && updateData.clip_start < 0) || (updateData.clip_end != null && updateData.clip_end < 0)) {
        setStatus({ type: 'error', message: t('Clip times must be valid non-negative times.') })
        setSaving(false)
        return
      }
      if (formData.explicit !== !!track.explicit) updateData.explicit = formData.explicit ? 1 : 0
      if (String(formData.instrumental) !== String(track.instrumental ?? '')) updateData.instrumental = formData.instrumental === '' ? null : formData.instrumental === '1' ? 1 : 0
      if (String(formData.danceability) !== String(track.danceability ?? '')) updateData.danceability = parseNumberField(formData.danceability)
      if (String(formData.energy) !== String(track.energy ?? '')) updateData.energy = parseNumberField(formData.energy)
      if (String(formData.track_key) !== String(track.track_key ?? '')) updateData.track_key = parseIntegerField(formData.track_key)
      if (String(formData.loudness) !== String(track.loudness ?? '')) updateData.loudness = parseNumberField(formData.loudness)
      if (String(formData.mode) !== String(track.mode ?? '')) updateData.mode = parseIntegerField(formData.mode)
      if (String(formData.speechiness) !== String(track.speechiness ?? '')) updateData.speechiness = parseNumberField(formData.speechiness)
      if (String(formData.acousticness) !== String(track.acousticness ?? '')) updateData.acousticness = parseNumberField(formData.acousticness)
      if (String(formData.instrumentalness) !== String(track.instrumentalness ?? '')) updateData.instrumentalness = parseNumberField(formData.instrumentalness)
      if (String(formData.liveness) !== String(track.liveness ?? '')) updateData.liveness = parseNumberField(formData.liveness)
      if (String(formData.valence) !== String(track.valence ?? '')) updateData.valence = parseNumberField(formData.valence)
      if (String(formData.tempo) !== String(track.tempo ?? '')) updateData.tempo = parseNumberField(formData.tempo)
      if (String(formData.time_signature) !== String(track.time_signature ?? '')) updateData.time_signature = parseIntegerField(formData.time_signature)
      
      if (Object.keys(updateData).length > 0) {
        const result = await api.updateTrack(track.id, updateData)
        if (result?.error) {
          setStatus({ type: 'error', message: result.error })
        } else {
          const updatedTrack = result?.track || { ...track, ...updateData }
          syncTrack(updatedTrack)
          setStatus({ type: 'success', message: 'Track updated!' })
          if (onSave) onSave(updatedTrack)
          setTimeout(() => {
            onClose()
          }, 1000)
        }
      } else {
        setStatus({ type: 'success', message: 'No changes to save' })
        setTimeout(() => setStatus(null), 2000)
      }
    } catch (e) {
      setStatus({ type: 'error', message: e.message })
    }
    
    setSaving(false)
  }

  const fetchFromiTunes = async () => {
    if (!track) return
    
    setSaving(true)
    setStatus({ type: 'loading', message: 'Searching iTunes for artwork...' })
    
    try {
      const result = await api.fetchExternalArtwork(track.id, track.title, track.artist)
      
      if (result?.success && result.artworkPath) {
        const updatedTrack = { ...(result?.track || track), artwork_path: result.artworkPath }
        setArtworkPreview(trackArtworkPreview(updatedTrack))
        syncTrack(updatedTrack)
        setStatus({ type: 'success', message: 'Artwork found and updated!' })
        if (onSave) onSave(updatedTrack)
      } else {
        setStatus({ type: 'error', message: result?.error || 'No artwork found on iTunes' })
      }
    } catch (e) {
      setStatus({ type: 'error', message: e.message })
    }
    
    setSaving(false)
    setTimeout(() => setStatus(null), 3000)
  }

  return (
    <Modal open={open} onClose={onClose} title={t("Edit Track")} width="max-w-3xl">
      <div className="space-y-4">
        <div className="flex gap-4">
          <div className="flex-shrink-0">
            <div className="w-32 h-32 rounded-lg overflow-hidden bg-card border border-border relative group">
              {artworkPreview ? (
                <img src={artworkPreview} alt={t("Artwork")} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted">
                  <Camera size={32} />
                </div>
              )}
              <button 
                onClick={handleSelectArtwork}
                disabled={saving}
                className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Camera size={24} className="text-white" />
              </button>
            </div>
            <button 
              onClick={fetchFromiTunes}
              disabled={saving}
              className="mt-2 w-full py-1.5 text-xs bg-card border border-border rounded-lg text-muted hover:text-accent hover:border-accent/30 transition-colors flex items-center justify-center gap-1"
            >
              {saving ? <RefreshCw size={12} className="animate-spin" /> : null}
              {t(artworkPreview ? 'Replace with iTunes Artwork' : 'Find Artwork on iTunes')}
            </button>
          </div>
          
          <div className="flex-1 space-y-3">
            <div>
              <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Title")}</label>
              <input 
                value={formData.title}
                onChange={(e) => handleChange('title', e.target.value)}
                className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
                placeholder={t("Track title")}
              />
            </div>
            
            <div>
              <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Artist")}</label>
              <input 
                value={formData.artist}
                onChange={(e) => handleChange('artist', e.target.value)}
                className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
                placeholder={t("Artist name")}
              />
            </div>
          </div>
        </div>

        <div>
          <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Album")}</label>
          <input 
            value={formData.album}
            onChange={(e) => handleChange('album', e.target.value)}
            className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
            placeholder={t("Album name")}
          />
        </div>

        <div>
          <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Album Artist")}</label>
          <input 
            value={formData.album_artist}
            onChange={(e) => handleChange('album_artist', e.target.value)}
            className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
            placeholder={t("Album artist (if different)")}
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/50 px-3 py-2 text-xs">
          <span className="text-muted">{t('File size')}</span>
          <span className="text-white" data-testid="track-edit-file-size">
            {fileSizeBytes != null
              ? `${(fileSizeBytes / 1000000).toFixed(2)} MB`
              : t('Unknown')}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Track #")}</label>
            <input 
              type="number"
              min="1"
              value={formData.track_num}
              onChange={(e) => handleChange('track_num', e.target.value)}
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
              placeholder="1"
            />
          </div>
          <div>
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Year")}</label>
            <input 
              type="number"
              min="1900"
              max="2100"
              value={formData.year}
              onChange={(e) => handleChange('year', e.target.value)}
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
              placeholder="2024"
            />
          </div>
          <div>
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Genre")}</label>
            <GenreValueInput
              value={formData.genre}
              onChange={(value) => handleChange('genre', value)}
              suggestions={genreOptions}
              listId="track-edit-genre-options"
              placeholder={t("Rock")}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Genres")}</label>
            <GenreValueInput
              value={formData.genres}
              onChange={(value) => handleChange('genres', value)}
              suggestions={genreOptions}
              listId="track-edit-genres-options"
              multi
              placeholder={t("slowcore, shoegaze")}
            />
          </div>
          <div>
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t("Record Label")}</label>
            <input
              value={formData.record_label}
              onChange={(e) => handleChange('record_label', e.target.value)}
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
              placeholder={t("Label")}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.explicit}
              onChange={(e) => handleChange('explicit', e.target.checked)}
              className="rounded border-border bg-card text-accent focus:ring-accent/40"
            />
            <div>
              <p className="text-sm text-white">{t("Explicit")}</p>
              <p className="text-xs text-muted">{t("Show the track with the explicit badge.")}</p>
            </div>
          </label>
          <div className="rounded-xl border border-border bg-card px-3 py-3">
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-2">{t("Instrumental")}</label>
            <select
              value={formData.instrumental}
              onChange={(e) => handleChange('instrumental', e.target.value)}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
            >
              <option value="">{t("Unknown")}</option>
              <option value="1">{t("Instrumental")}</option>
              <option value="0">{t("Has vocals")}</option>
            </select>
            <p className="text-xs text-muted mt-2">{t("Instrumental tracks skip LRCLIB and lyrics lookups.")}</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <div>
            <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t('Music video clip')}</label>
            <input value={formData.clip_url} onChange={e => handleChange('clip_url', e.target.value)}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
              placeholder={t('Video URL or local file path')} spellCheck={false} />
            <p className="mt-1 text-xs text-muted">{t('Optional: loops a muted section of this video in the Visualization + Lyrics panel.')}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t('Clip start')}</label>
              <input value={formData.clip_start} onChange={e => handleChange('clip_start', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0 or 1:15" />
            </div>
            <div>
              <label className="text-xs font-display text-muted uppercase tracking-widest block mb-1">{t('Clip end')}</label>
              <input value={formData.clip_end} onChange={e => handleChange('clip_end', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="1:25" />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card/70 p-4 space-y-3">
          <div>
            <p className="text-xs font-display text-muted uppercase tracking-widest">{t("Imported Audio Data")}</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Danceability")}</label>
              <input value={formData.danceability} onChange={(e) => handleChange('danceability', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0.522" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Energy")}</label>
              <input value={formData.energy} onChange={(e) => handleChange('energy', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0.992" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Key")}</label>
              <input value={formData.track_key} onChange={(e) => handleChange('track_key', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Loudness")}</label>
              <input value={formData.loudness} onChange={(e) => handleChange('loudness', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="-3.076" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Mode")}</label>
              <input value={formData.mode} onChange={(e) => handleChange('mode', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="1" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Speechiness")}</label>
              <input value={formData.speechiness} onChange={(e) => handleChange('speechiness', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0.173" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Acousticness")}</label>
              <input value={formData.acousticness} onChange={(e) => handleChange('acousticness', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0.0631" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Instrumentalness")}</label>
              <input value={formData.instrumentalness} onChange={(e) => handleChange('instrumentalness', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0.743" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Liveness")}</label>
              <input value={formData.liveness} onChange={(e) => handleChange('liveness', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0.0724" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Valence")}</label>
              <input value={formData.valence} onChange={(e) => handleChange('valence', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="0.701" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Tempo")}</label>
              <input value={formData.tempo} onChange={(e) => handleChange('tempo', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="73.528" />
            </div>
            <div>
              <label className="text-[11px] text-muted uppercase tracking-widest block mb-1">{t("Time Signature")}</label>
              <input value={formData.time_signature} onChange={(e) => handleChange('time_signature', e.target.value)} className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/50" placeholder="4" />
            </div>
          </div>
        </div>

        <AnimatePresence>
          {status && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={`p-3 rounded-lg flex items-center gap-2 ${
                status.type === 'success' ? 'bg-accent/20 text-accent' :
                status.type === 'error' ? 'bg-red-500/20 text-red-400' :
                'bg-card text-muted'
              }`}
            >
              {status.type === 'success' && <Check size={16} />}
              {status.type === 'error' && <AlertCircle size={16} />}
              {status.type === 'loading' && <RefreshCw size={16} className="animate-spin" />}
              <span className="text-sm">{status.message}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex gap-2 pt-2">
          <button 
            onClick={onClose}
            className="flex-1 py-2.5 bg-card border border-border rounded-xl text-sm text-muted hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2.5 bg-accent text-base rounded-xl text-sm font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
            Save Changes
          </button>
        </div>
      </div>
    </Modal>
  )
}

