// Durable, device/account-scoped outcomes for original-file uploads.
// Receiving work is fenced by generation; no network/file await holds SQLite.
const { randomUUID, createHash } = require('node:crypto')
const PROCESS_OWNER = randomUUID()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_BYTES = 1024 * 1024 * 1024
const active = new Map()
const failure = (status, code) => Object.assign(new Error(code), { status, code })

function scope(device) {
  if (!device || device.legacy || typeof device.id !== 'string' || typeof device.user_id !== 'string' ||
      !device.id || !device.user_id || device.id.length > 128 || device.user_id.length > 128) throw failure(403, 'pairing_required')
  if (/[\x00-\x1f\x7f]/.test(device.id + device.user_id)) throw failure(403, 'pairing_required')
  return { user: device.user_id, device: device.id }
}
function fingerprint(metadata, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES || !/^[0-9a-f]{64}$/.test(metadata.sha256 || '')) {
    throw failure(400, 'invalid_fingerprint')
  }
  const fields = ['title', 'artist', 'album', 'extension', 'originalFilename'].map(key => metadata[key] ?? '')
  if (fields.some(value => typeof value !== 'string' || Buffer.byteLength(value) > 4096)) throw failure(400, 'invalid_metadata')
  return createHash('sha256').update(`lokal.upload.v1\n${bytes}\n${metadata.sha256}\n` +
    fields.map(value => `${Buffer.byteLength(value)}:${value}`).join(''), 'utf8').digest('hex')
}

