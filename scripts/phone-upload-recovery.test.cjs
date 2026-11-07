const assert = require('node:assert/strict')
const { test } = require('node:test')
const { fork } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { fixture, audio, headers, hash, token } = require('./support/phone-upload-fixture.cjs')
const childPath = path.join(__dirname,'support/phone-upload-crash.cjs')
for (const edge of ['afterFileSync','afterPrepared','beforeCommit','afterCommit','afterPublicLink','beforePublicationCommit','afterPublicationCommit']) {
  test(`actual process exit at ${edge} recovers one original and its stable outcome`,async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'upload-crash-')), bytes=audio()
    const child=fork(childPath,[root,edge],{stdio:['ignore','ignore','pipe','ipc']})
    let diagnostic='';child.stderr.on('data',data=>diagnostic+=data)
    const dead=new Promise(resolve=>child.once('exit',resolve))
    let f
    try {
      const {url}=await new Promise((resolve,reject)=>{
        child.once('message',resolve); child.once('error',reject)
        child.once('exit',code=>reject(new Error('No fixture server: '+code+' '+diagnostic)))
      })
      const pending=fetch(url+'/api/remote/files',{method:'POST',headers:headers(bytes),body:bytes}).catch(()=>null)
      assert.equal(await dead,73,diagnostic); await pending
      f=await fixture({root})
      const before=f.db.prepare('SELECT * FROM phone_upload_operations').get()
      const reply=await fetch(f.url+'/api/remote/files',{method:'POST',headers:headers(bytes),body:bytes})
      const outcome=await reply.json();assert.equal(reply.status,200,JSON.stringify(outcome))
      if(before.state==='committed')assert.equal(outcome.trackId,before.track_id)
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
      const track=f.db.prepare('SELECT * FROM tracks').get()
      assert.equal(hash(await fs.readFile(track.file_path)),hash(bytes))
      assert.equal(path.basename(track.file_path),'Original.wav')
      assert.equal(path.dirname(track.file_path),path.join(root,'phone-downloads'))
      const visible=(await fs.readdir(path.join(root,'phone-downloads'))).filter(name=>!name.startsWith('.'))
      assert.deepEqual(visible,['Original.wav'])
      const status=await fetch(f.url+'/api/remote/files/operations/'+outcome.operationID,{headers:{'x-remote-token':token}})
      assert.equal((await status.json()).trackId,track.id)
    } finally {
      if(child.exitCode===null)child.kill('SIGKILL')
      if(f)await f.close();else await fs.rm(root,{recursive:true,force:true})
    }
  })
}
test('lost HTTP reply after preparation cannot lead to a second committed original',async()=>{
  let entered,release
  const ready=new Promise(resolve=>entered=resolve), gate=new Promise(resolve=>release=resolve)
  const f=await fixture({boundary: async edge=>{if(edge==='afterPrepared'){entered();await gate}}}), bytes=audio()
  const controller=new AbortController()
  try {
    const pending=fetch(f.url+'/api/remote/files',{method:'POST',headers:headers(bytes),body:bytes,signal:controller.signal}).catch(()=>null)
    await ready; controller.abort();release();await pending
    // The server is allowed to finish already received bytes. A retry of the
    // immutable key either finds that COMMIT or resumes the same operation.
    let response
    for(let n=0;n<10;n++){
      response=await fetch(f.url+'/api/remote/files',{method:'POST',headers:headers(bytes),body:bytes})
      if(response.status!==409)break
      await response.arrayBuffer();await new Promise(resolve=>setTimeout(resolve,10))
    }
    const outcome=await response.json();assert.equal(response.status,200,JSON.stringify(outcome))
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
  } finally {release();await f.close()}
})

test('a new real process generation fences an older receiver still alive before COMMIT',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'upload-fence-')),bytes=audio()
  const child=fork(childPath,[root,'hold:afterPrepared'],{stdio:['ignore','ignore','pipe','ipc']})
  const dead=new Promise(resolve=>child.once('exit',resolve))
  let f
  try {
    const {url}=await new Promise(resolve=>child.once('message',resolve))
    const prepared=new Promise(resolve=>child.once('message',resolve))
    const older=fetch(url+'/api/remote/files',{method:'POST',headers:headers(bytes),body:bytes})
    assert.equal((await prepared).edge,'afterPrepared')
    f=await fixture({root})
    const fresh=await fetch(f.url+'/api/remote/files',{method:'POST',headers:headers(bytes),body:bytes})
    const result=await fresh.json(); assert.equal(fresh.status,200,JSON.stringify(result))
    child.send('resume')
    const stale=await older;assert.equal(stale.status,409)
    assert.equal((await stale.json()).error,'operation_retired')
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,1)
    assert.equal(f.db.prepare('SELECT track_id FROM phone_upload_operations').get().track_id,result.trackId)
  } finally {
    child.kill('SIGKILL');await dead
    if(f)await f.close();else await fs.rm(root,{recursive:true,force:true})
  }
})
