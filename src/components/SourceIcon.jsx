import React from 'react'
import { Bird, Globe, Puzzle, Smartphone, Disc3, createLucideIcon } from 'lucide-react'
import { downloadSourceLabel, isAddonProvider, streamRef } from '../onlineTracks'

// lucide 1.x dropped its brand icons (trademarks); this is its YouTube outline
// from 0.577 (ISC licence), rebuilt as a lucide icon so it takes the same props.
export const YoutubeIcon = createLucideIcon('youtube', [
  ['path', { d: 'M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17', key: '1q2vi4' }],
  ['path', { d: 'm10 15 5-3-5-3z', key: '1jp15x' }],
])

function addonBrandKey(name) {
  const label = String(name || '').toLowerCase()
  if (/\bamazon\b/.test(label)) return 'amazon'
  if (/\bqobuz\b/.test(label)) return 'qobuz'
  if (/\btidal\b/.test(label)) return 'tidal'
  if (/\bdeezer\b/.test(label)) return 'deezer'
  return null
}

function AddonBrandIcon({ brand, props }) {
  if (brand === 'tidal') return (
    <svg {...props} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.012 3.992 8.008 7.996 4.004 3.992 0 7.996 4.004 12l4.004-4.004L12.012 12l-4.004 4.004 4.004 4.004 4.004-4.004L12.012 12l4.004-4.004-4.004-4.004zM16.042 7.996l3.979-3.979L24 7.996l-3.979 3.979z" />
    </svg>
  )
  if (brand === 'qobuz') return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M6 12c0-1.7.7-3.2 1.8-4.2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M18 12c0 1.7-.7 3.2-1.8 4.2" />
    </svg>
  )
  if (brand === 'deezer') return (
    <svg {...props} viewBox="0 0 24 24" fill="currentColor">
      <path d="M.693 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807C.312 4.41 0 5.666 0 7.217s.312 2.808.693 2.808ZM21.038 1.56c-.364 0-.684.805-.91 2.096C19.765 1.446 19.184 0 18.526 0c-.78 0-1.464 2.036-1.784 5-.312-2.158-.788-3.536-1.325-3.536-.745 0-1.386 2.704-1.62 6.472-.442-1.932-1.083-3.145-1.793-3.145s-1.35 1.213-1.793 3.145c-.242-3.76-.874-6.463-1.628-6.463-.537 0-1.013 1.378-1.325 3.535C6.938 2.036 6.262 0 5.474 0c-.658 0-1.247 1.447-1.602 3.665-.217-1.291-.546-2.105-.91-2.105-.675 0-1.221 2.807-1.221 6.272 0 3.466.546 6.273 1.221 6.273.277 0 .537-.476.736-1.273.32 2.928.996 4.938 1.776 4.938.606 0 1.143-1.204 1.507-3.11.251 3.622.875 6.195 1.602 6.195.46 0 .875-1.023 1.187-2.677C10.142 21.6 11 24 12.004 24c1.005 0 1.863-2.4 2.235-5.822.312 1.654.727 2.677 1.186 2.677.728 0 1.352-2.573 1.603-6.195.364 1.906.9 3.11 1.507 3.11.78 0 1.455-2.01 1.775-4.938.208.797.46 1.273.737 1.273.675 0 1.22-2.807 1.22-6.273-.008-3.457-.553-6.272-1.23-6.272ZM23.307 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807-.381 0-.693 1.256-.693 2.807s.312 2.808.693 2.808Z" />
    </svg>
  )
  if (brand === 'amazon') return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
  return null
}

