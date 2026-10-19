const { registerNativeOutput, closeNativeOutput } = require('./audio/output')
const { app, BrowserWindow, ipcMain, shell, globalShortcut, screen, protocol, net, powerSaveBlocker, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const { configureMprisIdentity } = require('./mpris')
configureMprisIdentity(app)
// Keep the renderer at normal priority on Windows while minimized so the
// AudioWorklet/native output path is not starved by backgrounding.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-renderer-backgrounding')
const fs = require('fs')
const log = require('electron-log')
const { attachFullscreenSleepBlocker } = require('./fullscreenSleepBlocker')

const date = new Date().toISOString().replace(/[:.]/g, '-')
log.transports.file.fileName = `lokal-${date}.log`
log.transports.file.level = 'info'
log.errorHandler.startCatching()
Object.assign(console, log.functions)

const { autoUpdater } = require('electron-updater')
const { initDB, getDB } = require('./ipc/db')
const { registerScannerHandlers, registerExtraHandlers, registerV4Handlers, AUDIO_EXTS } = require('./ipc/scanner')
const { registerMixesHandlers } = require('./ipc/mixes')
const { registerPlayerHandlers } = require('./ipc/player')
const { registerDownloaderHandlers, registerExtraDownloaderHandlers, registerPlaylistArchiveHandlers, markInterruptedPlaylistsIncomplete, shutdownActiveDownloads } = require('./ipc/downloader')
const { registerLyricsHandlers } = require('./ipc/lyrics')
const { registerArtworkFxHandlers } = require('./ipc/artworkFx')
const { registerFollowedArtistsHandlers } = require('./ipc/followedArtists')
const { registerCacheHandlers } = require('./ipc/cache')
const { registerRadioHandlers } = require('./ipc/radio')
const { registerUserHandlers } = require('./ipc/users')
const { registerDiscordHandlers, disconnectForQuit } = require('./ipc/discord')
const { registerLastFmHandlers } = require('./ipc/lastfm')
const { registerListenBrainzHandlers } = require('./ipc/listenbrainz')
const { registerToolsHandlers } = require('./ipc/tools')
const { registerPlaylistHandlers } = require('./ipc/playlists')
const { initPlugins, registerPluginHandlers } = require('./ipc/plugins')
const { registerRecapHandlers } = require('./ipc/recaps')
const { registerLibraryKeysHandlers } = require('./ipc/libraryKeys')
const { registerQualityHandlers } = require('./ipc/quality')
const { setRemoteState, setRemoteCommandHandler, getRemoteConnectionInfo } = require('./ipc/remote')
const { updateThumbarButtons, registerThumbarHandlers } = require('./ipc/thumbar')
const { registerSmtcHandlers, updateSmtcState, stopSmtcBridge } = require('./ipc/smtc')
const { registerOnlineHandlers, registerStreamScheme, registerStreamProtocol } = require('./ipc/online')
const { registerSpotifyLikesHandlers } = require('./ipc/spotifyLikes')
const { registerAutomixHandlers } = require('./ipc/automix')
const { registerFlowHandlers } = require('./ipc/flow')
const { registerCastHandlers, shutdownCast } = require('./ipc/cast')
// Online songs stream from lokal-stream://; the scheme has to be declared before the app is ready.
try { registerStreamScheme(protocol) } catch (e) { console.error('registerStreamScheme:', e.message) }
let isUpdating = false;
let quitting = false // set once quitting starts: nothing opens a window again
const APP_PROTOCOL = 'lokal'
let pendingLastfmAuthToken = ''
let pendingOpenFilePath = ''

function findAudioFileArg(argv = []) {
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.startsWith('--') || arg.startsWith(`${APP_PROTOCOL}://`)) continue
    const ext = path.extname(arg).toLowerCase()
    if (AUDIO_EXTS.has(ext) && fs.existsSync(arg)) return path.resolve(arg)
  }
  return ''
}

function extractLastfmAuthToken(raw) {
  try {
    console.log('[DEEPLINK RAW]', raw)
    const parsed = new URL(raw)
    if (parsed.protocol !== `${APP_PROTOCOL}:`) return ''
    const target = `${parsed.host}${parsed.pathname}`
    .replace(/^\/+/, '')
    .replace(/\/+$/, '') 

  if (target !== 'lastfm-auth') return ''
    return parsed.searchParams.get('token') || ''
  } catch {
    return ''
  }
}

function emitLastfmAuthToken(token) {
  if (!token) return false

  pendingLastfmAuthToken = token

  if (!mainWindow || mainWindow.isDestroyed()) return false

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()

  const sendToken = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('lastfm:auth-token', pendingLastfmAuthToken)
    pendingLastfmAuthToken = ''
  }

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', sendToken)
  } else {
    sendToken()
  }
  console.log('[DEEPLINK TOKEN]', token)
  return true
}

