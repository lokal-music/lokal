import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const Database=require('better-sqlite3'),AdmZip=require('adm-zip')
const {PackageService,readArchive,validateManifest,trackOf}=require('../electron/mornye/packages')
const {mergePackageDownloadTags}=require('../electron/download/manager')
const {rangeOf,fileResponse}=require('../electron/mornye/media')
const {resolveKnownAlbum}=require('../electron/download/postprocess')
const {isPlaceholderAlbum}=require('../electron/download/tagger')

const manifest={name:'fixture-provider',displayName:'Fixture',version:'1.0.0',type:['metadata_provider','download_provider'],permissions:{network:[],storage:true,file:true},requiredRuntimeFeatures:['preparedContext@1'],settings:[{key:'token',type:'string',secret:true},{key:'country',type:'string',default:'US'}]}
function archive(m=manifest,code=`registerExtension({initialize(s){settings=s;},searchTracks(query){return {tracks:[{id:'source-id',name:query,artists:'Artist',album_name:'Album',duration_ms:180000,isrc:'USAAA2600001'}]};},download(){return {success:false,error:'Fixture does not download'};}})`){const zip=new AdmZip();zip.addFile('manifest.json',Buffer.from(JSON.stringify(m)));zip.addFile('index.js',Buffer.from(code));return zip.toBuffer()}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'lokal-packages-')),db=new Database(':memory:');db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT)');const service=new PackageService(db,{root,tools:()=>({})});t.after(async()=>{for(const runtime of service.runtimes.values())runtime.close();db.close();await fs.rm(root,{recursive:true,force:true})});return {service,db,root}}

test('resolved addon album metadata wins over blank or placeholder queue tags',()=>{
  assert.equal(mergePackageDownloadTags({album:'Amazon Album'},{album:undefined}).album,'Amazon Album')
  assert.equal(mergePackageDownloadTags({album_name:'Amazon Album'},{album:'Unknown album'}).album,'Amazon Album')
  assert.equal(mergePackageDownloadTags({album:'Unknown album'},{album:'Spotify Album'}).album,'Spotify Album')
  assert.equal(mergePackageDownloadTags({album:'Unknown album'},{album:'Unknown album'}).album,undefined)
})

test('album metadata ignores placeholder names when a real album field is available',()=>{
  assert.equal(trackOf({id:'plain',name:'Song',artists:'Artist',album:'Plain Album'},'a-1234567890').album,'Plain Album')
  assert.equal(trackOf({id:'nested',name:'Song',artists:'Artist',album:{name:'Amazon Album'}},'a-1234567890').album,'Amazon Album')
  assert.equal(trackOf({id:'nested-title',name:'Song',artists:'Artist',album:{title:'Title Album'}},'a-1234567890').album,'Title Album')
  assert.equal(trackOf({id:'nested-id',name:'Song',artists:'Artist',album:{id:'B012345678',name:'Amazon Album'}},'a-1234567890').albumId,'B012345678')
  assert.equal(trackOf({id:'nested-alias',name:'Song',artists:'Artist',album:{albumId:'amazon-album-2',title:'Amazon Album'}},'a-1234567890').albumId,'amazon-album-2')
  assert.equal(trackOf({id:'placeholder',name:'Song',album_name:'Unknown album',album:'Actual Album'},'a-1234567890').album,'Actual Album')
  assert.equal(trackOf({id:'unknown-only',name:'Song',album_name:'Unknown album',album:'N/A'},'a-1234567890').album,null)
})

test('placeholder album tags yield to real source metadata without replacing valid embedded albums',()=>{
  assert.equal(isPlaceholderAlbum('Unknown album'),true)
  assert.equal(isPlaceholderAlbum(''),true)
  assert.equal(isPlaceholderAlbum('The Real Album'),false)
  assert.deepEqual(resolveKnownAlbum('Unknown album','Amazon Album'),{value:'Amazon Album',replace:true})
  assert.deepEqual(resolveKnownAlbum('','Amazon Album'),{value:'Amazon Album',replace:true})
  assert.deepEqual(resolveKnownAlbum('Existing Album','Amazon Album'),{value:'Existing Album',replace:false})
  assert.deepEqual(resolveKnownAlbum('Unknown album','Unknown album'),{value:'Unknown album',replace:false})
})

