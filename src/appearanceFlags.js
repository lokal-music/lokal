// Appearance settings read outside the Settings page (the player bar, the
// app layout). Read once and shared; re-read whenever settings are saved, so
// a switch applies straight away. An on/off setting is on unless it's '0'.
//   glass_player_bar        Settings > Appearance > Player Bar > Glass (see-through, blurred)
//   player_bar_floating     ... > Floating bar (off: docked to the bottom edge).
//                           Unset: follows Glass, which used to switch both.
//   player_bar_gradient     Settings > Visualizations > Player Bar > Cover gradient
//   player_waveform         ... > Visualization, before it had a choice: '0' was Off
//   side_panel_visualizer   Settings > Visualizations > Side Panel > Visualization, before it
//                           had a choice: '0' was Off
//   taskbar_progress        ... > Taskbar > Song progress on the taskbar button
//   home_cover_flow        Settings > Appearance > Home Carousel: on = iTunes Cover Flow,
//                          off = original cylindrical carousel (default: on).
//   home_greeting          Settings > Appearance > Home: show the personalized
//                          greeting and subheader on all Home tabs (default: on).
// Numbers (useAppearanceValue):
//   player_bar_gradient_strength   0-100, how strongly the cover gradient shows
//   player_bar_gradient_speed      0-100, how fast its colours drift (0: still)
//   player_bar_glass_transparency  0-90, how see-through the glass is
//   player_bar_shade_transparency  0-100, the shade under the seek bar (glass only)
//   player_spectrum_bars        8-160, Settings > Visualizations > Player Bar > Spectrum: how many bars
//   player_spectrum_bar_width   1-12, each bar's width (px)
//   player_spectrum_height      10-90, the tallest a bar gets (px)
//   player_spectrum_strength    10-300, % how high the music throws the bars
//   player_spectrum_opacity     5-100, % how strongly they show
//   player_waves_width          120-1200, ... > Waves: how wide (px)
//   player_waves_height         10-90, how high they rise (px)
//   player_waves_strength       10-300, % how high the music throws them
//   player_waves_opacity        5-100, % how strongly they show
//   player_lightning_strength   10-300, ... > Lightning: % how strongly the music moves it
//   player_lightning_opacity    5-100, % how strongly it shows
//   side_anomaly_sensitivity    1-10, Settings > Visualizations > Side Panel > Anomaly (5: as in the pen)
//   side_anomaly_size           50-200, % how big
//   volume_wheel_step              1-5, volume % per wheel notch over the player bar
//   radio_buffer_sec               0-10, Settings > Online Radio > Buffer (seconds before a station starts)
// Text (useAppearanceText):
//   player_visualizer   Settings > Visualizations > Player Bar > Visualization: off, waveform
//                       (bars beside the volume), spectrum or waves (under the seek bar) or
//                       lightning (across the bar). Unset: follows player_waveform.
//   side_panel_visual   ... > Side Panel > Visualization: off, character (the round one) or
//                       anomaly. Unset: follows side_panel_visualizer.
//   player_spectrum_color  #rrggbb for the spectrum, or 'accent'; unset: white
//   player_waves_color_back, player_waves_color_front   the two waves' colours (same form)
//   player_lightning_color_1, _2, _3   the lightning's three lines (same form)
//   side_anomaly_color  the anomaly's colour (same form)
//   side_anomaly_bg, side_character_bg   the colour behind each side panel visualization
//                       (same form; unset: black)
//   app_tabs        Settings > Appearance > App Tabs: tab order and which go to the ⋯ menu (see appTabs.js)
//   taskbar_title   ... > Taskbar Title: what the window title (taskbar) shows
//   folder_transition  ... > Layout > Folder switch animation (see Library.jsx)
//   radio_config_page_url  Settings > Online Radio > a page to edit the catalogue (the station list's "Open config")
//   folder_apps     Settings > Library > Open Folders In: JSON [{ name, path }] (the sidebar folders' right-click menu)

import { useEffect, useState } from 'react'
import { api } from './api'