function emitOpenFilePath(filePath) {
  if (!filePath) return false

  pendingOpenFilePath = filePath

  if (!mainWindow || mainWindow.isDestroyed()) return false

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()

  const sendPath = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('player:openFile', pendingOpenFilePath)
    pendingOpenFilePath = ''
  }

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', sendPath)
  } else {
    sendPath()
  }
  return true
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    const protocolUrl = commandLine.find(arg => typeof arg === 'string' && arg.startsWith(`${APP_PROTOCOL}://`))
    const token = extractLastfmAuthToken(protocolUrl || '')
    if (token) {
      emitLastfmAuthToken(token)
    }
    const filePath = findAudioFileArg(commandLine)
    if (filePath) {
      emitOpenFilePath(filePath)
    }
    // No window: macOS keeps the app running without one, so it gets a new
    // one; opened again while quitting, there's nothing to show.
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (!quitting && app.isReady()) createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
// Only ever offer stable releases. Nightlies are versioned like
// 2.0.3-nightly.42, and for a pre-release version electron-updater switches to
// looking for the newest release on the same "nightly" channel. There is none,
// so every check on a nightly failed (and the app showed that failure as an
// "Update Available" popup). With this off, a nightly is compared with the
// Latest release: 2.0.2 is older than 2.0.3-nightly.N (no prompt), and the
// official 2.0.3 is newer (prompt).
autoUpdater.allowPrerelease = false
// Nightly builds don't look for updates at all: someone on a nightly chose
// it, and being offered the stable release (older in features once the
// nightly moves on) makes no sense. New nightlies come from GitHub Releases.
const IS_NIGHTLY = /-nightly\./i.test(app.getVersion())

autoUpdater.on('update-available', (info) => {
  if (mainWindow) {
    mainWindow.webContents.send('updater:available', info)
  }
})

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) {
    mainWindow.webContents.send('updater:progress', progress)
  }
})

autoUpdater.on('update-downloaded', () => {
  if (mainWindow) {
    mainWindow.webContents.send('updater:ready')
  }
})

autoUpdater.on('error', (err) => {
  if (mainWindow) {
    mainWindow.webContents.send('updater:error', err.message)
  }
})


const settingsPath = path.join(app.getPath('userData'), 'performance-settings.json')

