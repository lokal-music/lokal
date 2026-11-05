const { getDB, getStorageDir } = require('../electron/ipc/db')
const { PhoneUploadService } = require('./phoneUploadService')
const fs = require('node:fs')
const path = require('node:path')
const { phoneDownloadDirectory } = require('../electron/storageLocations')

const services = new WeakMap()
function service() {
  const db = getDB()
  // Validate the selected drive before mkdir, matching the ordinary receiver.
  // Never fall back to app storage when a user-selected volume disappears.
  const destination = path.resolve(phoneDownloadDirectory())
  let current = services.get(db)
  if (!current || current.files.root !== destination) {
    fs.mkdirSync(path.dirname(destination),{recursive:true})
    current = new PhoneUploadService({ db, storageDir:getStorageDir(),destination,
      validateDestination: () => {
        if (path.resolve(phoneDownloadDirectory()) !== destination) throw new Error('phone_destination_changed')
      }, currentDevice: req => {
      // Recheck authority after async file work as well as at admission. A
      // re-pair/revoke/profile switch must not inherit an old request's token.
      const device = require('../electron/link').getLink()?.auth(req.headers['x-remote-token'])
      const user = String(require('../electron/ipc/remote').getRemoteState().userId || 'guest')
      return device && !device.legacy && device.user_id === user ? device : null
    } })
    services.set(db,current)
  }
  return current
}
async function dispatch(method,req,res) {
  try { await service()[method](req,res) }
  catch { if (!res.destroyed && !res.headersSent) res.status(503).json({error:'upload_unavailable'}) }
}
module.exports = {
  receivePhoneFile: (req,res) => dispatch('receive',req,res),
  phoneUploadStatus: (req,res) => dispatch('status',req,res),
  cancelPhoneUpload: (req,res) => dispatch('cancel',req,res),
  uploadOperationVersion: () => { try { service().files.check(); service().ledger.checkSchema(); return 1 } catch { return 0 } },
}
