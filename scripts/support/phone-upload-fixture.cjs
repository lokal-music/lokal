const { DatabaseSync } = require('node:sqlite')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const express = require('express')
const { PhoneUploadService } = require('../../server/phoneUploadService')
const { LinkStore } = require('../../electron/link/store')
const token = 'test-token-for-durable-upload-contract'
function database(filename) {
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000')
  db.transaction = fn => {
    const run = (...args) => {
      db.exec('BEGIN IMMEDIATE')
      try { const value = fn(...args); db.exec('COMMIT'); return value }
      catch (error) { db.exec('ROLLBACK'); throw error }
    }
    run.immediate = run; return run
  }
  db.exec(`CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY,file_path TEXT UNIQUE NOT NULL,file_hash TEXT NOT NULL,
    title TEXT NOT NULL,artist TEXT NOT NULL,album TEXT,album_artist TEXT,track_num INTEGER,year INTEGER,genre TEXT,genres TEXT,
    download_source TEXT,bitrate INTEGER,last_modified REAL,artwork_path TEXT,liked INTEGER DEFAULT 0,duration REAL);
    CREATE TABLE IF NOT EXISTS artists(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,bio TEXT,image_path TEXT);
    CREATE TABLE IF NOT EXISTS artist_track_links(artist_id TEXT,track_id TEXT,PRIMARY KEY(artist_id,track_id));
    CREATE TABLE IF NOT EXISTS playlists(id TEXT PRIMARY KEY,name TEXT,user_id TEXT);`)
  return db
}
function audio(seed = 1) {
  const data = Buffer.alloc(32000 + 44)
  data.write('RIFF',0); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8)
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22)
  data.writeUInt32LE(16000,24); data.writeUInt32LE(32000,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34)
  data.write('data',36); data.writeUInt32LE(data.length-44,40)
  for (let i=0;i<16000;i++) data.writeInt16LE(Math.round(1000*Math.sin(i*seed/10)),44+i*2)
  return data
}
const hash = data => createHash('sha256').update(data).digest('hex')
function headers(bytes, extra = {}) {
  const metadata = { title:'曲 — Café',artist:'Native fixture — Café',album:'Album',extension:'wav',originalFilename:'Original.wav',sha256:hash(bytes) }
  return { 'x-remote-token':token,'content-type':'application/octet-stream',
    'x-link-metadata':Buffer.from(JSON.stringify(metadata)).toString('base64url'),
    'x-link-upload-version':'1','x-link-upload-id':'11111111-1111-4111-8111-111111111111', ...extra }
}
async function fixture({ root, boundary, owner, destination, validateDestination } = {}) {
  root ??= await fs.mkdtemp(path.join(os.tmpdir(),'desktop-upload-'))
  const db = database(path.join(root,'desktop.sqlite'))
  const store = new LinkStore(db)
  const tokenHash = createHash('sha256').update(token).digest('hex')
  db.prepare('INSERT OR IGNORE INTO remote_devices(id,name,token_hash,user_id,created,last_seen) VALUES (?,?,?,?,?,?)')
    .run('fixture-phone','Phone',tokenHash,'guest',1000,1000)
  let activeUser = 'guest'
  const service = new PhoneUploadService({ db,storageDir:root,boundary,owner, destination: typeof destination === 'function' ? destination(root) : destination, validateDestination,
    currentDevice: req => { const device=store.authenticate(req.headers['x-remote-token']);return device?.user_id === activeUser ? device : null } })
  const app = express(); app.use(express.json({limit:'16kb'}))
  app.post('/api/remote/files',(req,res) => service.receive(req,res))
  app.get('/api/remote/files/operations',(req,res) => {
    try { service.auth(req);service.files.check();service.ledger.checkSchema()
      res.set('Cache-Control','private, no-store').json({protocolVersion:1,uploadOperations:1})
    } catch(error) {service.error(res,error)}
  })
  app.get('/api/remote/files/operations/:operationId',(req,res) => service.status(req,res))
  app.post('/api/remote/files/operations/:operationId/cancel',(req,res) => service.cancel(req,res))
  const server = app.listen(0,'127.0.0.1')
  await new Promise(resolve => server.once('listening',resolve))
  return { root, db,service,server,url:`http://127.0.0.1:${server.address().port}`,
    setActiveUser: value => { activeUser=value },
    async close({ remove = true } = {}) {
      server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); db.close()
      if (remove) await fs.rm(root,{recursive:true,force:true})
    } }
}
module.exports = { fixture, database, audio, headers, hash, token }