// Settings > About > Hardware Acceleration. Read once at startup: Chromium
// only takes the GPU switches before the app is ready, so a change needs a
// restart. (A Graphics Backend choice was saved here too, for the white
// flash Direct3D 11 showed on restore from the taskbar before Electron 44;
// it's ignored now, and dropped on the next save.)
function loadPerformanceSettings() {
  const defaults = { hardwareAcceleration: true, performanceMode: false }
  try {
    if (fs.existsSync(settingsPath)) {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      if (saved && typeof saved === 'object') return { ...defaults, ...saved }
    }
  } catch (e) {}
  return defaults
}
// Written to a temporary file and renamed over the old one, so an interrupted
// write can't leave a truncated file (which would load as the defaults).
function writePerformanceSettings(next) {
  const tmp = `${settingsPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, settingsPath)
}


const perfSettings = loadPerformanceSettings()


if (perfSettings.hardwareAcceleration === false) {
  app.disableHardwareAcceleration()
  
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService')

// The window's own colour, shown before the page paints (start-up, resizing):
// the theme's background, remembered from the last run so a light theme
// doesn't open on a dark frame (or the other way round).
const windowBgPath = path.join(app.getPath('userData'), 'window-background.txt')
const HEX_COLOR = /^#[0-9a-f]{6}$/i
function savedWindowBackground() {
  try {
    const value = fs.readFileSync(windowBgPath, 'utf8').trim()
    if (HEX_COLOR.test(value)) return value
  } catch {}
  return '#0a0a0a'
}

let mainWindow
const NORMAL_MIN_WIDTH = 960
const NORMAL_MIN_HEIGHT = 640
// Mini-player width stays fixed, while height starts at the measured
// default-scale content height and is then adjusted by MiniPlayer whenever
// its actual content size changes (for example from text scaling/wrapping).
const MINI_DEFAULT_WIDTH = 420
const MINI_DEFAULT_HEIGHT = 246
const MINI_MIN_HEIGHT = 120
const MINI_MAX_HEIGHT = 800
// Electron 29.1.0 has a macOS bug where setMaximumSize(0, 0) -- the
// documented way to remove a maximum -- doesn't actually lift it, leaving
// the window locked at whatever size it had when mini mode was toggled off.
// An explicit size well past any real display works around it.
const NORMAL_MAX_WIDTH = 100000
const NORMAL_MAX_HEIGHT = 100000
const windowStatePath = path.join(app.getPath('userData'), 'window-state.json')
let miniModeRestoreState = null
let miniModeEnabled = false
let mediaKeysPreferred = false
const MEDIA_SHORTCUTS = ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack']

function enforceMiniTop() {
  if (!mainWindow || !miniModeEnabled) return
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.moveTop()
}

// Used when entering mini mode so the resize-to-mini-size and the
// re-centering happen as a single setBounds call instead of a separate
// setSize followed by a separate center() -- two native calls means two
// relayouts (and, on some platforms, two visible steps) instead of one.
function centeredBounds(width, height, referenceBounds) {
  const display = screen.getDisplayMatching(referenceBounds || mainWindow.getBounds())
  const area = display.workArea
  const x = Math.round(area.x + (area.width - width) / 2)
  const y = Math.round(area.y + (area.height - height) / 2)
  return { x, y, width, height }
}

function validWindowBounds(bounds) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null
  if (bounds.width < NORMAL_MIN_WIDTH || bounds.height < NORMAL_MIN_HEIGHT) return null
  const displays = screen.getAllDisplays()
  const visible = displays.some(display => {
    const area = display.workArea
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
  })
  return visible ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } : null
}

function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'))
    const bounds = validWindowBounds(saved?.bounds)
    return bounds ? { bounds, maximized: saved.maximized === true } : null
  } catch { return null }
}

function closesToTray() {
  try {
    return getDB().prepare("SELECT value FROM settings WHERE key = 'close_to_tray'").get()?.value === '1'
  } catch {
    return false
  }
}

// Settings > About > "Close to Tray": the close button hides the window
// (its taskbar icon goes too) and leaves this tray icon to bring it back.
let tray = null
function showFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
// The icon with the sticker in the theme's accent colour, sent by the page
// (src/accentAppIcon.js); null until it arrives.
let accentIcon = null
const trayImage = image => image.resize(process.platform === 'win32' ? { width: 32, height: 32 } : { width: 16, height: 16 })

function loadTrayIcon() {
  if (accentIcon) return accentIcon
  const filenames = process.platform === 'win32'
    ? ['lokal-icon.ico', 'lokal-icon.png']
    : ['lokal-icon.png', 'lokal-icon.ico']
  const roots = app.isPackaged
    ? [path.join(app.getAppPath(), 'dist'), path.join(process.resourcesPath, 'app.asar', 'dist')]
    : [path.join(__dirname, '../public'), path.join(app.getAppPath(), 'dist')]

  for (const root of roots) {
    for (const filename of filenames) {
      const iconPath = path.join(root, filename)
      if (!fs.existsSync(iconPath)) continue
      const image = nativeImage.createFromPath(iconPath)
      if (!image.isEmpty()) return image
    }
  }
  log.error('[tray] Could not load Lokal tray icon from packaged or development assets')
  return nativeImage.createEmpty()
}

function hideToTray() {
  if (!tray || tray.isDestroyed()) {
    const image = loadTrayIcon()
    if (image.isEmpty()) {
      // Don't silently hide the only window when the tray icon could not load.
      log.error('[tray] Refusing to hide the window without a visible tray icon')
      return false
    }
    tray = new Tray(accentIcon || process.platform !== 'win32' ? trayImage(image) : image)
    tray.setToolTip('Lokal')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Lokal', click: showFromTray },
      { type: 'separator' },
      { label: 'Quit Lokal', click: () => app.quit() },
    ]))
    tray.on('click', showFromTray)
  }
  mainWindow.hide()
  return true
}
function removeTray() {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || miniModeEnabled) return
  const bounds = validWindowBounds(typeof mainWindow.getNormalBounds === 'function' ? mainWindow.getNormalBounds() : mainWindow.getBounds())
  if (!bounds) return
  try {
    const tmp = `${windowStatePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ bounds, maximized: mainWindow.isMaximized() }))
    fs.renameSync(tmp, windowStatePath)
  } catch {}
}

let saveWindowStateTimer = null
function scheduleSaveWindowState() {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer)
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = null
    saveWindowState()
  }, 250)
  saveWindowStateTimer.unref?.()
}
function flushSaveWindowState() {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer)
  saveWindowStateTimer = null
  saveWindowState()
}

function emitPlayerCommand(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('remote:command', { action })
}

function unregisterMediaShortcuts() {
  for (const accelerator of MEDIA_SHORTCUTS) {
    try { globalShortcut.unregister(accelerator) } catch {}
  }
}