class PhoneUploadLedger {
  constructor(db, namespace, { now = Date.now, owner = PROCESS_OWNER, boundary = () => {} } = {}) {
    this.db = db; this.namespace = namespace; this.now = now; this.owner = owner; this.boundary = boundary
    // The receipt and track must survive together after acknowledged COMMIT.
    db.exec('PRAGMA synchronous=FULL')
    this.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS phone_upload_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
      const version = db.prepare("SELECT value FROM phone_upload_meta WHERE key='schema_version'").get()?.value
      if (version != null && version !== '1') throw failure(409,'unsupported_upload_storage')
      if (version == null && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='phone_upload_operations'").get()) throw failure(409,'unsupported_upload_storage')
      db.exec(`CREATE TABLE IF NOT EXISTS phone_upload_operations (
      user_id TEXT NOT NULL,device_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('receiving','retryable','committed','cancelled')),
      generation INTEGER NOT NULL,owner TEXT NOT NULL,candidate_path TEXT,candidate_witness TEXT,
      verified INTEGER NOT NULL DEFAULT 0,track_id TEXT,public_path TEXT,
      created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,
      PRIMARY KEY(user_id,device_id,operation_id));
      CREATE TABLE IF NOT EXISTS phone_upload_content (
        sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,track_id TEXT NOT NULL,
        witness TEXT NOT NULL,PRIMARY KEY(sha256,bytes));`)
      db.prepare("INSERT OR IGNORE INTO phone_upload_meta(key,value) VALUES ('schema_version','1')").run()
    })
    this.initialized = true
  }
  key(who, id) { return JSON.stringify([this.namespace, who.user, who.device, id]) }
  checkSchema() {
    if (this.db.prepare("SELECT value FROM phone_upload_meta WHERE key='schema_version'").get()?.value !== '1') throw failure(409,'unsupported_upload_storage')
    if (this.db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw failure(503,'upload_storage_not_durable')
  }
  transaction(work) { return this.db.transaction(() => {
    if (this.initialized) this.checkSchema()
    return work()
  }).immediate() }
  row(who, id) {
    if (this.initialized) this.checkSchema()
    if (!UUID.test(id)) throw failure(400, 'invalid_operation')
    return this.db.prepare('SELECT * FROM phone_upload_operations WHERE user_id=? AND device_id=? AND operation_id=?').get(who.user, who.device, id)
  }
  begin(who, id, digest, sha256, bytes, abort) {
    if (!UUID.test(id)) throw failure(400, 'invalid_operation')
    const key = this.key(who, id)
    const claim = this.transaction(() => {
      const old = this.row(who, id)
      if (old && old.fingerprint !== digest) throw failure(409, 'operation_conflict')
      if (old && ['committed', 'cancelled'].includes(old.state)) return { terminal: old }
      if (old?.state === 'receiving' && active.get(key)?.owner === this.owner) throw failure(409, 'operation_in_progress')
      if (!old && this.db.prepare('SELECT COUNT(*) AS n FROM phone_upload_operations').get().n >= 100000) throw failure(429, 'receipt_capacity')
      if (this.db.prepare("SELECT COUNT(*) AS n FROM phone_upload_operations WHERE state='receiving' AND owner=?").get(this.owner).n >= 4) throw failure(429, 'upload_capacity')
      const generation = (old?.generation ?? 0) + 1
      if (!Number.isSafeInteger(generation)) throw failure(409, 'operation_generation')
      const now = this.now()
      if (old) this.db.prepare("UPDATE phone_upload_operations SET state='receiving',generation=?,owner=?,updated_ms=? WHERE user_id=? AND device_id=? AND operation_id=?")
        .run(generation, this.owner, now, who.user, who.device, id)
      else this.db.prepare(`INSERT INTO phone_upload_operations
        (user_id,device_id,operation_id,fingerprint,sha256,bytes,state,generation,owner,created_ms,updated_ms)
        VALUES (?,?,?,?,?,?,'receiving',?,?,?,?)`)
        .run(who.user, who.device, id, digest, sha256, bytes, generation, this.owner, now, now)
      return { who, id, generation, owner: this.owner, prior: old }
    })
    if (!claim.terminal) active.set(key, { generation: claim.generation, owner: claim.owner, abort })
    return claim
  }
  require(claim) {
    const row = this.row(claim.who, claim.id)
    if (!row || row.state !== 'receiving' || row.owner !== claim.owner || row.generation !== claim.generation) throw failure(409, 'operation_retired')
    return row
  }
  candidate(claim, relativePath, witness, verified) {
    return this.transaction(() => {
      this.require(claim)
      this.db.prepare(`UPDATE phone_upload_operations SET candidate_path=?,candidate_witness=?,verified=?,updated_ms=?
      WHERE user_id=? AND device_id=? AND operation_id=? AND generation=? AND owner=? AND state='receiving'`)
      .run(relativePath, JSON.stringify(witness), verified ? 1 : 0, this.now(), claim.who.user, claim.who.device, claim.id, claim.generation, claim.owner)
    })
  }
  commit(claim, publish) {
    return this.transaction(() => {
      const row = this.require(claim)
      const result = publish(row)
      if (!result || typeof result.trackId !== 'string' || !result.trackId || !result.witness) throw failure(500, 'invalid_commit')
      this.db.prepare(`INSERT INTO phone_upload_content(sha256,bytes,track_id,witness) VALUES (?,?,?,?)
        ON CONFLICT(sha256,bytes) DO UPDATE SET track_id=excluded.track_id,witness=excluded.witness`)
        .run(row.sha256, row.bytes, result.trackId, JSON.stringify(result.witness))
      this.db.prepare("UPDATE phone_upload_operations SET state='committed',track_id=?,updated_ms=? WHERE user_id=? AND device_id=? AND operation_id=?")
        .run(result.trackId, this.now(), claim.who.user, claim.who.device, claim.id)
      this.boundary('beforeCommit')
      return this.row(claim.who, claim.id)
    })
  }
  retryable(claim) {
    this.transaction(() => this.db.prepare(`UPDATE phone_upload_operations SET state='retryable',updated_ms=?
      WHERE user_id=? AND device_id=? AND operation_id=? AND generation=? AND owner=? AND state='receiving'`)
      .run(this.now(), claim.who.user, claim.who.device, claim.id, claim.generation, claim.owner))
  }
  finish(claim) {
    const key = this.key(claim.who, claim.id)
    if (active.get(key)?.generation === claim.generation && active.get(key)?.owner === claim.owner) active.delete(key)
  }
  cancel(who, id, digest, sha256, bytes) {
    if (!UUID.test(id)) throw failure(400, 'invalid_operation')
    const result = this.transaction(() => {
      const old = this.row(who, id)
      if (old && old.fingerprint !== digest) throw failure(409, 'operation_conflict')
      if (old?.state === 'committed' || old?.state === 'cancelled') return old
      if (!old && this.db.prepare('SELECT COUNT(*) AS n FROM phone_upload_operations').get().n >= 100000) throw failure(429, 'receipt_capacity')
      const now = this.now()
      if (old) this.db.prepare("UPDATE phone_upload_operations SET state='cancelled',generation=generation+1,updated_ms=? WHERE user_id=? AND device_id=? AND operation_id=?")
        .run(now, who.user, who.device, id)
      else this.db.prepare(`INSERT INTO phone_upload_operations
        (user_id,device_id,operation_id,fingerprint,sha256,bytes,state,generation,owner,created_ms,updated_ms)
        VALUES (?,?,?,?,?,?,'cancelled',1,?,?,?)`).run(who.user, who.device, id, digest, sha256, bytes, this.owner, now, now)
      return this.row(who, id)
    })
    if (result.state === 'cancelled') {
      try { active.get(this.key(who, id))?.abort() } catch { /* The durable fence already committed. */ }
    }
    return result
  }
}
module.exports = { PhoneUploadLedger, fingerprint, scope, failure, MAX_BYTES }
