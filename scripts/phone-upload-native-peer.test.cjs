const assert=require('node:assert/strict')
const {test}=require('node:test')
const {spawn}=require('node:child_process')
const fs=require('node:fs/promises')
const path=require('node:path')
const {fixture,audio,hash,token}=require('./support/phone-upload-fixture.cjs')

// A compiled production Swift contract executable is supplied explicitly.
// Ordinary desktop runs keep their own receiver tests independent of Swift.
test('production Swift request/receipt implementation interoperates with the real desktop receiver',{
  skip:!process.env.LOKAL_NATIVE_PEER_BINARY,timeout:30000,
},async()=>{
  const f=await fixture(),bytes=audio()
  try {
    const file=path.join(f.root,'native-source.wav');await fs.writeFile(file,bytes)
    const child=spawn(process.env.LOKAL_NATIVE_PEER_BINARY,['--desktop-upload-peer',f.url,token,file],{stdio:['ignore','pipe','pipe']})
    let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data)
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)})
    assert.equal(code,0,output)
    assert.match(output,/Actual desktop\/native upload contract passed/)
    const tracks=f.db.prepare('SELECT * FROM tracks').all();assert.equal(tracks.length,1)
    assert.equal(hash(await fs.readFile(tracks[0].file_path)),hash(bytes))
    const outcomes=f.db.prepare('SELECT state FROM phone_upload_operations ORDER BY state').all()
    assert.deepEqual(outcomes.map(row=>row.state),['cancelled','committed'])
    assert.equal(hash(await fs.readFile(file)),hash(bytes),'phone source stays unchanged')
    console.log(output.trim())
  } finally {await f.close()}
})
