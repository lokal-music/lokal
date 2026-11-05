const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { phoneFileName } = require('./phoneFileNaming')
const { PRIVATE_PHONE_UPLOAD_DIRECTORY } = require('../electron/phoneUploadPaths')
const { failure, MAX_BYTES } = require('./phoneUploadLedger')

const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
const witness = stat => Object.fromEntries(fields.map(key => [key, String(stat[key])]))
const same = (a, b) => fields.every(key => a?.[key] === b?.[key])
function directory(target) {
  try { fs.mkdirSync(target, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = fs.lstatSync(target, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(409, 'unsafe_storage')
  return stat
}
function syncDirectory(target) {
  let fd
  try { fd = fs.openSync(target, fs.constants.O_RDONLY); fs.fsyncSync(fd) }
  catch (error) {
    // Node/Windows cannot FlushFileBuffers on a directory handle. File and
    // SQLite FULL sync remain mandatory; do not claim power-loss qualification.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(error.code)) throw error
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
class PhoneUploadFiles {
  constructor(storageDir, { destination, validateDestination = () => {} } = {}) {
    this.validateDestination = validateDestination
    validateDestination()
    const selected = destination ?? path.join(fs.realpathSync(storageDir), 'phone-downloads')
    this.root = selected
    this.rootInfo = directory(this.root)
    this.incoming = path.join(this.root, PRIVATE_PHONE_UPLOAD_DIRECTORY)
    this.incomingInfo = directory(this.incoming)
    syncDirectory(this.root)
    syncDirectory(path.dirname(this.root))
  }
  check() {
    this.validateDestination()
    for (const [target, original] of [[this.root, this.rootInfo], [this.incoming, this.incomingInfo]]) {
      const current = fs.lstatSync(target, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) throw failure(409, 'unsafe_storage')
    }
  }
  candidate(relative) {
    this.check()
    const parts = typeof relative === 'string' ? relative.split('/') : []
    if (parts.length !== 2 || !/^[0-9a-f-]{36}$/.test(parts[0]) || !parts[1] ||
        parts[1] === '.' || parts[1] === '..' || /[\\/\x00-\x1f\x7f]/.test(parts[1])) throw failure(409, 'unsafe_storage')
    const parent = path.join(this.incoming, parts[0])
    const stat = fs.lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure(409, 'unsafe_storage')
    return path.join(parent, parts[1])
  }
  create(metadata) {
    this.check()
    const nonce = randomUUID()
    directory(path.join(this.incoming, nonce))
    let name = phoneFileName(metadata)
    const extension = path.extname(name)
    let stem = name.slice(0, -extension.length)
    while (Buffer.byteLength(stem + extension) > 220) stem = Array.from(stem).slice(0, -1).join('')
    name = stem + extension
    syncDirectory(this.incoming)
    const relative = `${nonce}/${name}`
    const target = this.candidate(relative)
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    const initial = witness(fs.fstatSync(fd, { bigint: true }))
    return { relative, target, fd, initial }
  }
  assertCandidate(relative, expected, publicName = null) {
    const target = this.candidate(relative)
    const stat = fs.lstatSync(target,{bigint:true})
    if (!stat.isFile() || stat.isSymbolicLink() || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino) throw failure(409,'file_changed')
    if (stat.nlink === 1n) return
    if (stat.nlink === 2n && publicName) {
      const published = fs.lstatSync(this.publicPath(publicName),{bigint:true})
      if (published.isFile() && !published.isSymbolicLink() && published.dev === stat.dev && published.ino === stat.ino) return
    }
    throw failure(409,'file_changed')
  }
  matches(target, expected) {
    try {
      const stat = fs.lstatSync(target, { bigint: true })
      return stat.isFile() && !stat.isSymbolicLink() && same(witness(stat), expected)
    } catch { return false }
  }
  async verify(target, bytes, digest) {
    this.check()
    const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size !== BigInt(bytes) || bytes < 1 || bytes > MAX_BYTES) throw failure(409, 'file_changed')
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      const after = await handle.stat({ bigint: true })
      if (!same(witness(before), witness(after)) || !this.matches(target, witness(after)) || hash.digest('hex') !== digest) throw failure(409, 'file_changed')
      this.check()
      return witness(after)
    } finally { await handle.close() }
  }
  syncCandidate(relative, expected) {
    const target = this.candidate(relative)
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (!same(witness(fs.fstatSync(fd, { bigint: true })), expected)) throw failure(409, 'file_changed')
      fs.fsyncSync(fd)
      if (!this.matches(target, expected)) throw failure(409, 'file_changed')
      syncDirectory(path.dirname(target))
    } finally { fs.closeSync(fd) }
  }
  removePartial(relative, initial) {
    // Only the unpublished private file this attempt opened. Never public
    // originals, verified candidates, hard links or substituted nodes.
    try {
      const target = this.candidate(relative)
      const stat = fs.lstatSync(target, { bigint: true })
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
          String(stat.dev) === initial.dev && String(stat.ino) === initial.ino) fs.unlinkSync(target)
    } catch { /* Preserve uncertain files for explicit recovery. */ }
  }
  publicPath(name) {
    this.check()
    if (typeof name !== 'string' || !name || path.basename(name) !== name || /[\\/\x00-\x1f\x7f]/.test(name)) throw failure(409, 'unsafe_storage')
    return path.join(this.root, name)
  }
  planPublic(metadata, suffix) {
    const filename = phoneFileName(metadata)
    const ext = path.extname(filename)
    let stem = filename.slice(0, -ext.length)
    while (Buffer.byteLength(stem) > 210) stem = Array.from(stem).slice(0, -1).join('')
    return `${stem}${suffix === 1 ? '' : ` (${suffix})`}${ext}`
  }
  linkPrivate(relative, name) {
    const source = this.candidate(relative), target = this.publicPath(name)
    const before = fs.lstatSync(source, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) throw failure(409, 'file_changed')
    try { fs.linkSync(source, target) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const current = fs.lstatSync(target, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) return null
    }
    syncDirectory(this.root)
    return { target, witness: witness(fs.lstatSync(target, { bigint: true })) }
  }
}
module.exports = { PhoneUploadFiles, witness, same }
