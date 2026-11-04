// Renderer refresh for library operations received from a paired phone.
// The desktop database is updated in the link socket handler, outside of the
// normal scanner/IPC mutation paths that notify the React library views.
function broadcastLibraryChanged() {
  // Headless tests and shutdown may not have a live Electron renderer.
  try {
    const { BrowserWindow } = require('electron')
    if (!BrowserWindow?.getAllWindows) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('library:changed', {
          added: [], removed: [], updated: [], reason: 'link-library-sync'
        })
      }
    }
  } catch {}
}

function createLinkedLibraryRefresh({ publish = broadcastLibraryChanged, delayMs = 100 } = {}) {
  let timer = null
  return {
    accepted(count) {
      // Replayed operation IDs are ignored by LinkStore; they should not cause
      // a redundant library reload. Coalesce multi-page playlist transfers.
      if (!Number.isSafeInteger(count) || count <= 0) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        publish()
      }, delayMs)
      timer.unref?.()
    },
    close() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

module.exports = { createLinkedLibraryRefresh }