function registerMediaShortcuts() {
  unregisterMediaShortcuts()
  const handlers = {
    MediaPlayPause: () => emitPlayerCommand('togglePlay'),
    MediaNextTrack: () => emitPlayerCommand('next'),
    MediaPreviousTrack: () => emitPlayerCommand('prev'),
  }
  let allRegistered = true
  for (const accelerator of MEDIA_SHORTCUTS) {
    try {
      const ok = globalShortcut.register(accelerator, handlers[accelerator])
      if (!ok) allRegistered = false
    } catch {
      allRegistered = false
    }
  }
  return allRegistered
}

function setPreferredMediaKeys(enabled) {
  const next = Boolean(enabled)
  if (next) {
    const ok = registerMediaShortcuts()
    mediaKeysPreferred = ok
    return { ok, enabled: mediaKeysPreferred }
  }
  unregisterMediaShortcuts()
  mediaKeysPreferred = false
  return { ok: true, enabled: false }
}

function createWindow() {
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, process.platform === 'win32' ? '../public/lokal-icon.ico' : '../public/lokal-icon.png'),
    ...(saved?.bounds || { width: 1400, height: 860 }), minWidth: NORMAL_MIN_WIDTH, minHeight: NORMAL_MIN_HEIGHT,
    useContentSize: true,
    resizable: true,
    frame: false, backgroundColor: savedWindowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      // A music player's timers shouldn't slow down while minimized. (This
      // didn't cause the white flash on restore.) The page
      // learns it's minimized through 'window:visibility' instead, to pause
      // what nobody sees.
      backgroundThrottling: false,
    },
  })
  mainWindow.webContents.on('render-process-gone', closeNativeOutput)
  mainWindow.webContents.on('did-start-loading', closeNativeOutput)
  mainWindow.on('closed', () => {
    closeNativeOutput()
    // The app ends with its window (macOS aside). Hidden helper windows (the
    // fast YouTube engine's sandbox, its attestation page, Spotify's canvas
    // lookup) would otherwise keep it running unseen, and opening Lokal again
    // would only find that window-less copy.
    if (process.platform !== 'darwin' || isUpdating) app.quit()
  })
  attachFullscreenSleepBlocker(mainWindow, { app, powerSaveBlocker })
  const sendVisibility = (hidden) => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('window:visibility', hidden) }
  mainWindow.on('minimize', () => sendVisibility(true))
  mainWindow.on('hide', () => sendVisibility(true))
  mainWindow.on('restore', () => sendVisibility(false))
  mainWindow.on('show', () => sendVisibility(false))
  mainWindow.on('resize', scheduleSaveWindowState)
  mainWindow.on('move', scheduleSaveWindowState)
  mainWindow.on('maximize', scheduleSaveWindowState)
  mainWindow.on('unmaximize', scheduleSaveWindowState)
  // Settings > "Close to Tray": the window's close button (or Ctrl+W) hides
  // it to the tray. Quitting (Cmd+Q, the tray menu, an update) sets
  // `quitting` in before-quit first, so it still quits.
  mainWindow.on('close', (event) => {
    flushSaveWindowState()
    if (quitting || isUpdating || !closesToTray()) return
    if (hideToTray()) event.preventDefault()
  })
  mainWindow.on('show', removeTray)
  if (saved?.maximized) mainWindow.maximize()

  
  
  // Electron 35+ passes one details object (level as 'info' | 'warning' |
  // 'error' | 'debug'); the old positional arguments are gone.
  mainWindow.webContents.on('console-message', (event) => {
    const level = event.level
    if (!['warning', 'error'].includes(level) && process.env.LOKAL_DEBUG_CONSOLE !== '1') return
    const logLevel = { debug: 'debug', info: 'info', warning: 'warn', error: 'error' }[level] || 'info'
    log[logLevel](`[Renderer:${event.sourceId}:${event.lineNumber}] ${event.message}`)
  })
  
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('perf-settings', perfSettings)
    if (pendingLastfmAuthToken) {
      mainWindow.webContents.send('lastfm:auth-token', pendingLastfmAuthToken)
      pendingLastfmAuthToken = ''
    }
    if (pendingOpenFilePath) {
      mainWindow.webContents.send('player:openFile', pendingOpenFilePath)
      pendingOpenFilePath = ''
    }
  })

  mainWindow.on('focus', enforceMiniTop)
  mainWindow.on('blur', enforceMiniTop)
  mainWindow.on('show', enforceMiniTop)
  mainWindow.on('restore', enforceMiniTop)

  mainWindow.on('app-command', (event, command) => {
    if (command === 'browser-backward') {
      event.preventDefault()
      mainWindow.webContents.send('navigation:history', -1)
    } else if (command === 'browser-forward') {
      event.preventDefault()
      mainWindow.webContents.send('navigation:history', 1)
    }
  })

  updateThumbarButtons(mainWindow, {})
  
  
  if (!app.isPackaged) {
    
    mainWindow.loadURL('http://localhost:5173')
  } else {
    
    const filePath = path.join(__dirname, '../dist/index.html')
    mainWindow.loadFile(filePath)
  }
}
app.name = 'Lokal'
app.whenReady().then(() => {
  if (!gotTheLock) return;
  try { require('../server/index.js') } catch (e) { console.error('Server already running or port blocked:', e.message) }
  app.name = 'Lokal'
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL)
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  }
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.lokal.music');
  }
  try { initDB() } catch (e) { console.error('DB:', e.message) }
  try {
    const db = getDB()
    const plural = db.prepare("SELECT value FROM settings WHERE key = 'music_folders'").get()?.value
    let folders = []
    try { folders = Array.isArray(JSON.parse(plural || 'null')) ? JSON.parse(plural) : [] } catch {}
    if (!folders.length) {
      const legacy = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value
      if (legacy) folders = [legacy]
    }
    require('./libraryWatcher').watchLibraryRoots(folders)
  } catch (e) { console.error('Library watcher:', e.message) }
  try { markInterruptedPlaylistsIncomplete() } catch (e) { console.error('Downloads:', e.message) }
  try { initPlugins() } catch (e) { console.error('Plugins:', e.message) }
  try {
    const db = getDB()
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'prefer_media_keys'").get()
    const preferred = setting?.value === '1'
    setPreferredMediaKeys(preferred)
  } catch (e) {
    console.warn('media key preference load failed:', e.message)
  }

  for (const fn of [
    registerScannerHandlers, registerPlayerHandlers, registerDownloaderHandlers,
    registerExtraDownloaderHandlers, registerPlaylistArchiveHandlers, registerLyricsHandlers, registerUserHandlers,
    registerDiscordHandlers, registerExtraHandlers, registerV4Handlers, registerLastFmHandlers, registerListenBrainzHandlers,
    registerToolsHandlers, registerPlaylistHandlers, registerMixesHandlers, registerPluginHandlers, registerRecapHandlers,
    registerQualityHandlers, registerLibraryKeysHandlers, registerRadioHandlers
  ]) {
    try { fn(ipcMain) } catch (e) { console.error(fn.name + ':', e.message) }
  }
  registerNativeOutput(ipcMain, () => mainWindow)
  try { registerThumbarHandlers(ipcMain, () => mainWindow) } catch (e) { console.error('registerThumbarHandlers:', e.message) }
  try { registerSmtcHandlers(ipcMain, () => mainWindow) } catch (e) { console.error('registerSmtcHandlers:', e.message) }
  try { registerArtworkFxHandlers(ipcMain) } catch (e) { console.error('registerArtworkFxHandlers:', e.message) }
  try { registerFollowedArtistsHandlers(ipcMain) } catch (e) { console.error('registerFollowedArtistsHandlers:', e.message) }
  try { registerCacheHandlers(ipcMain) } catch (e) { console.error('registerCacheHandlers:', e.message) }
  try { registerOnlineHandlers(ipcMain) } catch (e) { console.error('registerOnlineHandlers:', e.message) }
  try { registerSpotifyLikesHandlers(ipcMain) } catch (e) { console.error('registerSpotifyLikesHandlers:', e.message) }
  try { registerAutomixHandlers(ipcMain) } catch (e) { console.error('registerAutomixHandlers:', e.message) }
  try { registerFlowHandlers(ipcMain) } catch (e) { console.error('registerFlowHandlers:', e.message) }
  try { registerCastHandlers(ipcMain, { getWindow: () => mainWindow, powerSaveBlocker }) } catch (e) { console.error('registerCastHandlers:', e.message) }
  try { registerStreamProtocol(protocol, net) } catch (e) { console.error('registerStreamProtocol:', e.message) }
  // SpotiFLAC repositories are refreshed at every launch (in the background,
  // once the window has had time to open), so updates and new sources show
  // without visiting Settings first.
  setTimeout(() => {
    try {
      const packages = require('./spotiflac/packages').service(getDB())
      // Only for people using SpotiFLAC sources: nothing is fetched otherwise.
      if (packages.list().length || packages.repos().length > 1) packages.refreshDue(0).catch(e => console.error('SpotiFLAC repository refresh:', e.message))
    } catch (e) { console.error('SpotiFLAC repository refresh:', e.message) }
  }, 8000).unref?.()


  ipcMain.on('app:setAccentIcon', (_, dataUrl) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 2 * 1024 * 1024) return
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) return
    accentIcon = image
    try {
      if (process.platform === 'darwin') app.dock?.setIcon(image)
      else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(image)
      if (tray && !tray.isDestroyed()) tray.setImage(trayImage(image))
    } catch (e) { log.warn('[icon] Could not apply the accent icon:', e.message) }
  })

  ipcMain.on('relaunch-app', () => {
    app.relaunch()
    app.exit()
  })

  
  ipcMain.handle('perf:save', async (_, newSettings) => {
    try {
      const next = { ...loadPerformanceSettings() }
      if (typeof newSettings?.hardwareAcceleration === 'boolean') next.hardwareAcceleration = newSettings.hardwareAcceleration
      if (typeof newSettings?.performanceMode === 'boolean') next.performanceMode = newSettings.performanceMode
      delete next.graphicsBackend
      writePerformanceSettings(next)
      // Performance Mode is live; hardware acceleration still takes effect on restart.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('perf-settings', next)
      return { success: true }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('updater:download', async () => {
  return await autoUpdater.downloadUpdate()
})

  // What's saved (the next launch) plus what this launch is running with, so
  // Settings can say a restart is still needed.
  ipcMain.handle('perf:load', async () => {
    const { graphicsBackend, ...saved } = loadPerformanceSettings()
    return {
      ...saved,
      platform: process.platform,
      running: {
        hardwareAcceleration: perfSettings.hardwareAcceleration !== false,
      },
    }
  })
  ipcMain.handle('mediaKeys:setPreferred', async (_, flag) => {
    const result = setPreferredMediaKeys(flag)
    try {
      getDB().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('prefer_media_keys', ?)").run(result.enabled ? '1' : '0')
    } catch {}
    return result
  })
  ipcMain.on('app-log', (event, { level, message }) => {
    if (log[level]) {
      log[level](`[Renderer] ${message}`);
    } else {
      log.info(`[Renderer] ${message}`);
    }
  });
  ipcMain.on('remote:stateUpdate', (_, state) => {
    setRemoteState(state)
    updateSmtcState(state || {})
  })
  ipcMain.handle('remote:getConnectionInfo', async () => {
    const fallback = getRemoteConnectionInfo()
    const port = Number(process.env.PORT) || 3421
    const headers = {}
    const remoteToken = String(process.env.REMOTE_TOKEN || '').trim()
    const apiKey = String(process.env.API_KEY || '').trim()
    if (remoteToken) headers['x-remote-token'] = remoteToken
    if (apiKey) headers['x-api-key'] = apiKey
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/remote/connection`, { headers })
      const data = await response.json().catch(() => ({}))
      if (response.ok) return { ...data, serverReachable: true, platform: process.platform }
      if (data.disabled) return { ...fallback, disabled: true, serverReachable: true, platform: process.platform }
      return { ...fallback, serverReachable: false, error: data.error || `Remote server returned HTTP ${response.status}`, platform: process.platform }
    } catch (e) {
      return { ...fallback, serverReachable: false, error: e?.message || 'Could not reach the remote server', platform: process.platform }
    }
  })
  setRemoteCommandHandler(async (command) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'Main window unavailable' }
    }
    mainWindow.webContents.send('remote:command', command || {})
    return { ok: true }
  })
  ipcMain.handle('dialog:openFolder', async () => {
    const r = await require('electron').dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return r.filePaths[0] || null
  })
  ipcMain.handle('dialog:openFile', async (_, options) => {
    const normalized = Array.isArray(options) ? { filters: options } : (options || {})
    const properties = normalized.multiple ? ['openFile', 'multiSelections'] : ['openFile']
    const r = await require('electron').dialog.showOpenDialog(mainWindow, {
      properties,
      filters: normalized.filters || [{ name: 'Files', extensions: ['jpg','jpeg','png','webp','lrc','txt','ttl','ttml'] }]
    })
    return normalized.multiple ? r.filePaths : (r.filePaths[0] || null)
  })
  ipcMain.handle('dialog:readFileBinary', async (_, fp) => require('fs').readFileSync(fp, 'utf8'))
  ipcMain.handle('dialog:readFileAsDataURL', async (_, fp) => {
  try {
    const sharp = require('sharp');
    const buffer = await sharp(fp)
      .resize(512, 512, {
        fit: 'cover',  
        position: 'centre' 
      })
      .jpeg({ quality: 80 }) 
      .toBuffer();

    const base64 = buffer.toString('base64');
    return `data:image/jpeg;base64,${base64}`;
  } catch (e) {
    console.error('Error processing artwork:', e);
    try {
      const fs = require('fs');
      return `data:image/jpeg;base64,${fs.readFileSync(fp).toString('base64')}`;
    } catch (err) {
      return null;
    }
  }
});

  
ipcMain.handle('tv:setFullscreen', (_, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  mainWindow.setFullScreen(!!enabled)
  return true
})

ipcMain.handle('tv:setZoom', (_, factor) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false

  const zoom = Number(factor)
  if (!Number.isFinite(zoom)) return false

  mainWindow.webContents.setZoomFactor(
    Math.max(0.5, Math.min(2, zoom))
  )
  return true
})

ipcMain.handle('window:minimize', () => mainWindow?.minimize())
// Whether the window is minimized or hidden now, for a page that subscribes
// to 'window:visibility' after the last change was sent.
ipcMain.handle('window:isHidden', () => !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible())
// Follows the theme (see savedWindowBackground).
ipcMain.handle('window:setBackgroundColor', (_, color) => {
  if (typeof color !== 'string' || !HEX_COLOR.test(color)) return false
  mainWindow?.setBackgroundColor(color)
  try { if (savedWindowBackground() !== color) fs.writeFileSync(windowBgPath, color) } catch {}
  return true
})
ipcMain.handle('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize())
ipcMain.handle('window:close', () => mainWindow?.close())
ipcMain.handle('window:setAlwaysOnTop', (_, flag) => { 
  if (mainWindow) {
    if (flag) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      mainWindow.moveTop()
    } else {
      mainWindow.setAlwaysOnTop(false)
      mainWindow.setVisibleOnAllWorkspaces(false)
    }
  }
})
ipcMain.handle('window:setSize', (_, width, height) => {
  if (mainWindow) {
    mainWindow.setSize(width, height)
    mainWindow.center()
  }
})
ipcMain.handle('window:setMiniMode', (_, enabled) => {
  if (!mainWindow) return false
  const isEnabled = Boolean(enabled)
  if (isEnabled) {
    miniModeEnabled = true
    if (!miniModeRestoreState) {
      miniModeRestoreState = {
        bounds: mainWindow.getBounds(),
        wasMaximized: mainWindow.isMaximized(),
      }
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    mainWindow.show()
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    // Keep the width fixed and seed the height with the measured default
    // content height. MiniPlayer reports its actual content height after
    // mounting and whenever its layout changes; window:fitMiniHeight then
    // adjusts only the height while keeping the current position.
    mainWindow.setResizable(false)
    mainWindow.setMinimumSize(MINI_DEFAULT_WIDTH, MINI_DEFAULT_HEIGHT)
    mainWindow.setMaximumSize(MINI_DEFAULT_WIDTH, MINI_DEFAULT_HEIGHT)
    // One setBounds call instead of setSize + center(): each is a separate
    // native resize/move, i.e. a separate relayout, and doing them back to
    // back was part of what made this transition look janky.
    mainWindow.setBounds(centeredBounds(MINI_DEFAULT_WIDTH, MINI_DEFAULT_HEIGHT, miniModeRestoreState.bounds), true)
    enforceMiniTop()
    return true
  }
  miniModeEnabled = false
  mainWindow.setAlwaysOnTop(false)
  mainWindow.setVisibleOnAllWorkspaces(false)
  mainWindow.setResizable(true)
  mainWindow.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT)
  mainWindow.setMaximumSize(NORMAL_MAX_WIDTH, NORMAL_MAX_HEIGHT) // undoes the mini-mode lock above
  if (miniModeRestoreState?.bounds) {
    mainWindow.setBounds(miniModeRestoreState.bounds, true)
    if (miniModeRestoreState.wasMaximized) mainWindow.maximize()
  }
  miniModeRestoreState = null
  return true
})
ipcMain.handle('window:fitMiniHeight', (_, rawHeight) => {
  if (!mainWindow || !miniModeEnabled) return false
  const numericHeight = Number(rawHeight)
  if (!Number.isFinite(numericHeight)) return false

  const height = Math.round(Math.max(MINI_MIN_HEIGHT, Math.min(MINI_MAX_HEIGHT, numericHeight)))
  const bounds = mainWindow.getBounds()
  if (bounds.width === MINI_DEFAULT_WIDTH && bounds.height === height) return true

  mainWindow.setMinimumSize(MINI_DEFAULT_WIDTH, height)
  mainWindow.setMaximumSize(MINI_DEFAULT_WIDTH, height)
  mainWindow.setBounds({
    ...bounds,
    width: MINI_DEFAULT_WIDTH,
    height,
  }, true)
  enforceMiniTop()
  return true
})
ipcMain.handle('window:getSize', () => {
  if (mainWindow) {
    return mainWindow.getSize()
  }
  return [1400, 860]
})
// Windows + frame:false + `-webkit-app-region: drag` (our custom titlebar)
// is a known combination for the OS-level hit-test map going stale: after a
// burst of overlapping layout/paint changes near the titlebar -- exactly
// what closing the fullscreen player's Lyrics/Queue side panel does, since
// that unmounts a wide subtree at the same time the whole overlay is fading
// out -- Chromium can keep answering mouse input using a snapshot of the
// old layout, so every click lands offset from the cursor until something
// forces a recompute. A real restart fixes it by re-establishing the
// window from scratch; a genuine (if imperceptible) bounds change forces
// the same recompute without one. See e.g. electron/electron#7347 and
// #51252 for the same class of bug.
ipcMain.handle('window:refreshHitRegions', () => {
  if (!mainWindow) return
  const b = mainWindow.getBounds()
  mainWindow.setBounds({ ...b, width: b.width + 1 })
  mainWindow.setBounds(b)
})

createWindow()

const bootProtocolUrl = process.argv.find(arg => typeof arg === 'string' && arg.startsWith(`${APP_PROTOCOL}://`))
const bootToken = extractLastfmAuthToken(bootProtocolUrl || '')
if (bootToken) {
  emitLastfmAuthToken(bootToken)
}
const bootFilePath = findAudioFileArg(process.argv)
if (bootFilePath) {
  emitOpenFilePath(bootFilePath)
}

ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url))
ipcMain.on('open-logs', () => {
  const logFile = log.transports.file.getFile().path;
  const logDir = path.dirname(logFile);
  if (fs.existsSync(logFile)) {
    shell.showItemInFolder(logFile);
  } else {
    shell.openPath(logDir);
  }
});

ipcMain.handle('updater:install', () => {
  isUpdating = true; 
  BrowserWindow.getAllWindows().forEach(w => w.close());
  
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true); 
  }, 500);
});
  ipcMain.handle('updater:check', () => {
    if (IS_NIGHTLY) return { nightly: true, version: app.getVersion() }
    autoUpdater.checkForUpdates()
    return { checking: true }
  })
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion()
  })

  // macOS: its window back from the Dock (hidden helper windows don't count).
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    try {
      const db = require('./ipc/db').getDB()
      const plural = db.prepare("SELECT value FROM settings WHERE key = 'music_folders'").get()?.value
      let folders = []
      try { folders = Array.isArray(JSON.parse(plural || 'null')) ? JSON.parse(plural) : [] } catch {}
      if (!folders.length) {
        const legacy = db.prepare("SELECT value FROM settings WHERE key = 'music_folder'").get()?.value
        if (legacy) folders = [legacy]
      }
      if (folders.length) require('./libraryWatcher').watchLibraryRoots(folders)
    } catch (error) { console.warn('[libraryWatcher] Could not resume watching on activate:', error.message) }
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const token = extractLastfmAuthToken(url)
    if (token) {
      emitLastfmAuthToken(token)
    }
  })

  if (!app.isPackaged) {
    console.log('[updater] skipping in dev mode')
  } else if (IS_NIGHTLY) {
    console.log(`[updater] nightly build (${app.getVersion()}): not checking for stable updates`)
  } else if ((() => { try { return require('./ipc/db').getDB().prepare("SELECT value FROM settings WHERE key = 'auto_update'").get()?.value === '0' } catch { return false } })()) {
    // Settings > About > Automatic Updates off: only "Check for updates" looks.
    console.log('[updater] automatic update checks are off')
  } else {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        console.log('[updater] check failed:', err.message)
      })
    }, 3000)
  }
})
app.on('window-all-closed', () => {
  try { require('./libraryWatcher').stopWatching() } catch {}
  if (process.platform !== 'darwin' || isUpdating) {
    app.quit();
  }
})

