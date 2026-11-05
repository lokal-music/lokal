const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs/promises')
const os=require('node:os')
const path=require('node:path')
const {walkDir}=require('../electron/ipc/walkMusicFiles')
const {PRIVATE_PHONE_UPLOAD_DIRECTORY,isPrivatePhoneUploadPath}=require('../electron/phoneUploadPaths')

test('real library enumeration never sees prepared phone audio before its durable receipt commits',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'phone-scan-'))
  try {
    const privateRoot=path.join(root,PRIVATE_PHONE_UPLOAD_DIRECTORY,'11111111-1111-4111-8111-111111111111')
    await fs.mkdir(privateRoot,{recursive:true})
    await fs.writeFile(path.join(privateRoot,'not-yet-committed.wav'),'partial private audio')
    const music=path.join(root,'Published.wav');await fs.writeFile(music,'committed original')
    assert.deepEqual(await walkDir(root),[music])
    assert.deepEqual(await walkDir(privateRoot),[])
    assert.equal(isPrivatePhoneUploadPath('C:\\Music\\'+PRIVATE_PHONE_UPLOAD_DIRECTORY+'\\file.wav'),true)
    assert.equal(isPrivatePhoneUploadPath(path.join(root,'unrelated.wav')),false)
  } finally {await fs.rm(root,{recursive:true,force:true})}
})
