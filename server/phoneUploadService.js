const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { TextDecoder } = require('node:util')
const { PhoneUploadLedger, fingerprint, scope, failure, MAX_BYTES } = require('./phoneUploadLedger')
const { PhoneUploadFiles, witness } = require('./phoneUploadFiles')
const { resolvePhoneFiles } = require('./phoneFileMatch')
const { findPhonePlaceholder } = require('./linkUploadMatch')
const { savePhoneFileMetadata } = require('./phoneFileMetadata')
const formats = new Set(['flac','mp3','m4a','aac','ogg','opus','wav','aiff','aif','alac','ape','wv','dsf','dff','webm'])

function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['title','artist','album','extension','originalFilename','sha256'].includes(key)) ||
      !formats.has(String(value.extension || '').toLowerCase()) || ['title','artist','album','originalFilename'].some(key =>
        value[key] != null && (typeof value[key] !== 'string' || Buffer.byteLength(value[key]) > 4096))) throw failure(400, 'invalid_metadata')
  return { ...value, extension: value.extension.toLowerCase() }
}
function headerMetadata(raw) {
  if (typeof raw !== 'string' || raw.length > 12000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) throw failure(400, 'invalid_metadata')
  try {
    const bytes = Buffer.from(raw, 'base64url')
    if (!bytes.length || bytes.length > 8192) throw failure(400, 'invalid_metadata')
    return metadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch { throw failure(400, 'invalid_metadata') }
}
const clean = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0,1000) : fallback

