import { Home, Library, BarChart2, Disc3, Tags, Radio, Users, Clapperboard, AudioWaveform } from 'lucide-react'

export const HIDDEN_MARK = '|'
export const REMOVED_PREFIX = '__removed__:'

export const SIDEBAR_ITEMS = [
  { icon: Home, label: 'Home', path: '/' },
  { icon: Library, label: 'Library', path: '/library', tour: 'library' },
  { icon: BarChart2, label: 'Recap', path: '/recap' },
  { icon: Disc3, label: 'Albums', path: '/albums', tour: 'albums' },
  { icon: Tags, label: 'Genres', path: '/genres' },
  { icon: Radio, label: 'Stations', path: '/stations' },
  { icon: Users, label: 'Artists', path: '/artists', tour: 'artists' },
  { icon: Clapperboard, label: 'Videos', path: '/videos' },
  { icon: AudioWaveform, label: 'Quality', path: '/quality' },
]

export const DEFAULT_SIDEBAR_ORDER = [...SIDEBAR_ITEMS.map(item => item.path), HIDDEN_MARK]

/** The saved sidebar order, minus unknown paths, with new items appended safely. */
export function sidebarNavOrder(saved) {
  let list = []
  try { list = typeof saved === 'string' && saved ? JSON.parse(saved) : Array.isArray(saved) ? saved : [] } catch {}
  if (!Array.isArray(list)) list = []
  const known = new Set(SIDEBAR_ITEMS.map(item => item.path))
  const removed = new Set(list.filter(path => typeof path === 'string' && path.startsWith(REMOVED_PREFIX)).map(path => path.slice(REMOVED_PREFIX.length)))
  const order = [...new Set(list.filter(path => path === HIDDEN_MARK || known.has(path)))]
  if (!order.includes(HIDDEN_MARK)) order.push(HIDDEN_MARK)
  for (const path of DEFAULT_SIDEBAR_ORDER) {
    if (path === HIDDEN_MARK || order.includes(path) || removed.has(path)) continue
    const index = DEFAULT_SIDEBAR_ORDER.indexOf(path)
    const next = DEFAULT_SIDEBAR_ORDER.slice(index + 1).find(p => p !== HIDDEN_MARK && order.includes(p))
    if (next) order.splice(order.indexOf(next), 0, path)
    else order.splice(order.indexOf(HIDDEN_MARK), 0, path)
  }
  return order
}

/** Returns items above the divider and in the More section below it. */
export function splitSidebarNav(order) {
  const byPath = Object.fromEntries(SIDEBAR_ITEMS.map(item => [item.path, item]))
  const at = order.indexOf(HIDDEN_MARK)
  return {
    visible: order.slice(0, at).map(path => byPath[path]).filter(Boolean),
    hidden: order.slice(at + 1).map(path => byPath[path]).filter(Boolean),
  }
}