// Quiet marks by default; online search opts into coloured provider branding.
export default function SourceIcon({ source, size = 14, className = '', colored = false, addonName = '' }) {
  const props = { width: size, height: size, className: `shrink-0 ${className}`, 'aria-hidden': true }
  if (source?.startsWith('a-')) {
    const brand = addonBrandKey(addonName)
    if (brand) return <AddonBrandIcon brand={brand} props={props} />
  }
  if (source === 'sc' && !colored) return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12v4m3-6v8m3-9v9m3-12v12h7a4 4 0 1 0-.5-8A6 6 0 0 0 11 6Z" />
    </svg>
  )
  if (colored && source === 'yt') return <svg {...props} viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="5" fill="#ff0000" /><path d="m10 8 6 4-6 4Z" fill="white" /></svg>
  if (colored && source === 'sc') return <svg {...props} viewBox="0 0 24 24" fill="#ff5500"><path d="M23.999 14.165c-.052 1.796-1.612 3.169-3.4 3.169h-8.18a.68.68 0 0 1-.675-.683V7.862a.747.747 0 0 1 .452-.724s.75-.513 2.333-.513a5.364 5.364 0 0 1 2.763.755 5.433 5.433 0 0 1 2.57 3.54c.282-.08.574-.121.868-.12.884 0 1.73.358 2.347.992s.948 1.49.922 2.373ZM10.721 8.421c.247 2.98.427 5.697 0 8.672a.264.264 0 0 1-.53 0c-.395-2.946-.22-5.718 0-8.672a.264.264 0 0 1 .53 0ZM9.072 9.448c.285 2.659.37 4.986-.006 7.655a.277.277 0 0 1-.55 0c-.331-2.63-.256-5.02 0-7.655a.277.277 0 0 1 .556 0Zm-1.663-.257c.27 2.726.39 5.171 0 7.904a.266.266 0 0 1-.532 0c-.38-2.69-.257-5.21 0-7.904a.266.266 0 0 1 .532 0Zm-1.647.77a26.108 26.108 0 0 1-.008 7.147.272.272 0 0 1-.542 0 27.955 27.955 0 0 1 0-7.147.275.275 0 0 1 .55 0Zm-1.67 1.769c.421 1.865.228 3.5-.029 5.388a.257.257 0 0 1-.514 0c-.21-1.858-.398-3.549 0-5.389a.272.272 0 0 1 .543 0Zm-1.655-.273c.388 1.897.26 3.508-.01 5.412-.026.28-.514.283-.54 0-.244-1.878-.347-3.54-.01-5.412a.283.283 0 0 1 .56 0Zm-1.668.911c.4 1.268.257 2.292-.026 3.572a.257.257 0 0 1-.514 0c-.241-1.262-.354-2.312-.023-3.572a.283.283 0 0 1 .563 0Z" /></svg>
  if (colored && source === 'spotify') return <svg {...props} viewBox="0 0 24 24" fill="#1ed760"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" /></svg>
  if (colored && (source === 'soulseek' || source === 'slsk')) return <Bird {...props} className={`shrink-0 text-blue-400 ${className}`} />
  const Icon = source === 'mobile' ? Smartphone
    : source === 'mono' ? Disc3
    : source === 'yt' ? YoutubeIcon
    : source === 'soulseek' || source === 'slsk' ? Bird
      : source?.startsWith('a-') ? Puzzle : Globe
  return <Icon {...props} />
}

export function TrackSourceIcon({ track, addonNames, className = '' }) {
  const stream = streamRef(track)
  const mobileHistory = String(track.file_path || '').startsWith('ghost://link/')
  const source = stream?.provider || track.download_source || (mobileHistory ? 'mobile' : null)
  const label = downloadSourceLabel(source, addonNames)
  const local = !source && !String(track.file_path || '').startsWith('ghost://')
  if (local) return null
  const description = mobileHistory
    ? 'Played on Lokal Mobile · audio not stored on this PC'
    : source === 'mobile' ? 'Copied from mobile'
    : label ? `${stream ? 'Streamed' : 'Downloaded'} from ${label}${stream ? ' · not in your library yet' : ''}`
    : 'Source unknown'
  return (
    <span role="img" aria-label={description} title={description} className={`inline-flex shrink-0 items-center justify-center text-muted ${className}`}>
      <SourceIcon source={source} addonName={isAddonProvider(source) ? addonNames?.[source] : ''} />
    </span>
  )
}
