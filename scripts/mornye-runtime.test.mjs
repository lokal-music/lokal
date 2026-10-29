import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ExtensionRuntime } = require('../electron/mornye/runtime')
const { ExtensionHost, safePath } = require('../electron/mornye/host')
const { AddonStorage } = require('../electron/mornye/storage')
const { ExtensionNetwork } = require('../electron/mornye/network')
const { block } = require('../electron/mornye/crypto')
const { signedHeaders, SignedSession } = require('../electron/mornye/session')
const { isExpectedCallback } = require('../electron/mornye/authWindow')

async function fixture(t, code, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lokal-sflx-'))
  const permissions = { network: ['127.0.0.1'], allowHttp: true, storage: true, file: true }
  const addon = { key: '1234567890', manifest: { permissions } }
  const host = new ExtensionHost({ addon, storage: new AddonStorage(root), network: new ExtensionNetwork(permissions), root: path.join(root,'files'), ...overrides })
  const runtime = new ExtensionRuntime(code, { permissions, settings: {} }, host)
  t.after(async () => { runtime.close(); await fs.rm(root,{recursive:true,force:true}) })
  await runtime.ready
  return {runtime,host,root}
}

test('isolated guest preserves synchronous host APIs, settings, storage, this, and binary files', async t => {
  const { runtime } = await fixture(t, `registerExtension({
    initialize(s){this.value=s.name;storage.set('cache',{a:undefined,b:2});credentials.store('token','secret');},
    inspect(){file.writeBytes('track.bin',new Uint8Array([0,1,255]),{truncate:true});return {value:this.value,cached:storage.get('cache'),token:credentials.get('token'),binary:Array.from(new Uint8Array(file.readBytes('track.bin',{encoding:'bytes'}).data)),process:typeof process,require:typeof require};}
  });`)
  await runtime.invoke('initialize',[{name:'Lokal'}])
  assert.deepEqual(await runtime.invoke('inspect'),{value:'Lokal',cached:{a:null,b:2},token:'secret',binary:[0,1,255],process:'undefined',require:'undefined'})
})

test('host response objects support hasOwnProperty without prototype pollution', async t => {
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"ok":true}')})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const {runtime}=await fixture(t,`registerExtension({inspect(url,payload){
    const response=http.get(url)
    return {
      hasHeaderMethod:typeof response.headers.hasOwnProperty==='function',
      hasContentType:response.headers.hasOwnProperty('content-type')&&response.headers['content-type']==='application/json',
      payloadPrototype:Object.getPrototypeOf(payload)===Object.prototype,
      ownProto:Object.prototype.hasOwnProperty.call(payload,'__proto__'),
      payloadValue:payload.__proto__.polluted,
      globalPrototypeSafe:{}.polluted===undefined
    };
  }})`)
  const payload=JSON.parse('{"__proto__":{"polluted":true}}')
  const result=await runtime.invoke('inspect',[`http://127.0.0.1:${server.address().port}/headers`,payload],{timeoutMs:5000})
  assert.deepEqual(result,{hasHeaderMethod:true,hasContentType:true,payloadPrototype:true,ownProto:true,payloadValue:true,globalPrototypeSafe:true})
})

test('guest promises drain jobs and return results without leaking interpreter handles', async t => {
  const { runtime } = await fixture(t, `registerExtension({async answer(){return 42;}})`)
  assert.equal(await runtime.invoke('answer'),42)
})

test('host transfer callbacks can reenter synchronous storage APIs', async t => {
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Length','4');res.end('data')})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const {runtime}=await fixture(t,`registerExtension({download(id,quality,output,progress,opts){const r=file.download(id,output,{onProgress:(n,total)=>{storage.set('bytes',n);progress(n/total*100);}});return {success:r.success,bytes:storage.get('bytes'),prepared:opts.preparedContext.host_track.id};}})`)
  const result=await runtime.invoke('download',[`http://127.0.0.1:${server.address().port}/audio`,'best','track.bin',{preparedContext:{host_track:{id:'source-track'}}}],{timeoutMs:5000})
  assert.deepEqual(result,{success:true,bytes:4,prepared:'source-track'})
})

