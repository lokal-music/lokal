const path = require('path')
const crypto = require('crypto')
const fs = require('fs-extra')

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.aac', '.opus', '.wma', '.alac', '.ape'])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

const artworkFingerprintCache = new Map()

function artworkFingerprint(filePath) {
  try {
    const fullPath = path.resolve(filePath)
    const stat = fs.statSync(fullPath)
    if (!stat.isFile() || stat.size > 512 * 1024) return null
    const cached = artworkFingerprintCache.get(fullPath)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.fingerprint
    const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex')
    artworkFingerprintCache.set(fullPath, { size: stat.size, mtimeMs: stat.mtimeMs, fingerprint })
    if (artworkFingerprintCache.size > 2000) artworkFingerprintCache.delete(artworkFingerprintCache.keys().next().value)
    return fingerprint
  } catch {
    return null
  }
}

function imagePriority(name) {
  const stem = path.parse(name).name.toLowerCase().replace(/[\s_-]+/g, '')
  if (stem === 'cover') return 0
  if (stem === 'folder') return 1
  if (stem === 'front') return 2
  if (stem === 'albumart') return 3
  if (stem === 'album') return 4
  if (stem === 'art') return 5
  return 99
}

function findFolderArtwork(folderPath) {
  try {
    const images = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => entry.name)
      .sort((left, right) =>
        imagePriority(left) - imagePriority(right) ||
        left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
      )
    if (!images.length) return null

    // A conventional filename is an explicit choice. Otherwise, use a lone
    // image or a set of byte-identical images, never an arbitrary unrelated one.
    if (imagePriority(images[0]) < 99) return path.join(folderPath, images[0])
    if (images.length === 1) return path.join(folderPath, images[0])
    // Keep fallback fingerprinting bounded; a large folder shouldn't make the main process hash hundreds of files.
    if (images.length > 32) return null
    let totalImageBytes = 0
    for (const name of images) {
      try { totalImageBytes += fs.statSync(path.join(folderPath, name)).size } catch { return null }
      if (totalImageBytes > 4 * 1024 * 1024) return null
    }
    const fingerprints = images.map(name => artworkFingerprint(path.join(folderPath, name)))
    if (fingerprints.some(fingerprint => !fingerprint)) return null
    return new Set(fingerprints).size === 1 ? path.join(folderPath, images[0]) : null
  } catch {
    return null
  }
}

function isOutside(basePath, candidatePath) {
  const relative = path.relative(basePath, candidatePath)
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
}

function getPathPrefixBounds(folderPath) {
  const prefix = folderPath.endsWith(path.sep) ? folderPath : folderPath + path.sep
  const separatorCode = prefix.charCodeAt(prefix.length - 1)
  return {
    prefix,
    // The prefix ends with an ASCII path separator. Advancing that character
    // gives a safe exclusive upper bound, including names beginning with emoji.
    upperBound: prefix.slice(0, -1) + String.fromCharCode(separatorCode + 1),
  }
}

