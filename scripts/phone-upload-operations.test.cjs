const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const { fixture, audio, headers, hash, token } = require('./support/phone-upload-fixture.cjs')
const upload = (f,bytes,extra={}) => fetch(f.url+'/api/remote/files',{method:'POST',headers:headers(bytes,extra),body:bytes})

test('actual HTTP upload commits a playable original and stable receipt; replay never creates another track',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    const response=await upload(f,bytes); const result=await response.json()
    assert.equal(response.status,200,JSON.stringify(result)); assert.equal(result.state,'committed');assert.equal(result.available,true)
    const row=f.db.prepare('SELECT * FROM tracks').get()
    assert.equal(row.id,result.trackId); assert.equal(hash(await fs.readFile(row.file_path)),hash(bytes))
    assert.equal(row.sample_rate,16000); assert.equal(row.bit_depth,16)
    const replay=await upload(f,bytes); assert.equal(replay.status,200); assert.equal((await replay.json()).trackId,row.id)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
    const query=await fetch(f.url+'/api/remote/files/operations/'+result.operationID,{headers:{'x-remote-token':token}})
    assert.equal((await query.json()).trackId,row.id)
  } finally {await f.close()}
})
test('same operation cannot change its immutable audio fingerprint',async()=>{
  const f=await fixture()
  try {
    assert.equal((await upload(f,audio())).status,200)
    const response=await upload(f,audio(2)); assert.equal(response.status,409)
    assert.equal((await response.json()).error,'operation_conflict')
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
  } finally {await f.close()}
})
test('concurrent different operation keys for identical bytes converge on one original',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    const replies=await Promise.all([upload(f,bytes),upload(f,bytes,{'x-link-upload-id':'22222222-2222-4222-8222-222222222222'})])
    const results=await Promise.all(replies.map(r=>r.json()))
    assert.ok(replies.every(r=>r.status===200),JSON.stringify(results))
    assert.equal(results[0].trackId,results[1].trackId)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
  } finally {await f.close()}
})
test('cancellation before a delayed upload leaves a durable tombstone',async()=>{
  const f=await fixture(),bytes=audio(),h=headers(bytes)
  try {
    const response=await fetch(f.url+'/api/remote/files/operations/'+h['x-link-upload-id']+'/cancel',{
      method:'POST',headers:{'x-remote-token':token,'content-type':'application/json'},
      body:JSON.stringify({bytes:bytes.length,metadata:JSON.parse(Buffer.from(h['x-link-metadata'],'base64url'))})})
    assert.equal(response.status,200); assert.equal((await response.json()).state,'cancelled')
    const late=await upload(f,bytes);assert.equal(late.status,410)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0)
  } finally {await f.close()}
})
test('legacy phone upload remains accepted and participates in the same content deduplication',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    const h=headers(bytes); delete h['x-link-upload-id']; delete h['x-link-upload-version']
    assert.equal((await fetch(f.url+'/api/remote/files',{method:'POST',headers:h,body:bytes})).status,200)
    assert.equal((await upload(f,bytes)).status,200)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
  } finally {await f.close()}
})

test('revoking a real paired token while bytes are prepared refuses the final track/receipt commit',async()=>{
  let entered,release
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
  const f=await fixture({boundary:async edge=>{if(edge==='afterPrepared'){entered();await gate}}}),bytes=audio()
  try {
    const pending=upload(f,bytes); await ready
    f.db.prepare('UPDATE remote_devices SET revoked=1').run();release()
    const result=await pending; assert.equal(result.status,403)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0)
    assert.equal(f.db.prepare('SELECT state FROM phone_upload_operations').get().state,'retryable')
  } finally {release();await f.close()}
})
test('cancelling prepared work fences its commit and preserves existing unrelated music',async()=>{
  let entered,release
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
  const f=await fixture({boundary:async edge=>{if(edge==='afterPrepared'){entered();await gate}}}),bytes=audio()
  try {
    const pending=upload(f,bytes).catch(()=>null); await ready
    const h=headers(bytes)
    const cancelled=await fetch(f.url+'/api/remote/files/operations/'+h['x-link-upload-id']+'/cancel',{
      method:'POST',headers:{'x-remote-token':token,'content-type':'application/json'},
      body:JSON.stringify({bytes:bytes.length,metadata:JSON.parse(Buffer.from(h['x-link-metadata'],'base64url'))})})
    assert.equal(cancelled.status,200); assert.equal((await cancelled.json()).state,'cancelled')
    release();await pending
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0)
    assert.equal((await upload(f,bytes)).status,410)
  } finally {release();await f.close()}
})
test('a different paired device cannot discover or cancel another device operation',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    assert.equal((await upload(f,bytes)).status,200)
    const { createHash }=require('node:crypto'),second='second-device-test-token-1234567890'
    f.db.prepare('INSERT INTO remote_devices(id,name,token_hash,user_id,created,last_seen) VALUES (?,?,?,?,?,?)')
      .run('other-phone','Other',createHash('sha256').update(second).digest('hex'),'guest',1000,1000)
    const status=await fetch(f.url+'/api/remote/files/operations/'+headers(bytes)['x-link-upload-id'],{headers:{'x-remote-token':second}})
    assert.equal(status.status,404); assert.equal((await status.json()).state,'absent')
  } finally {await f.close()}
})
test('deleting a committed desktop file does not recreate it when an old operation replays',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    assert.equal((await upload(f,bytes)).status,200)
    const track=f.db.prepare('SELECT * FROM tracks').get();await fs.unlink(track.file_path)
    const replay=await upload(f,bytes);assert.equal(replay.status,410)
    assert.equal((await replay.json()).available,false)
    await assert.rejects(fs.stat(track.file_path),{code:'ENOENT'})
    const fresh=await upload(f,bytes,{'x-link-upload-id':'22222222-2222-4222-8222-222222222222'})
    assert.equal(fresh.status,200)
    assert.notEqual((await fresh.json()).trackId,track.id)
  } finally {await f.close()}
})
test('same-byte private file replacement cannot inherit an already verified candidate',async()=>{
  let entered,release
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
  const f=await fixture({boundary:async edge=>{if(edge==='afterPrepared'){entered();await gate}}}),bytes=audio()
  try {
    const pending=upload(f,bytes);await ready
    const record=f.db.prepare('SELECT * FROM phone_upload_operations').get()
    const file=f.service.files.candidate(record.candidate_path)
    await fs.rename(file,file+'.preserved'); await fs.writeFile(file,bytes)
    release();const result=await pending
    assert.equal(result.status,409);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0)
    assert.equal(hash(await fs.readFile(file+'.preserved')),hash(bytes))
    assert.equal(hash(await fs.readFile(file)),hash(bytes))
  } finally {release();await f.close()}
})