app.on('will-quit', () => {
  closeNativeOutput()
  // The hidden helper windows go too.
  try { require('./online/youtubeFast').forget() } catch {}
  try { require('./online/poToken').reset() } catch {}
  for (const window of BrowserWindow.getAllWindows()) { try { if (!window.isDestroyed()) window.destroy() } catch {} }
  try { shutdownActiveDownloads() } catch {}
  try { require('./spotiflac/packages').shutdown(require('./ipc/db').getDB()) } catch {}
  unregisterMediaShortcuts()
  try { stopSmtcBridge() } catch {}
})

// Discord keeps showing the last song if the app quits without clearing it:
// quitting waits (a second at most) for that once, then carries on.
let discordCleared = false
app.on('before-quit', (event) => {
  quitting = true
  removeTray()
  if (isUpdating) {
    if (mainWindow) {
      mainWindow.destroy();
    }
  }
  // Not while installing an update: the installer takes over the quit.
  if (!discordCleared && !isUpdating) {
    discordCleared = true
    event.preventDefault()
    // The TV's app is closed too, so it isn't left on a casting screen with nothing behind it.
    const castDone = Promise.race([shutdownCast(), new Promise(resolve => setTimeout(resolve, 1500))])
    Promise.all([disconnectForQuit(), castDone]).finally(() => app.quit())
  }
});