function isExistingFile(filePath) {
  try {
    return typeof filePath === 'string' && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function getExistingTrackPaths(db, folderPath) {
  if (!db || typeof db.prepare !== 'function') return []
  const { prefix, upperBound } = getPathPrefixBounds(folderPath)
  try {
    const rows = db.prepare(
      "SELECT file_path FROM tracks WHERE file_path >= ? AND file_path < ? AND file_path NOT LIKE 'ghost://%' ORDER BY file_path ASC"
    ).all(prefix, upperBound) || []
    return rows.map(row => row.file_path).filter(isExistingFile)
  } catch {
    return []
  }
}

function getTracksForPaths(db, filePaths) {
  if (!db || typeof db.prepare !== 'function' || !filePaths.length) return []
  const tracks = []
  for (let i = 0; i < filePaths.length; i += 500) {
    const batch = filePaths.slice(i, i + 500)
    const placeholders = batch.map(() => '?').join(',')
    try {
      tracks.push(...db.prepare(
        "SELECT * FROM tracks WHERE file_path IN (" + placeholders + ") AND file_path NOT LIKE 'ghost://%'"
      ).all(...batch))
    } catch {}
  }
  const byPath = new Map(tracks.filter(track => isExistingFile(track.file_path)).map(track => [track.file_path, track]))
  return filePaths.map(filePath => byPath.get(filePath)).filter(Boolean)
}


function configuredMusicRoots(db) {
  const plural = db.prepare("SELECT value FROM settings WHERE key = 'music_folders'").get()?.value
  let configuredRoots = []
  try { configuredRoots = Array.isArray(JSON.parse(plural || 'null')) ? JSON.parse(plural) : [] } catch {}
  if (!configuredRoots.length) {
    const legacy = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value
    if (legacy) configuredRoots = [legacy]
  }
  return configuredRoots.filter(value => typeof value === 'string' && value.trim()).map(value => path.resolve(value.trim()))
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isStrictlyInside(candidatePath, folderPath) {
  const relative = path.relative(path.resolve(folderPath), path.resolve(candidatePath))
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/** Resolve a browser-provided path strictly inside a configured music root. */
function resolveLibraryFolderTarget(db, relativePath, rootOverride = '') {
  const allowedRoots = configuredMusicRoots(db)
  const rootPath = rootOverride
    ? allowedRoots.find(value => samePath(value, String(rootOverride)))
    : allowedRoots[0]
  if (!rootPath) throw new Error('Choose a configured music folder')
  let realRoot
  try { realRoot = fs.realpathSync(rootPath) } catch { throw new Error('The selected music folder is not available') }

  const input = typeof relativePath === 'string' ? relativePath.replace(/\\/g, '/').slice(0, 4096) : ''
  const segments = input.split('/')
  if (!input || input.startsWith('/') || /^[a-z]:/i.test(input) ||
      segments.some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new Error('Choose a folder inside the selected music folder')
  }
  const targetPath = path.resolve(rootPath, ...segments)
  if (!isStrictlyInside(targetPath, rootPath) || isOutside(rootPath, targetPath)) {
    throw new Error('Folder is outside the selected music folder')
  }

  let stat, realTarget
  try {
    stat = fs.lstatSync(targetPath)
    realTarget = fs.realpathSync(targetPath)
  } catch { throw new Error('The selected folder is no longer available') }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !isStrictlyInside(realTarget, realRoot) || isOutside(realRoot, realTarget)) {
    throw new Error('Folder is not a directory inside the selected music folder')
  }
  return {
    rootPath: path.resolve(rootPath),
    realRoot,
    relativePath: segments.join('/'),
    targetPath,
    parentPath: path.dirname(targetPath),
    name: path.basename(targetPath),
  }
}

function getTrackRowsUnderFolder(db, folderPath) {
  const { prefix, upperBound } = getPathPrefixBounds(path.resolve(folderPath))
  try {
    return (db.prepare(
      "SELECT id, file_path, artwork_path FROM tracks WHERE file_path >= ? AND file_path < ? AND file_path NOT LIKE 'ghost://%' ORDER BY file_path ASC"
    ).all(prefix, upperBound) || []).filter(row =>
      row?.id && typeof row.file_path === 'string' && isStrictlyInside(row.file_path, folderPath)
    )
  } catch {
    return []
  }
}

function sameFilesystemEntry(left, right) {
  try {
    const a = fs.statSync(left)
    const b = fs.statSync(right)
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

function validateFolderName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error('Folder names cannot be empty')
  if (name === '.' || name === '..' || name.startsWith('.') ||
      name.includes('/') || name.includes('\\') || /[<>:"|?*]/.test(name) ||
      Array.from(name).some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(name)) {
    throw new Error('Enter a valid folder name')
  }
  return name
}

/**
 * Rename sibling folders with preflight validation and two-phase filesystem
 * moves, allowing bulk renames without overwriting an existing directory.
 * Indexed absolute track paths are changed in the same database transaction.
 */
function renameLibraryFolders(db, changes, rootOverride = '') {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 300) {
    throw new Error('Select between 1 and 300 folders to rename')
  }
  const plans = changes.map(change => {
    const source = resolveLibraryFolderTarget(db, change?.path, rootOverride)
    const newName = validateFolderName(change?.newName)
    const targetPath = path.resolve(source.parentPath, newName)
    if (!isStrictlyInside(targetPath, source.rootPath) || isOutside(source.rootPath, targetPath)) {
      throw new Error('The new folder name is outside the selected music folder')
    }
    return {
      ...source,
      newName,
      sourcePath: path.resolve(source.rootPath, source.relativePath),
      targetPath,
      targetRelativePath: path.relative(source.rootPath, targetPath).split(path.sep).join('/'),
    }
  })
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (new Set(plans.map(plan => pathKey(plan.parentPath))).size !== 1) {
    throw new Error('Select folders from the same directory')
  }
  if (new Set(plans.map(plan => pathKey(plan.sourcePath))).size !== plans.length) {
    throw new Error('A folder was selected more than once')
  }
  if (new Set(plans.map(plan => pathKey(plan.targetPath))).size !== plans.length) {
    throw new Error('Each folder must have a different new name')
  }

  const selectedSourcePaths = new Set(plans.map(plan => pathKey(plan.sourcePath)))
  for (const plan of plans) {
    const targetIsSelectedSource = selectedSourcePaths.has(pathKey(plan.targetPath)) ||
      plans.some(other => sameFilesystemEntry(other.sourcePath, plan.targetPath))
    if (fs.existsSync(plan.targetPath) && !targetIsSelectedSource) {
      throw new Error('A folder named "' + plan.newName + '" already exists')
    }
  }

  const changed = plans.filter(plan => plan.sourcePath !== plan.targetPath)
  if (!changed.length) return { success: true, renamed: [], unchanged: plans.map(plan => plan.relativePath) }
  for (const plan of changed) {
    plan.trackRows = getTrackRowsUnderFolder(db, plan.sourcePath)
    do {
      plan.tempPath = path.join(plan.parentPath, '.lokal-rename-' + crypto.randomBytes(10).toString('hex'))
    } while (fs.existsSync(plan.tempPath))
  }

  const movedToTemp = new Set()
  const movedToTarget = new Set()
  try {
    for (const plan of changed) {
      fs.renameSync(plan.sourcePath, plan.tempPath)
      movedToTemp.add(plan)
    }
    for (const plan of changed) {
      fs.renameSync(plan.tempPath, plan.targetPath)
      movedToTarget.add(plan)
    }

    const updatePath = db.prepare('UPDATE tracks SET file_path = ?, artwork_path = ? WHERE id = ?')
    const updateRows = db.transaction(() => {
      for (const plan of changed) {
        for (const row of plan.trackRows) {
          const relativeFilePath = path.relative(plan.sourcePath, row.file_path)
          const artworkPath = typeof row.artwork_path === 'string' && isStrictlyInside(row.artwork_path, plan.sourcePath)
            ? path.join(plan.targetPath, path.relative(plan.sourcePath, row.artwork_path))
            : (row.artwork_path ?? null)
          updatePath.run(path.join(plan.targetPath, relativeFilePath), artworkPath, row.id)
        }
      }
    })
    updateRows()
  } catch (error) {
    // Put every completed destination back into its temporary name first.
    // Only after freeing those destinations restore every original source path.
    for (const plan of changed) {
      if (movedToTarget.has(plan)) {
        try {
          fs.renameSync(plan.targetPath, plan.tempPath)
          movedToTarget.delete(plan)
        } catch {}
      }
    }
    for (const plan of [...changed].reverse()) {
      if (movedToTemp.has(plan) && !movedToTarget.has(plan)) {
        try {
          fs.renameSync(plan.tempPath, plan.sourcePath)
          movedToTemp.delete(plan)
        } catch {}
      }
    }
    throw error
  }

  return {
    success: true,
    renamed: changed.map(plan => ({ from: plan.relativePath, to: plan.targetRelativePath })),
    unchanged: plans.filter(plan => !changed.includes(plan)).map(plan => plan.relativePath),
  }
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, character => '\\' + character)
}

function getLibraryFolders(db, relativePath = '', search = '', rootOverride = '') {
  const plural = db.prepare("SELECT value FROM settings WHERE key = 'music_folders'").get()?.value
  let configuredRoots = []
  try { configuredRoots = Array.isArray(JSON.parse(plural || 'null')) ? JSON.parse(plural) : [] } catch {}
  if (!configuredRoots.length) {
    const legacy = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value
    if (legacy) configuredRoots = [legacy]
  }
  const allowedRoots = configuredRoots.filter(value => typeof value === 'string' && value.trim()).map(value => path.resolve(value.trim()) )
  const configuredRoot = rootOverride
    ? allowedRoots.find(value => value.toLowerCase() === path.resolve(String(rootOverride)).toLowerCase())
    : allowedRoots[0]
  if (!configuredRoot) {
    return { available: false, error: allowedRoots.length ? 'Choose a configured music folder' : 'No music folder selected', rootName: '', rootPath: '', rootPaths: allowedRoots, relativePath: '', folders: [], tracks: [], trackCount: 0, totalTracks: 0 }
  }

  const rootPath = path.resolve(String(configuredRoot))
  const requestedPath = typeof relativePath === 'string' ? relativePath.slice(0, 4096) : ''
  const targetPath = path.resolve(rootPath, requestedPath || '.')
  const relative = path.relative(rootPath, targetPath)
  const normalizedRelative = relative && relative !== '.' ? relative.split(path.sep).join('/') : ''
  const rootName = path.basename(rootPath) || rootPath
  const empty = (error, notFound = false) => ({
    available: true, error, notFound, rootName, rootPath, rootPaths: allowedRoots, relativePath: normalizedRelative, folders: [], tracks: [], trackCount: 0, totalTracks: 0,
  })

  if (isOutside(rootPath, targetPath)) return empty('Folder is outside the selected music folder', true)
  if (normalizedRelative.split('/').some(segment => segment.startsWith('.'))) return empty('Dot-prefixed folders are hidden', true)

  let entries
  try {
    const realRoot = fs.realpathSync(rootPath)
    const realTarget = fs.realpathSync(targetPath)
    if (isOutside(realRoot, realTarget) || !fs.statSync(realTarget).isDirectory()) {
      return empty('Folder is not available inside the selected music folder', true)
    }
    entries = fs.readdirSync(targetPath, { withFileTypes: true })
  } catch {
    return empty('This folder is no longer available', true)
  }

  // Query descendant paths once, not once per child folder. Verify they still
  // exist so stale index rows do not inflate counts or Play All.
  const descendantTrackPaths = getExistingTrackPaths(db, targetPath)
  if (normalizedRelative && descendantTrackPaths.length === 0) return empty('Folder has no tracks', true)
  const folderTrackCounts = new Map()
  for (const filePath of descendantTrackPaths) {
    const relativeTrackPath = path.relative(targetPath, filePath)
    const separator = relativeTrackPath.indexOf(path.sep)
    if (separator <= 0) continue
    const childName = relativeTrackPath.slice(0, separator)
    const childKey = process.platform === 'win32' ? childName.toLowerCase() : childName
    folderTrackCounts.set(childKey, (folderTrackCounts.get(childKey) || 0) + 1)
  }

  // If a child folder has no explicit cover/folder image, use distinct
  // artwork from its indexed tracks. Album folders normally yield one cover;
  // artist/collection folders can yield several and render a small collage.
  const indexedPathSet = new Set(descendantTrackPaths)
  const artworkByChild = new Map()
  try {
    const { prefix: artworkPrefix, upperBound: artworkUpperBound } = getPathPrefixBounds(targetPath)
    const rows = db.prepare(
      "SELECT id, file_path, artwork_path, artwork_url FROM tracks WHERE file_path >= ? AND file_path < ? AND file_path NOT LIKE 'ghost://%' AND (artwork_path IS NOT NULL OR artwork_url IS NOT NULL) ORDER BY file_path ASC"
    ).all(artworkPrefix, artworkUpperBound)
    for (const row of rows) {
      if (!indexedPathSet.has(row.file_path)) continue
      const relativeTrackPath = path.relative(targetPath, row.file_path)
      const separator = relativeTrackPath.indexOf(path.sep)
      if (separator <= 0) continue
      const childName = relativeTrackPath.slice(0, separator)
      const childKey = process.platform === 'win32' ? childName.toLowerCase() : childName
      const artworkPath = row.artwork_path && isExistingFile(row.artwork_path) ? row.artwork_path : null
      const artworkUrl = row.artwork_url || null
      if (!artworkPath && !artworkUrl) continue
      const fingerprint = artworkPath ? artworkFingerprint(artworkPath) : null
      const artworkIdentity = artworkPath
        ? (fingerprint ? 'image:' + fingerprint : 'file:' + (process.platform === 'win32' ? path.resolve(artworkPath).toLowerCase() : path.resolve(artworkPath)))
        : 'url:' + artworkUrl
      let covers = artworkByChild.get(childKey)
      if (!covers) { covers = new Map(); artworkByChild.set(childKey, covers) }
      if (!covers.has(artworkIdentity)) {
        covers.set(artworkIdentity, { id: row.id, artwork_path: artworkPath, artwork_url: artworkUrl })
      }
    }
  } catch {}

  const folders = entries
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const fullPath = path.join(targetPath, entry.name)
      const childRelative = path.relative(rootPath, fullPath).split(path.sep).join('/')
      const childKey = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
      const artworkPath = findFolderArtwork(fullPath)
      const artworkTracks = [...(artworkByChild.get(childKey)?.values() || [])].slice(0, 4)
      return {
        name: entry.name,
        path: childRelative,
        trackCount: folderTrackCounts.get(childKey) || 0,
        artwork_path: artworkPath,
        artwork_tracks: artworkTracks,
      }
    })
    .filter(folder => !folder.name.startsWith('.') && folder.trackCount > 0)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))

  const trackPaths = entries
    .filter(entry => entry.isFile() && AUDIO_EXTS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => path.join(targetPath, entry.name))
  const tracks = []
  for (let i = 0; i < trackPaths.length; i += 500) {
    const batch = trackPaths.slice(i, i + 500)
    if (!batch.length) continue
    const placeholders = batch.map(() => '?').join(',')
    tracks.push(...db.prepare(
      "SELECT * FROM tracks WHERE file_path IN (" + placeholders + ") AND file_path NOT LIKE 'ghost://%'"
    ).all(...batch))
  }

  tracks.sort((left, right) =>
    String(left.title || '').localeCompare(String(right.title || ''), undefined, { numeric: true, sensitivity: 'base' })
  )

  const { prefix: targetPrefix, upperBound: targetUpperBound } = getPathPrefixBounds(targetPath)
  const totalTracks = Math.max(tracks.length, descendantTrackPaths.length)

  // Play All should include every existing descendant when the current folder
  // itself has no direct tracks. Batch IN lookups to stay under SQLite's bind limit.
  let allTracks = tracks
  if (tracks.length === 0 && totalTracks > 0) {
    allTracks = getTracksForPaths(db, descendantTrackPaths)
  }

  const query = typeof search === 'string' ? search.trim() : ''
  let deepTracks = []
  if (query) {
    const term = '%' + escapeLike(query) + '%'
    const likeEscape = " ESCAPE '" + String.fromCharCode(92) + "'"
    try {
      if (db && typeof db.prepare === 'function') {
        const sql = "SELECT * FROM tracks WHERE file_path >= ? AND file_path < ? AND (" +
          "title LIKE ?" + likeEscape + " OR " +
          "artist LIKE ?" + likeEscape + " OR " +
          "album LIKE ?" + likeEscape + " OR " +
          "substr(file_path, length(?)+1) LIKE ?" + likeEscape + ") " +
          "AND file_path NOT LIKE 'ghost://%' ORDER BY file_path ASC"
        const stmt = db.prepare(sql)
        if (stmt && typeof stmt.all === 'function') {
          deepTracks = (stmt.all(targetPrefix, targetUpperBound, term, term, term, targetPrefix, term) || [])
            .filter(track => isExistingFile(track.file_path))
          for (const track of deepTracks) {
            const trackDir = path.dirname(track.file_path)
            const subRel = path.relative(rootPath, trackDir).split(path.sep).join('/')
            track.subfolderPath = subRel
          }
        }
      }
    } catch {}
  }

  return {
    available: true,
    rootName,
    rootPath,
    rootPaths: allowedRoots,
    relativePath: normalizedRelative,
    folders,
    tracks,
    trackCount: tracks.length,
    totalTracks,
    allTracks,
    deepTracks,
    search: query,
  }
}

module.exports = { findFolderArtwork, getLibraryFolders, resolveLibraryFolderTarget, getTrackRowsUnderFolder, renameLibraryFolders, configuredMusicRoots }