class PhoneUploadService {
  constructor({ db, storageDir, currentDevice, boundary = () => {}, owner, destination, validateDestination }) {
    this.db = db; this.currentDevice = currentDevice; this.boundary = boundary
    this.artworkRoot = path.join(fs.realpathSync(storageDir),'artwork')
    this.files = new PhoneUploadFiles(storageDir,{ destination,validateDestination })
    this.ledger = new PhoneUploadLedger(db, this.files.root, { boundary, ...(owner ? { owner } : {}) })
  }
  auth(req, expected) {
    const who = scope(this.currentDevice(req))
    if (expected && (who.user !== expected.user || who.device !== expected.device)) throw failure(403, 'pairing_changed')
    return who
  }
  document(row, extra = {}) {
    return { protocolVersion: 1, operationID: row.operation_id, state: row.state,
      bytes: row.bytes, sha256: row.sha256, fingerprint: row.fingerprint, ...extra }
  }
  async outcome(row) {
    if (row.state !== 'committed') return this.document(row)
    let available = false
    for (let attempt=0;attempt<3;attempt++) {
      const track = this.db.prepare('SELECT id,file_path FROM tracks WHERE id=?').get(row.track_id)
      if (!track || track.file_path.startsWith('ghost://')) break
      try {
        await this.files.verify(track.file_path,row.bytes,row.sha256)
        const current = this.db.prepare('SELECT file_path FROM tracks WHERE id=?').get(row.track_id)
        if (current?.file_path !== track.file_path) continue
        available = true; break
      } catch { /* Re-read a concurrently published path before declaring it unavailable. */ }
    }
    return this.document(row, { trackId: row.track_id, file_hash: row.sha256, available })
  }
  error(res, error) {
    if (!res.destroyed && !res.headersSent) res.status(error.status || 503).json({ error: error.code || 'upload_unavailable' })
  }
  async status(req, res) {
    try {
      const who = this.auth(req), row = this.ledger.row(who, req.params.operationId)
      if (!row) return res.status(404).json({ protocolVersion: 1, operationID: req.params.operationId, state: 'absent' })
      if (row.state === 'cancelled') { try { this.discardCancelled(row) } catch {} }
      if (row.state === 'committed') { try { await this.publish(row) } catch { /* Durable private original remains available. */ } }
      const result = await this.outcome(row)
      this.auth(req, who)
      if (result.available) { try { this.cleanupCandidate(this.ledger.row(who,row.operation_id)) } catch {} }
      res.set('Cache-Control','private, no-store').json(result)
    } catch (error) { this.error(res, error) }
  }
  async cancel(req, res) {
    try {
      const who = this.auth(req), body = req.body
      if (!body || Object.keys(body).some(key => !['bytes','metadata'].includes(key))) throw failure(400, 'invalid_cancellation')
      const meta = metadata(body.metadata), digest = fingerprint(meta, body.bytes)
      const row = this.ledger.cancel(who, req.params.operationId, digest, meta.sha256, body.bytes)
      if (row.state === 'cancelled') { try { this.discardCancelled(row) } catch {} }
      const result = await this.outcome(row)
      this.auth(req, who)
      res.set('Cache-Control','private, no-store').json(result)
    } catch (error) { this.error(res, error) }
  }
  async receive(req, res) {
    let claim, candidate, verified = false
    try {
      const who = this.auth(req)
      if (!req.is('application/octet-stream')) throw failure(415, 'audio_body_required')
      const meta = headerMetadata(req.headers['x-link-metadata'])
      const explicit = req.headers['x-link-upload-id']
      if ((explicit != null || req.headers['x-link-upload-version'] != null) && (typeof explicit !== 'string' || req.headers['x-link-upload-version'] !== '1')) throw failure(400, 'unsupported_upload_protocol')
      const id = explicit ?? randomUUID()
      const declared = req.headers['content-length'] == null ? null : Number(req.headers['content-length'])
      if (declared != null && (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_BYTES)) throw failure(413, 'invalid_size')
      if (explicit) {
        const digest = fingerprint(meta, declared)
        claim = this.ledger.begin(who, id, digest, meta.sha256, declared, () => req.destroy())
        if (claim.terminal) {
          req.resume()
          if (claim.terminal.state === 'cancelled') { try { this.discardCancelled(claim.terminal) } catch {} }
          if (claim.terminal.state === 'committed') { try { await this.publish(claim.terminal,meta) } catch {} }
          const result = await this.outcome(claim.terminal)
          this.auth(req, who)
          const status = result.state === 'cancelled' ? 410 : result.available ? 200 : 410
          if (result.available) { try { this.cleanupCandidate(this.ledger.row(who,id)) } catch {} }
          return res.status(status).json({ ...result, ok: result.state === 'committed' && result.available })
        }
      }
      // A crash may have left complete, durable bytes before receipt COMMIT.
      // A fresh generation fences the old writer before adopting its file.
      if (claim?.prior?.candidate_path) {
        try {
          const target = this.files.candidate(claim.prior.candidate_path)
          this.files.assertCandidate(claim.prior.candidate_path,JSON.parse(claim.prior.candidate_witness))
          const proof = await this.files.verify(target, declared, meta.sha256)
          this.auth(req, who); this.ledger.require(claim)
          // The prior process may have died after its final write but before
          // fsync. Recovery must establish durability itself before COMMIT.
          this.files.syncCandidate(claim.prior.candidate_path,proof)
          candidate = { relative: claim.prior.candidate_path, target, initial: proof }
          this.ledger.candidate(claim, candidate.relative, proof, true)
          verified = true; req.resume()
        } catch (error) {
          this.auth(req, who); this.ledger.require(claim)
          // Do not remove substituted/edited candidates or resume audio from
          // them. New private bytes get a new nonce and cannot overwrite them.
        }
      }
      let bytes = declared, digest = meta.sha256
      if (!candidate) {
        candidate = this.files.create(meta)
        if (claim) this.ledger.candidate(claim, candidate.relative, candidate.initial, false)
        let received = 0, lastFence = 0
        const hash = createHash('sha256')
        const counter = new Transform({ transform: (chunk, encoding, callback) => {
          try {
            received += chunk.length
            if (received > MAX_BYTES || (declared != null && received > declared)) throw failure(413, 'invalid_size')
            if (received - lastFence >= 256 * 1024) { this.auth(req, who); if (claim) this.ledger.require(claim); lastFence = received }
            hash.update(chunk); callback(null,chunk)
          } catch (error) { callback(error) }
        } })
        const output = fs.createWriteStream(candidate.target, { fd: candidate.fd, autoClose: true })
        candidate.fd = undefined
        await pipeline(req, counter, output)
        bytes = received; digest = hash.digest('hex')
        if (!bytes || (declared != null && bytes !== declared) || (meta.sha256 && digest !== meta.sha256)) throw failure(400, 'checksum_mismatch')
        meta.sha256 = digest
        this.auth(req, who)
        if (!claim) claim = this.ledger.begin(who, id, fingerprint(meta, bytes), digest, bytes, () => req.destroy())
        const proof = await this.files.verify(candidate.target, bytes, digest)
        this.files.syncCandidate(candidate.relative, proof)
        await this.boundary('afterFileSync')
        this.ledger.require(claim)
        this.ledger.candidate(claim, candidate.relative, proof, true)
        verified = true
        await this.boundary('afterPrepared')
      }
      const matches = await resolvePhoneFiles(this.db, [{ size: bytes, sha256: digest }], {
        check: () => { this.auth(req, who); this.ledger.require(claim) },
      })
      let matched = null
      if (matches.length) {
        const row = this.db.prepare('SELECT id,file_path FROM tracks WHERE id=?').get(matches[0].trackId)
        if (row) matched = { row, witness: await this.files.verify(row.file_path, bytes, digest) }
      }
      this.files.assertCandidate(candidate.relative,candidate.initial)
      const { parseFile } = await import('music-metadata')
      const parsed = await parseFile(candidate.target, { duration:true })
      if (!Number.isFinite(parsed.format.duration) || parsed.format.duration <= 0) throw failure(400, 'invalid_audio')
      let artwork = null
      const picture = parsed.common.picture?.[0]?.data
      if (!matched && picture?.length && picture.length <= 12 * 1024 * 1024) {
        try { artwork = await require('../electron/artwork/thumb').writeCover(
          this.artworkRoot, 'upload-'+digest, picture, { overwrite:false }) }
        catch { /* Artwork is optional; original bytes and quality are retained. */ }
      }
      const proof = await this.files.verify(candidate.target, bytes, digest)
      const record = this.ledger.commit(claim, () => {
        this.files.assertCandidate(candidate.relative,candidate.initial)
        this.auth(req, who); this.files.check()
        // This check is inside the same SQLite writer as both the track and
        // receipt. Concurrent different operation keys cannot insert twice.
        const content = this.db.prepare('SELECT * FROM phone_upload_content WHERE sha256=? AND bytes=?').get(digest, bytes)
        if (content) {
          const track = this.db.prepare('SELECT id,file_path FROM tracks WHERE id=?').get(content.track_id)
          const existing = JSON.parse(content.witness)
          if (track && this.files.matches(track.file_path, existing)) return { trackId: track.id, witness: existing }
        }
        if (matched) {
          const current = this.db.prepare('SELECT id,file_path FROM tracks WHERE id=?').get(matched.row.id)
          if (current?.file_path === matched.row.file_path && this.files.matches(current.file_path, matched.witness)) return { trackId: current.id, witness: matched.witness }
        }
        if (!this.files.matches(candidate.target, proof)) throw failure(409, 'file_changed')
        const title = clean(meta.title, clean(parsed.common.title,'Unknown track'))
        const artist = clean(meta.artist, clean(parsed.common.artist,'Unknown artist'))
        const album = clean(meta.album, clean(parsed.common.album,''))
        const ghost = findPhonePlaceholder(this.db,title,artist,parsed.format.duration)
        const trackId = ghost?.id ?? randomUUID()
        if (ghost) this.db.prepare('UPDATE tracks SET file_path=?,file_hash=?,duration=? WHERE id=?').run(candidate.target,digest,parsed.format.duration,trackId)
        else this.db.prepare('INSERT INTO tracks (id,file_path,file_hash,title,artist,album,album_artist,duration,track_num,year) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(trackId,candidate.target,digest,title,artist,album,clean(parsed.common.albumartist,''),parsed.format.duration,parsed.common.track?.no ?? null,parsed.common.year ?? null)
        const stat = fs.statSync(candidate.target)
        savePhoneFileMetadata(this.db,trackId,parsed,{ artwork,mtimeMs:stat.mtimeMs })
        const artistId = require('../electron/artistId').resolveArtistId(this.db,artist)
        this.db.prepare('INSERT OR IGNORE INTO artist_track_links(artist_id,track_id) VALUES (?,?)').run(artistId,trackId)
        return { trackId, witness:proof }
      })
      await this.boundary('afterCommit')
      // Audio is already playable and its receipt durable. Cosmetic publication
      // is recoverable; failure must never delete that committed audio.
      try { await this.publish(record, meta) } catch { /* Private original stays playable. */ }
      const result = await this.outcome(this.ledger.row(who,id))
      this.auth(req,who)
      if (!result.available) throw failure(409, 'original_unavailable')
      try { this.cleanupCandidate(this.ledger.row(who,id)) } catch { /* Preserve uncertain ownership. */ }
      res.json(explicit ? { ...result,ok:true } : { ok:true,trackId:result.trackId,file_hash:result.sha256 })
    } catch (error) {
      if (claim && !claim.terminal) { try { this.ledger.retryable(claim) } catch { /* Preserve unknown COMMIT outcome. */ } }
      this.error(res,error)
    } finally {
      if (candidate?.fd !== undefined) fs.closeSync(candidate.fd)
      if (candidate && !verified) {
        try {
          this.ledger.transaction(() => {
            const current = claim && !claim.terminal ? this.ledger.row(claim.who,claim.id) : null
            const owned = !claim || (current?.candidate_path === candidate.relative &&
              ((current.owner === claim.owner && current.generation === claim.generation && !current.verified) || current.state === 'cancelled'))
            if (owned && !this.db.prepare('SELECT 1 FROM tracks WHERE file_path=?').get(candidate.target)) {
              this.files.removePartial(candidate.relative,candidate.initial)
            }
          })
        } catch { /* An unknown receipt/ownership outcome preserves the file. */ }
      }
      if (claim && !claim.terminal) this.ledger.finish(claim)
    }
  }
  discardCancelled(record) {
    this.ledger.transaction(() => {
      const who={user:record.user_id,device:record.device_id}
      const row=this.ledger.row(who,record.operation_id)
      if (row.state!=='cancelled' || !row.candidate_path) return
      const target=this.files.candidate(row.candidate_path),expected=JSON.parse(row.candidate_witness)
      const current=fs.lstatSync(target,{bigint:true})
      if (!current.isFile() || current.isSymbolicLink() || current.nlink!==1n ||
          String(current.dev)!==expected.dev || String(current.ino)!==expected.ino ||
          (row.verified && !this.files.matches(target,expected)) ||
          this.db.prepare('SELECT 1 FROM tracks WHERE file_path=?').get(target)) return
      fs.unlinkSync(target)
      try {fs.rmdirSync(path.dirname(target))}catch{}
      this.db.prepare('UPDATE phone_upload_operations SET candidate_path=NULL,candidate_witness=NULL WHERE user_id=? AND device_id=? AND operation_id=?')
        .run(who.user,who.device,row.operation_id)
    })
  }

  cleanupCandidate(record) {
    this.ledger.transaction(() => {
      const row = this.ledger.row({user:record.user_id,device:record.device_id},record.operation_id)
      if (row.state !== 'committed' || !row.candidate_path) return
      const target = this.files.candidate(row.candidate_path)
      const track = this.db.prepare('SELECT file_path FROM tracks WHERE id=?').get(row.track_id)
      if (!track || track.file_path === target || this.db.prepare('SELECT 1 FROM tracks WHERE file_path=?').get(target)) return
      try {
        const proof = JSON.parse(row.candidate_witness)
        if (!this.files.matches(target,proof)) return
        fs.unlinkSync(target) // Only the verified, unpublished private name.
        try { fs.rmdirSync(path.dirname(target)) } catch { /* Other owned entries remain. */ }
        const current = fs.lstatSync(track.file_path,{bigint:true})
        if (String(current.ino) === proof.ino && String(current.dev) === proof.dev && current.isFile() && !current.isSymbolicLink()) {
          this.db.prepare('UPDATE phone_upload_content SET witness=? WHERE track_id=?').run(JSON.stringify(witness(current)),row.track_id)
        }
        this.db.prepare('UPDATE phone_upload_operations SET candidate_path=NULL,candidate_witness=NULL WHERE user_id=? AND device_id=? AND operation_id=?')
          .run(row.user_id,row.device_id,row.operation_id)
      } catch { /* Historical receipt wins over uncertain private cleanup. */ }
    })
  }

  async publish(record, meta) {
    const who = { user:record.user_id,device:record.device_id }
    for (let suffix=1;suffix<=10000;suffix++) {
      let row = this.ledger.row(who,record.operation_id)
      const track = this.db.prepare('SELECT id,file_path FROM tracks WHERE id=?').get(row.track_id)
      if (!track || !row.candidate_path || track.file_path !== this.files.candidate(row.candidate_path)) return
      this.files.assertCandidate(row.candidate_path,JSON.parse(row.candidate_witness),row.public_path)
      const proof = await this.files.verify(track.file_path,row.bytes,row.sha256)
      meta ??= { extension:path.extname(track.file_path).slice(1), originalFilename:path.basename(track.file_path) }
      if (!this.files.matches(track.file_path,proof)) throw failure(409,'file_changed')
      const name = row.public_path ?? this.files.planPublic(meta,suffix)
      // Save publication intent before touching a friendly pathname. A crash
      // after link can retry the exact name and inode without a second file.
      this.ledger.transaction(() => this.db.prepare('UPDATE phone_upload_operations SET public_path=? WHERE user_id=? AND device_id=? AND operation_id=?')
        .run(name,who.user,who.device,row.operation_id))
      const linked = this.files.linkPrivate(row.candidate_path,name)
      if (!linked) {
        this.ledger.transaction(() => this.db.prepare('UPDATE phone_upload_operations SET public_path=NULL WHERE user_id=? AND device_id=? AND operation_id=?')
          .run(who.user,who.device,row.operation_id))
        continue
      }
      this.boundary('afterPublicLink')
      this.ledger.transaction(() => {
        row = this.ledger.row(who,record.operation_id)
        const current = this.db.prepare('SELECT file_path FROM tracks WHERE id=?').get(row.track_id)
        if (current?.file_path !== track.file_path || !this.files.matches(linked.target,linked.witness)) throw failure(409,'file_changed')
        this.db.prepare('UPDATE tracks SET file_path=? WHERE id=?').run(linked.target,row.track_id)
        const encoded = JSON.stringify(linked.witness)
        this.db.prepare('UPDATE phone_upload_content SET witness=? WHERE track_id=?').run(encoded,row.track_id)
        this.db.prepare('UPDATE phone_upload_operations SET candidate_witness=? WHERE user_id=? AND device_id=? AND operation_id=?')
          .run(encoded,who.user,who.device,row.operation_id)
        this.boundary('beforePublicationCommit')
      })
      this.boundary('afterPublicationCommit')
      this.cleanupCandidate(this.ledger.row(who,record.operation_id))
      return
    }
    throw failure(409,'filename_capacity')
  }
}
module.exports = { PhoneUploadService, headerMetadata, metadata }