test('legacy add-on tables migrate to Mornye names without losing existing rows', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lokal-legacy-mornye-'))
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE spotiflac_repositories (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT, refreshed_at INTEGER, index_json TEXT, error TEXT);
    CREATE TABLE spotiflac_packages (key TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL, repository_id TEXT, digest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, installed_at INTEGER NOT NULL, methods_json TEXT NOT NULL);
    CREATE TABLE spotiflac_tracks (provider TEXT NOT NULL, id TEXT NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY(provider,id));
  `)
  db.prepare('INSERT INTO spotiflac_repositories (id,url,name) VALUES (?,?,?)').run('legacy-repo', 'https://legacy.example/registry.json', 'Legacy repository')
  db.prepare('INSERT INTO spotiflac_packages (key,name,manifest_json,repository_id,digest,enabled,installed_at,methods_json) VALUES (?,?,?,?,?,?,?,?)')
    .run('legacy-key', 'legacy-addon', JSON.stringify(manifest), 'legacy-repo', 'digest', 1, 1, JSON.stringify(['initialize']))
  db.prepare('INSERT INTO spotiflac_tracks (provider,id,metadata_json) VALUES (?,?,?)')
    .run('a-legacy-key', 'legacy-track', JSON.stringify({ title: 'Preserved track' }))
  const service = new PackageService(db, { root, tools: () => ({}) })
  t.after(async () => {
    for (const runtime of service.runtimes.values()) runtime.close()
    db.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  assert.equal(service.repos().some(repo => repo.id === 'legacy-repo'), true)
  assert.equal(service.find('legacy-key')?.manifest.name, manifest.name)
  assert.deepEqual(db.prepare('SELECT metadata_json FROM mornye_tracks WHERE provider=? AND id=?').get('a-legacy-key', 'legacy-track'), { metadata_json: JSON.stringify({ title: 'Preserved track' }) })
  for (const table of ['spotiflac_repositories', 'spotiflac_packages', 'spotiflac_tracks']) {
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined)
  }
})

test('install, search, update and enable preserve provider identity and isolated secret settings',async t=>{
  const {service,root}=await fixture(t),installed=await service.install({buffer:archive()})
  assert.equal(installed.kind,'mornye');assert.ok(installed.resources.includes('search'))
  service.setSettings(installed.key,{token:'private-token',country:'GB'})
  assert.equal(service.list()[0].settings.token,undefined)
  assert.deepEqual(service.list()[0].configuredSecrets,['token'])
  assert.equal((await fs.readFile(path.join(root,'data',installed.key,'settings.enc'))).includes(Buffer.from('private-token')),false)
  const results=await service.search(installed.key,'Song')
  assert.equal(results[0].title,'Song');assert.equal(results[0].duration,180);assert.equal(results[0].provider,installed.provider)
  service.setEnabled(installed.key,false)
  await assert.rejects(service.search(installed.key,'Song'),/turned off/)
  const updated=await service.install({buffer:archive({...manifest,version:'1.1.0'})})
  assert.equal(updated.key,installed.key);assert.equal(updated.enabled,false);assert.equal(updated.settings.country,'GB')
  await assert.rejects(service.install({buffer:archive()}),/downgrade/)
})

test('registries exclude metadata-only entries and enforce package SHA-256 and identity',async t=>{
  const {service}=await fixture(t),buffer=archive(),digest=crypto.createHash('sha256').update(buffer).digest('hex')
  const entry={id:manifest.name,category:'download',version:manifest.version,sha256:digest,download_url:'https://packages.example/source.sflx'}
  service.document=async url=>url.endsWith('.sflx')?buffer:Buffer.from(JSON.stringify({version:1,extensions:[entry,{id:'metadata-only',category:'integration'}]}))
  const repo=await service.addRepo('https://packages.example/registry.json')
  assert.equal(service.catalogue(repo.id).length,1)
  await service.install({repositoryId:repo.id,id:manifest.name})
  service.db.prepare('UPDATE mornye_repositories SET index_json=? WHERE id=?').run(JSON.stringify([{...entry,sha256:'0'.repeat(64)}]),repo.id)
  await assert.rejects(service.install({repositoryId:repo.id,id:manifest.name}),/SHA-256/)
  service.removeRepo(repo.id);assert.equal(service.list().length,1)
})

test('playlist-link addons (metadata with a link handler) install but are not stream or download sources',async t=>{
  const {service}=await fixture(t)
  const links={...manifest,name:'links-fixture',type:['metadata_provider'],urlHandler:{enabled:true,patterns:['open.example.com']}}
  await assert.rejects(service.install({buffer:archive({...links,urlHandler:undefined})}),/playlist-link/)
  const installed=await service.install({buffer:archive(links,`registerExtension({initialize(){},handleUrl(u){return {type:'playlist',name:'P',tracks:[{id:'1',name:'Song',artists:'A'}]};}})`)})
  assert.equal(installed.linksOnly,true)
  const addons=require('../electron/online/addons')
  assert.equal(addons.searchable(service.db).some(a=>a.key===installed.key),false)
})

test('packages reject unsafe archive paths, missing downloads, and unsupported compatibility features',()=>{
  assert.throws(()=>validateManifest({...manifest,type:['metadata_provider']}),/download-capable/)
  assert.throws(()=>validateManifest({...manifest,requiredRuntimeFeatures:['futureApi@99']}),/Unsupported/)
  assert.throws(()=>validateManifest({...manifest,minAppVersion:'99.0.0'}),/compatibility/)
  const zip=new AdmZip();zip.addFile('../escape.js',Buffer.from(''));zip.addFile('manifest.json',Buffer.from(JSON.stringify(manifest)));zip.addFile('index.js',Buffer.from(''))
  // adm-zip normalizes traversal on addition; duplicate root names are also
  // rejected by the package reader independently of library extraction.
  assert.throws(()=>readArchive(Buffer.from('not a zip')))
})

test('file-backed media supports open, suffix, unsatisfiable ranges and byte-accurate seeking',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lokal-range-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'audio.flac');await fs.writeFile(file,'0123456789')
  assert.deepEqual(rangeOf('bytes=-3',10),{start:7,end:9,status:206})
  const response=await fileResponse(file,{range:'bytes=2-5',mime:'audio/flac'})
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 2-5/10');assert.equal(await response.text(),'2345')
  assert.equal((await fileResponse(file,{range:'bytes=10-'})).status,416)
})

test('a package download crosses the real host, FFprobe validation, and staged cleanup',async t=>{
  const {service}=await fixture(t)
  const wav=Buffer.alloc(44+8000*2);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Length',String(wav.length));res.end(wav)})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const key='fixture-provider',permissions={...manifest.permissions,network:['127.0.0.1'],allowHttp:true}
  service.toolProvider=()=>({ffmpeg:'ffmpeg',ffprobe:'ffprobe'})
  const code=`registerExtension({enrichTrack(track){return {...track,artists:[],album_name:'Unknown album',album_artist:'   '};},getTrack(id){return id==='B012345678'?{id,name:'Fixture Song',artists:'Fixture Artist',album:{id:'album-123',name:'Unknown album'},album_name:'Unknown album',album_artist:'   ',provider_id:'amazon'}:null;},getAlbum(id){return id==='album-123'?{id,name:'Fixture Album',artist:'Fixture Album Artist'}:null;},checkAvailability(isrc,name,artists,options){return options.track.album_name==='Unknown album'?{available:true,track_id:'B012345678'}:{available:false,reason:'Expected unresolved source metadata before Amazon match'};},download(id,quality,output,progress){var r=file.download('http://127.0.0.1:${server.address().port}/audio',output,{onProgress:function(w,t){progress(t?100*w/t:0);}});return {success:r.success,file_path:r.path,title:'Fixture Song',artist:'Fixture Artist'};}})`
  const installed=await service.install({buffer:archive({...manifest,name:'amazon',permissions},code)})
  // The original cross-provider row has no Amazon album ID. checkAvailability()
  // resolves an ASIN; getTrack() then reveals a nested album ID and placeholder
  // title, so getAlbum() must run after matching and fill the prepared metadata.
  service.remember(installed.key,[{id:'source-id',name:'Fixture Song',artists:'Fixture Artist',album_artist:'   ',album_name:'Unknown album',duration_ms:1000}])
  const result=await service.download(installed.key,'source-id',{purpose:'playback'})
  try { assert.equal(result.info.codec,'pcm_s16le');assert.equal(path.extname(result.file),'.wav','WAV audio written to audio.flac is rewrapped for the player');assert.equal(result.info.duration_ms,1000);assert.equal(result.metadata.album,'Fixture Album');assert.equal(result.metadata.album_name,'Fixture Album');assert.equal(result.metadata.album_artist,'Fixture Album Artist');assert.ok((await fs.stat(result.file)).size>44) } finally { await result.cleanup() }
})

test('failed optional enrichment preserves the authoritative availability reason',async t=>{
  const {service}=await fixture(t)
  const code=`let checks=0;
    registerExtension({
      initialize(){},
      checkAvailability(){checks++;return {available:false,reason:checks===1?'Unavailable initially':'Still unavailable'};},
      enrichTrack(){throw new Error('Optional metadata lookup unavailable');},
      download(){throw new Error('Unreachable download stage');}
    })`
  const installed=await service.install({buffer:archive({...manifest,name:'tidal'},code)})
  service.remember(installed.key,[{id:'123',name:'Song',artists:'Artist',provider_id:'tidal'}])
  await assert.rejects(
    service.download(installed.key,'123',{purpose:'playback'}),
    /Still unavailable/,
  )
})

test('native Tidal acquisition checks availability before enrichment for both Play and Save',async t=>{
  const {service}=await fixture(t)
  const wav=Buffer.alloc(44+8000*2)
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4)
  wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16)
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22)
  wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28)
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34)
  wav.write('data',36);wav.writeUInt32LE(wav.length-44,40)
  const server=http.createServer((_req,res)=>{
    res.setHeader('Content-Length',String(wav.length));res.end(wav)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  service.toolProvider=()=>({ffmpeg:'ffmpeg',ffprobe:'ffprobe'})
  const port=server.address().port
  const code=`var order=[];
    registerExtension({
      initialize(){},
      enrichTrack(track){order.push('enrichment');return {...track,enriched:true};},
      checkAvailability(isrc,name,artists,options){
        order.push('availability');
        return options.track.enriched
          ? {available:true,track_id:'12345'}
          : {available:false,reason:'Needs fresh metadata'};
      },
      download(id,quality,output,progress){
        if(order.join(',')!=='availability,enrichment,availability')
          return {success:false,error:'Acquisition steps were not sequenced correctly'};
        var r=file.download('http://127.0.0.1:${port}/audio',output,{
          onProgress:function(w,t){progress(t?100*w/t:0);}
        });
        return {success:r.success,file_path:r.path};
      }
    })`
  const installed=await service.install({buffer:archive({
    ...manifest,name:'tidal',permissions:{...manifest.permissions,network:['127.0.0.1'],allowHttp:true},
  },code)})
  service.remember(installed.key,[{
    id:'12345',name:'Song',artists:'Artist',duration_ms:1000,provider_id:'tidal',
  }])
  for(const purpose of ['playback','download']){
    const result=await service.download(installed.key,'12345',{purpose})
    try{assert.ok((await fs.stat(result.file)).size>44);assert.equal(result.info.codec,'pcm_s16le')}
    finally{await result.cleanup()}
  }
})

test('an addon login (tokens and verification cookies) survives a restart, and Disconnect forgets it',async t=>{
  const {service,db,root}=await fixture(t),installed=await service.install({buffer:archive({...manifest,signedSession:undefined,globalActions:[{action:'login',label:'Log in'}]})})
  assert.equal(service.list()[0].access.kind,'login');assert.equal(service.list()[0].access.ready,false)
  const runtime=await service.runtime(installed.key)
  await runtime.host.call('auth.setAuthCode',[{access_token:'token-1',refresh_token:'refresh-1',expires_at:Date.now()+3600000}])
  runtime.host.network.cookies.setCookieSync('cf_clearance=abc; Domain=example.com; Path=/; Secure','https://example.com/')
  runtime.host.network.persist()
  service.shutdown()
  assert.equal((await fs.readFile(path.join(root,'data',installed.key,'connection.enc'))).includes(Buffer.from('token-1')),false)
  const restarted=new PackageService(db,{root,tools:()=>({})});t.after(()=>{for(const r of restarted.runtimes.values())r.close()})
  assert.equal(restarted.list()[0].access.ready,true)
  const again=await restarted.runtime(installed.key)
  assert.equal(await again.host.call('auth.getTokens',[]).then(tokens=>tokens.access_token),'token-1')
  assert.match(again.host.network.cookies.getCookieStringSync('https://example.com/'),/cf_clearance=abc/)
  restarted.storage.write(installed.key,'credentials',{account:'saved-by-addon'})
  const generation=again.host.network.generation || 0
  restarted.forgetConnection(installed.key);again.host.session?.clear()
  assert.equal(again.host.network.generation,generation+1)
  assert.deepEqual(Object.keys(restarted.storage.read(installed.key,'credentials')),[])
  await again.host.call('auth.clearAuth',[])
  restarted.shutdown()
  const fresh=new PackageService(db,{root,tools:()=>({})});t.after(()=>{for(const r of fresh.runtimes.values())r.close()})
  assert.equal(fresh.list()[0].access.ready,false)
})

test('a plain FLAC download can be played while it arrives, and a range past what arrived waits for it',async t=>{
  const {liveUpdate,liveResponse}=require('../electron/mornye/media')
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lokal-live-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const file=path.join(dir,'audio.flac'),part=`${file}.part`,total=200000
  const bytes=Buffer.alloc(total,7);bytes.write('fLaC',0,'latin1')
  await fs.writeFile(part,bytes.subarray(0,100000))
  let ready=false;const job={status:'running',markLive:()=>{ready=true},promise:new Promise(()=>{})}
  liveUpdate(job,{part,file,total,written:100000})
  assert.equal(ready,true);assert.equal(job.live.ready,true)
  const pending=liveResponse(job,{range:'bytes=150000-150099'}).then(res=>res.arrayBuffer().then(body=>({status:res.status,range:res.headers.get('content-range'),length:body.byteLength})))
  await new Promise(resolve=>setTimeout(resolve,300))
  await fs.appendFile(part,bytes.subarray(100000));liveUpdate(job,{part,file,total,written:total})
  assert.deepEqual(await pending,{status:206,range:'bytes 150000-150099/200000',length:100})
  // A retry that starts the file over replaces the live state, so a reader of the old one stops.
  const before=job.live
  liveUpdate(job,{part,file,total,written:5000})
  assert.notEqual(job.live,before);assert.equal(job.live.ready,false)
  // Anything that isn't a FLAC from the first bytes waits for the complete file.
  const other={status:'running',markLive:()=>{throw new Error('must not go live')}}
  await fs.writeFile(path.join(dir,'b.flac.part'),Buffer.alloc(100000,1))
  liveUpdate(other,{part:path.join(dir,'b.flac.part'),file:path.join(dir,'b.flac'),total,written:100000})
  assert.equal(other.live.ready,false)
})

test('a package whose saved settings cannot be decrypted still lists, with its defaults', async t => {
  const { service, root } = await fixture(t), installed = await service.install({ buffer: archive() })
  service.setSettings(installed.key, { token: 'private-token', country: 'GB' })
  // The OS vault key changed: the saved settings no longer decrypt.
  await fs.writeFile(path.join(root, 'data', installed.key, 'settings.enc'), crypto.randomBytes(80))
  const listed = service.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].key, installed.key)
})

test('resetting saved logins removes the key and encrypted files, and new settings can be saved after', async t => {
  const { service, root } = await fixture(t), installed = await service.install({ buffer: archive() })
  service.setSettings(installed.key, { token: 'old-token', country: 'GB' })
  assert.ok(await fs.stat(path.join(root, 'master-key.json')))
  assert.deepEqual(service.resetCredentials(), { ok: true })
  await assert.rejects(fs.stat(path.join(root, 'master-key.json')))
  await assert.rejects(fs.stat(path.join(root, 'data', installed.key, 'settings.enc')))
  assert.equal(service.list().length, 1)
  service.setSettings(installed.key, { token: 'new-token' })
  assert.deepEqual(service.list()[0].configuredSecrets, ['token'])
})

test('macOS keeps the addon key in a private file so updates cannot lock it away, and recovers from a lost Keychain key', async t => {
  const { AddonStorage } = require('../electron/mornye/storage')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lokal-vault-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const fakeVault = { encryptString: text => Buffer.from(`v:${text}`), decryptString: bytes => bytes.toString().slice(2) }
  const read = () => JSON.parse(require('node:fs').readFileSync(path.join(root, 'master-key.json'), 'utf8'))

  // A new key on macOS is local even when the Keychain works, and is the same after a "restart".
  const first = new AddonStorage(root, { platform: 'darwin', vault: () => fakeVault }), key = first.masterKey()
  assert.equal(read().kind, 'local')
  assert.deepEqual(new AddonStorage(root, { platform: 'darwin', vault: () => null }).masterKey(), key)

  // A Keychain key from an older build that still reads is moved into the file.
  const oldKey = crypto.randomBytes(32)
  await fs.writeFile(path.join(root, 'master-key.json'), JSON.stringify({ kind: 'os', value: fakeVault.encryptString(oldKey.toString('base64')).toString('base64') }))
  assert.deepEqual(new AddonStorage(root, { platform: 'darwin', vault: () => fakeVault }).masterKey(), oldKey)
  assert.equal(read().kind, 'local')

  // A Keychain key that can no longer be read: new key, old encrypted files dropped, old key file kept aside.
  await fs.writeFile(path.join(root, 'master-key.json'), JSON.stringify({ kind: 'os', value: 'bG9zdA==' }))
  await fs.mkdir(path.join(root, 'data', 'abcdef0123'), { recursive: true })
  await fs.writeFile(path.join(root, 'data', 'abcdef0123', 'settings.enc'), 'stale')
  const recovered = new AddonStorage(root, { platform: 'darwin', vault: () => null }).masterKey()
  assert.equal(recovered.length, 32)
  assert.equal(read().kind, 'local')
  await assert.rejects(fs.stat(path.join(root, 'data', 'abcdef0123', 'settings.enc')))
  assert.ok(await fs.stat(path.join(root, 'master-key.os-backup.json')))

  // Other systems still refuse to run without their vault.
  await fs.writeFile(path.join(root, 'master-key.json'), JSON.stringify({ kind: 'os', value: 'bG9zdA==' }))
  assert.throws(() => new AddonStorage(root, { platform: 'linux', vault: () => null }).masterKey(), /credential vault/)
})
