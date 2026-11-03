// Portable M3U / M3U8 export. Only local files are written to the playlist;
// never include stream URLs, placeholders, or machine-specific absolute paths.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function inside(relative, pathApi) {
  return !!relative && relative !== '..' &&
    !relative.startsWith('..' + pathApi.sep) && !pathApi.isAbsolute(relative)
}

// Multiple music roots may have the same basename (e.g. C:\Music, D:\Music).
// Give them distinct destinations so two files do not silently collide.
function namedRoots(roots, pathApi) {
  const names = new Set()
  return [...new Set(roots.filter(root => typeof root === 'string' && pathApi.isAbsolute(root))
    .map(root => pathApi.normalize(root)))].sort((a, b) => b.length - a.length)
    .map(root => {
      const base = pathApi.parse(root).root === root ? 'Music' : pathApi.basename(root)
      const stem = (base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || 'Music')
      let label = stem
      for (let i = 2; names.has(label.toLowerCase()); i++) label = stem + '-' + i
      names.add(label.toLowerCase())
      return { root, label }
    })
}

/**
 * Build a portable playlist without changing or copying any audio files.
 * Relative paths beneath the output folder are used directly. Other tracks
 * beneath a configured music root are mapped to <root-name>/<path-under-root>,
 * which can be copied beside the playlist on a portable player's storage.
 * With no configured root, same-volume ../ paths remain usable if the user
 * copies the surrounding directory layout; different volumes are skipped.
 */
function buildM3u(tracks, playlistFile, options = {}) {
  const pathApi = options.pathApi || path
  const exists = options.fileExists || fs.existsSync
  if (typeof playlistFile !== 'string' || !pathApi.isAbsolute(playlistFile)) {
    throw new Error('Export destination must be an absolute file path.')
  }
  const rootNames = namedRoots(options.roots || [], pathApi)
  const destination = pathApi.dirname(playlistFile)
  const lines = ['#EXTM3U']
  const usedRoots = new Set()
  const summary = {
    total: 0, exported: 0, skippedUnusable: 0, skippedMissing: 0,
    skippedCrossVolume: 0, externalRelative: 0, portableRoots: [],
  }

  for (const track of (Array.isArray(tracks) ? tracks : [])) {
    summary.total++
    const source = typeof track === 'string' ? track : track?.file_path
    if (typeof source !== 'string' || !pathApi.isAbsolute(source)) {
      summary.skippedUnusable++
      continue
    }
    if (!exists(source)) {
      summary.skippedMissing++
      continue
    }

    const original = pathApi.normalize(source)
    const relative = pathApi.relative(destination, original)
    const root = rootNames.find(item => inside(pathApi.relative(item.root, original), pathApi))
    let entry
    if (inside(relative, pathApi)) {
      entry = relative
    } else if (root) {
      entry = root.label + '/' + pathApi.relative(root.root, original)
    } else if (relative && !pathApi.isAbsolute(relative)) {
      // Still genuinely relative and useful when the directory tree is copied.
      entry = relative
      summary.externalRelative++
    } else {
      summary.skippedCrossVolume++
      continue
    }

    entry = entry.replace(/\\/g, '/')
    // A path beginning with # is a comment to an M3U parser.
    if (entry.startsWith('#')) entry = './' + entry
    if (/[\r\n]/.test(entry)) {
      summary.skippedUnusable++
      continue
    }
    if (root && !inside(relative, pathApi)) usedRoots.add(root.label)
    lines.push(entry)
    summary.exported++
  }

  summary.portableRoots = [...usedRoots]
  summary.skipped = summary.total - summary.exported
  return { ...summary, content: lines.join('\r\n') + '\r\n' }
}

module.exports = { buildM3u }