test('future receipt schemas refuse writes and leave historical outcomes unchanged',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    assert.equal((await upload(f,bytes)).status,200)
    const before=f.db.prepare('SELECT * FROM phone_upload_operations').all()
    f.db.prepare("UPDATE phone_upload_meta SET value='2' WHERE key='schema_version'").run()
    const response=await upload(f,audio(2),{'x-link-upload-id':'22222222-2222-4222-8222-222222222222'})
    assert.equal(response.status,409);assert.equal((await response.json()).error,'unsupported_upload_storage')
    assert.deepEqual(f.db.prepare('SELECT * FROM phone_upload_operations').all(),before)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
  } finally {await f.close()}
})
test('a shared connection switched away from FULL durability refuses upload admission',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    f.db.exec('PRAGMA synchronous=NORMAL')
    const response=await upload(f,bytes)
    assert.equal(response.status,503);assert.equal((await response.json()).error,'upload_storage_not_durable')
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM phone_upload_operations').get().n,0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0)
  } finally {await f.close()}
})
test('switching the active desktop account while preparing audio fences its final commit',async()=>{
  let entered,release
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
  const f=await fixture({boundary:async edge=>{if(edge==='afterPrepared'){entered();await gate}}}),bytes=audio()
  try {
    const pending=upload(f,bytes);await ready;f.setActiveUser('other-account');release()
    assert.equal((await pending).status,403)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0)
    f.setActiveUser('guest')
    assert.equal((await upload(f,bytes)).status,200)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
  } finally {release();await f.close()}
})
test('an existing friendly file is preserved and upload publication chooses a free name',async()=>{
  const f=await fixture(),bytes=audio()
  try {
    const path=require('node:path'),name=f.service.files.planPublic(JSON.parse(Buffer.from(headers(bytes)['x-link-metadata'],'base64url')),1)
    const target=path.join(f.service.files.root,name),original=Buffer.from('existing user original')
    await fs.writeFile(target,original)
    const result=await upload(f,bytes);assert.equal(result.status,200)
    const row=f.db.prepare('SELECT * FROM tracks').get()
    assert.notEqual(row.file_path,target);assert.deepEqual(await fs.readFile(target),original)
    assert.equal(hash(await fs.readFile(row.file_path)),hash(bytes))
  } finally {await f.close()}
})

test('configured phone storage receives originals while app artwork and journal stay separate',async()=>{
  const path=require('node:path')
  const f=await fixture({destination:root=>path.join(root,'chosen-phone-folder')}),bytes=audio()
  try {
    assert.equal((await upload(f,bytes)).status,200)
    const row=f.db.prepare('SELECT * FROM tracks').get()
    assert.equal(path.dirname(row.file_path),path.join(f.root,'chosen-phone-folder'))
    assert.equal(f.service.artworkRoot,path.join(f.root,'artwork'))
    assert.equal(hash(await fs.readFile(row.file_path)),hash(bytes))
    await assert.rejects(fs.stat(path.join(f.root,'phone-downloads')),{code:'ENOENT'})
  } finally {await f.close()}
})
test('a changed selected volume after preparation refuses COMMIT and preserves privately received bytes',async()=>{
  let valid=true,entered,release
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve)
  const f=await fixture({validateDestination:()=>{if(!valid)throw new Error('selected volume changed')},
    boundary:async edge=>{if(edge==='afterPrepared'){entered();await gate}}}),bytes=audio()
  try {
    const pending=upload(f,bytes);await ready
    const row=f.db.prepare('SELECT * FROM phone_upload_operations').get()
    const received=f.service.files.candidate(row.candidate_path)
    valid=false;release()
    assert.equal((await pending).status,503)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,0)
    assert.equal(hash(await fs.readFile(received)),hash(bytes))
    valid=true
    assert.equal((await upload(f,bytes)).status,200)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
  } finally {valid=true;release();await f.close()}
})