const KEYS = ['glass_player_bar', 'player_bar_floating', 'player_bar_gradient', 'player_waveform', 'side_panel_visualizer', 'taskbar_progress', 'home_cover_flow', 'home_greeting']
const VALUE_KEYS = ['player_bar_gradient_strength', 'player_bar_gradient_speed', 'player_bar_glass_transparency', 'player_bar_shade_transparency', 'app_tabs', 'taskbar_title', 'volume_wheel_step', 'folder_transition', 'radio_buffer_sec', 'radio_config_page_url', 'folder_apps',
  'player_visualizer', 'player_spectrum_bars', 'player_spectrum_bar_width', 'player_spectrum_height', 'player_spectrum_strength', 'player_spectrum_opacity', 'player_spectrum_color', 'player_spectrum_radius',
  'player_center_spectrum_bars', 'player_center_spectrum_bar_width', 'player_center_spectrum_height', 'player_center_spectrum_strength', 'player_center_spectrum_opacity', 'player_center_spectrum_color', 'player_center_spectrum_radius',
  'side_lyrics_backdrop_strength', 'side_lyrics_offset',
  'player_waves_width', 'player_waves_height', 'player_waves_strength', 'player_waves_opacity', 'player_waves_color_back', 'player_waves_color_front',
  'player_lightning_strength', 'player_lightning_opacity', 'player_lightning_color_1', 'player_lightning_color_2', 'player_lightning_color_3',
  'side_panel_visual', 'side_anomaly_sensitivity', 'side_anomaly_size', 'side_anomaly_color', 'side_anomaly_bg', 'side_character_bg']
let values = Object.fromEntries(KEYS.map(key => [key, true]))
let raw = {}
let load = null
let loadGeneration = 0
const listeners = new Set()

function apply(s) {
  raw = Object.fromEntries(VALUE_KEYS.map(key => [key, s[key]]))
  values = Object.fromEntries(KEYS.map(key => [key, s[key] !== '0']))
  if (s.player_bar_floating == null || s.player_bar_floating === '') values.player_bar_floating = s.glass_player_bar !== '0'
}

function notify() { listeners.forEach(fn => fn()) }

function refresh() {
  const generation = ++loadGeneration
  let failed = false
  const request = Promise.resolve(api.getSettings?.())
    .then(s => {
      if (generation !== loadGeneration) return
      if (s && !s.error) apply(s)
      else failed = true
    })
    .catch(() => { failed = true })
    .then(() => {
      if (generation !== loadGeneration) return
      if (failed) load = null // Let a later-mounted consumer retry instead of caching a rejection forever.
      notify()
    })
  load = request
  return request
}
if (typeof window !== 'undefined') window.addEventListener('lokal:settings-saved', refresh)

function useSubscribed(read) {
  const [value, setValue] = useState(read)
  useEffect(() => {
    const update = () => setValue(read())
    listeners.add(update)
    if (!load) refresh()
    else load.then(update)
    return () => { listeners.delete(update) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return value
}

/** true unless the appearance setting `key` has been switched off. */
export function useAppearanceFlag(key) {
  return useSubscribed(() => values[key])
}

/** A numeric appearance setting, or `fallback` when unset. */
export function useAppearanceValue(key, fallback) {
  return useSubscribed(() => {
    const n = Number(raw[key])
    return raw[key] != null && raw[key] !== '' && Number.isFinite(n) ? n : fallback
  })
}

/** A text appearance setting, or `fallback` when unset. */
export function useAppearanceText(key, fallback = '') {
  return useSubscribed(() => (raw[key] != null && raw[key] !== '' ? String(raw[key]) : fallback))
}

/** Shows a value at once (a slider being dragged), before the save comes back. */
export function previewAppearanceValue(key, value) {
  raw = { ...raw, [key]: String(value) }
  notify()
}

export const PLAYER_VISUALIZERS = ['off', 'waveform', 'spectrum', 'spectrumCenter', 'waves', 'lightning']

/** Which visualization the player bar shows (one of PLAYER_VISUALIZERS). */
export function usePlayerVisualizer() {
  const waveform = useAppearanceFlag('player_waveform')
  const chosen = useAppearanceText('player_visualizer')
  return PLAYER_VISUALIZERS.includes(chosen) ? chosen : waveform ? 'waveform' : 'off'
}

export const SIDE_PANEL_VISUALIZERS = ['off', 'character', 'anomaly']

/** Which visualization the side panel's Visualization tab shows ('off': no tab). */
export function useSidePanelVisualizer() {
  const on = useAppearanceFlag('side_panel_visualizer')
  const chosen = useAppearanceText('side_panel_visual')
  return SIDE_PANEL_VISUALIZERS.includes(chosen) ? chosen : on ? 'character' : 'off'
}