test('segmented downloads preserve order despite out-of-order responses', async t => {
  const server=http.createServer((req,res)=>{setTimeout(()=>res.end(req.url.slice(1)),req.url==='/a'?50:5)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}`
  const received=[]
  const {runtime,host}=await fixture(t,`registerExtension({run(base){const r=file.downloadSegments([base+'/a',base+'/b',base+'/c'],'track.bin',{maxParallel:3,onProgress:()=>storage.set('progress',true)});return {success:r.success,body:file.read('track.bin').data,progress:storage.get('progress')};}})`,{
    onByteProgress: bytes => received.push(bytes),
  })
  assert.deepEqual(await runtime.invoke('run',[base],{timeoutMs:5000}),{success:true,body:'abc',progress:true})
  assert.equal((await fs.readFile(path.join(host.root,'track.bin'))).toString(),'abc')
  assert.equal(received.reduce((sum, bytes)=>sum+bytes,0),3,
    'each segment must report received bytes even before completion percentages advance')
  assert.equal(received.length,3)
})

test('deadline and cancellation retire runaway runtimes', async t => {
  const {runtime}=await fixture(t,`registerExtension({run(){while(true){}}})`)
  await assert.rejects(runtime.invoke('run',[],{timeoutMs:100}),/interrupt|timed out/i)
  runtime.close()
  const other=await fixture(t,`registerExtension({run(){utils.sleep(300000);return true;}})`)
  const controller=new AbortController()
  const pending=other.runtime.invoke('run',[],{timeoutMs:10000,signal:controller.signal})
  setTimeout(()=>controller.abort(),100)
  await assert.rejects(pending,/cancel/i)
  assert.equal(other.runtime.closed,true)
})

test('path grants reject traversal and symlink escapes', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lokal-paths-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  assert.throws(()=>safePath(root,'../other'),/Invalid/)
  await fs.symlink(os.tmpdir(),path.join(root,'link'))
  assert.throws(()=>safePath(root,'link/secret'),/links/)
})

test('addon paths work beneath symlinked OS ancestors but reject symlinks inside the grant', async t => {
  const backing=await fs.mkdtemp(path.join(os.tmpdir(),'lokal-home-'))
  const alias=backing+'-link'
  t.after(async()=>{await fs.rm(backing,{recursive:true,force:true});await fs.rm(alias,{recursive:true,force:true})})
  await fs.symlink(backing,alias,'dir')
  const root=path.join(alias,'user-data','mornye')
  await fs.mkdir(root,{recursive:true})
  assert.equal(safePath(root,'nested/file.dat'),path.join(root,'nested','file.dat'))
  await fs.symlink(os.tmpdir(),path.join(root,'inside-link'),'dir')
  assert.throws(()=>safePath(root,'inside-link/file.dat'),/links/)
})

test('AES and Blowfish match published block-cipher vectors', async () => {
  const aes=await block('encrypt','6bc1bee22e409f96e93d7e117393172a',{algorithm:'aes',mode:'cbc',key:'2b7e151628aed2a6abf7158809cf4f3c',keyEncoding:'hex',iv:'000102030405060708090a0b0c0d0e0f',ivEncoding:'hex',inputEncoding:'hex',outputEncoding:'hex'})
  assert.equal(aes.data,'7649abac8119b246cee98e9b12e9197d')
  const bf=await block('encrypt','0000000000000000',{algorithm:'blowfish',key:'0000000000000000',keyEncoding:'hex',iv:'0000000000000000',ivEncoding:'hex',inputEncoding:'hex',outputEncoding:'hex'})
  assert.equal(bf.data,'4ef997456198dd78')
  const plain=await block('decrypt',bf.data,{algorithm:'blowfish',key:'0000000000000000',keyEncoding:'hex',iv:'0000000000000000',ivEncoding:'hex',inputEncoding:'hex',outputEncoding:'hex'})
  assert.equal(plain.data,'0000000000000000')
})

test('signed requests use the manifest identity, exact body bytes, and empty canonical query', () => {
  const config={appVersion:'source@1.0.0',platform:'extension',schemeLabel:'ZARZ-HMAC-V1',headerPrefix:'X-Zarz-',timeWindowSeconds:300}
  const record={session_id:'session',session_secret:'secret'}
  const a=signedHeaders(config,record,'post','https://example.com/v2/media?q=one','{"id":"1"}',1700000000000,'nonce')
  const b=signedHeaders(config,record,'POST','https://example.com/v2/media?q=two','{"id":"1"}',1700000000000,'nonce')
  assert.deepEqual(a,b)
  assert.equal(a['X-Zarz-App-Version'],'source@1.0.0')
  assert.equal(a['X-Zarz-Timestamp'],'2023-11-14T22:13:20.000Z')
  assert.notEqual(a['X-Zarz-Signature'],signedHeaders(config,record,'POST','https://example.com/v2/media','{ "id":"1"}',1700000000000,'nonce')['X-Zarz-Signature'])
})

test('signed-session grants require pending callback ownership and reject replay', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lokal-session-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const network={permissions:{network:['gateway.example']},async jsonResponse(url,opts){return {ok:true,status:200,body:JSON.stringify(opts?.method==='POST'?{session_id:'sid',session_secret:'secret',expires_at:new Date(Date.now()+86400000).toISOString()}:{auth_url:'https://gateway.example/challenge?state=owned'})}}}
  const session=new SignedSession({baseUrl:'https://gateway.example/v2',callbackUrl:'mornye://session-grant'},new AddonStorage(root),network,'1234567890')
  assert.equal(await session.bootstrap(),false)
  await assert.rejects(session.callback('mornye://session-grant?state=wrong&grant=value'),/Invalid/)
  await session.callback('mornye://session-grant?state=owned&grant=value')
  assert.equal(session.status().authenticated,true)
  assert.equal(session.status().session_secret,undefined)
  await assert.rejects(session.callback('spotiflac://session-grant?state=owned&grant=value'),/Invalid/)
})

test('Mornye callback matcher handles top-level and window.open handoffs with legacy compatibility', () => {
  const runtime = { host: { session: { config: {} }, auth: {} } }
  assert.equal(isExpectedCallback('mornye://session-grant?state=x&grant=y', runtime), true)
  assert.equal(isExpectedCallback('spotiflac://session-grant?state=x&grant=y', runtime), true)
  assert.equal(isExpectedCallback('https://gateway.example/finish?cb=mornye%3A%2F%2Fsession-grant%3Fstate%3Dx', runtime), true)
  assert.equal(isExpectedCallback('https://example.com/not-the-callback', runtime), false)
  runtime.host.session.config.callbackUrl = 'https://gateway.example/callback'
  assert.equal(isExpectedCallback('https://gateway.example/callback?code=x', runtime), true)
  assert.equal(isExpectedCallback('mornye://session-grant?state=x', runtime), false)
})

test('signed-session default callback is Mornye while a legacy callback remains accepted', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lokal-session-default-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const network={permissions:{network:['gateway.example']},async jsonResponse(url,opts){return {ok:true,status:200,body:JSON.stringify(opts?.method==='POST'?{session_id:'sid',session_secret:'secret',expires_at:new Date(Date.now()+86400000).toISOString()}:{auth_url:'https://gateway.example/challenge?state=owned'})}}}
  for (const callback of ['mornye://session-grant','spotiflac://session-grant']) {
    const owner = callback.startsWith('mornye:') ? 'mornye-test-owner' : 'legacy-test-owner'
    const session=new SignedSession({baseUrl:'https://gateway.example/v2'},new AddonStorage(root),network,owner)
    assert.equal(await session.bootstrap(),false)
    await session.callback(`${callback}?state=owned&grant=value`)
    assert.equal(session.status().authenticated,true)
  }
})
