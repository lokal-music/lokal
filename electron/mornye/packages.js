const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const AdmZip = require('adm-zip')
const { AddonStorage, atomicWrite } = require('./storage')
const { CookieJar } = require('tough-cookie')
const { ExtensionNetwork, validateURL } = require('./network')
const { SignedSession } = require('./session')
const { ExtensionHost, safePath, runTool, mediaInfo } = require('./host')
const { ExtensionRuntime } = require('./runtime')

const REGISTRY = 'https://raw.githubusercontent.com/mornyeapp/Mornye-Extension/refs/heads/main/registry.json'
const AMAZON_NEW_REGISTRY = 'https://raw.githubusercontent.com/CHEYCKIT/Mornye-Extension/refs/heads/feature/amazon-new-release-20261029/amazon-new-registry.json'
const COMPAT_VERSION = '5.1.0'
const FEATURES = { signedSession: 3, sessionRefresh: 1, sessionGrant: 1, globalAction: 1, webviewAuth: 1, downloadSegments: 1, patternedFileTransform: 1, preparedContext: 1, accountForms: 1, accountDownloadMode: 1, directMedia: 1 }
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const keyOf = name => crypto.createHash('sha1').update(`spotiflac:${name}`).digest('hex').slice(0,10)
function compareVersions(a,b) {
  const left=String(a || '0').split('.').map(v=>Number(v)||0),right=String(b || '0').split('.').map(v=>Number(v)||0)
  for(let i=0;i<Math.max(left.length,right.length);i++){const d=(left[i]||0)-(right[i]||0);if(d)return Math.sign(d)}return 0
}
function validateManifest(manifest) {
  if(!manifest || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(manifest.name || '') || typeof manifest.displayName!=='string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version || ''))throw new Error('Invalid Mornye package manifest')
  // Download providers, or metadata addons that read playlist links (Spotify
  // Web, Apple Music): those are only used to sync linked playlists.
  if(!Array.isArray(manifest.type)||!(manifest.type.includes('download_provider')||manifest.type.includes('metadata_provider')&&manifest.urlHandler?.enabled))throw new Error('Only download-capable or playlist-link Mornye addons can be installed')
  if(compareVersions(manifest.minAppVersion,COMPAT_VERSION)>0)throw new Error(`This addon requires Mornye compatibility ${manifest.minAppVersion}`)
  for(const required of manifest.requiredRuntimeFeatures || []){
    const match=String(required).match(/^([A-Za-z]+)@(\d+)$/)
    if(!match||!FEATURES[match[1]]||FEATURES[match[1]]<Number(match[2]))throw new Error(`Unsupported runtime feature: ${required}`)
  }
  const permissions=manifest.permissions
  if(!permissions || !Array.isArray(permissions.network)||permissions.network.length>100||permissions.network.some(d=>typeof d!=='string'||!/^(?:\*\.)?[a-z0-9.-]+$/i.test(d)))throw new Error('Invalid addon network permissions')
  if(manifest.signedSession){validateURL(manifest.signedSession.baseUrl,permissions);if(!permissions.storage)throw new Error('Signed sessions require storage permission')}
  if((manifest.settings || []).length>100||(manifest.qualityOptions || []).length>30)throw new Error('Addon manifest is too large')
  return manifest
}
function readArchive(buffer) {
  if(buffer.length>32*1024*1024)throw new Error('Addon package exceeds 32 MB')
  const zip=new AdmZip(buffer),entries=zip.getEntries(),names=new Set();let total=0
  if(entries.length>100)throw new Error('Addon package contains too many files')
  for(const entry of entries){
    const name=entry.entryName
    if(names.has(name)||!name||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').some(part=>part==='..'||part==='.')||((entry.header.attr>>>16)&0o170000)===0o120000)throw new Error('Addon package contains an unsafe archive path')
    names.add(name);total+=entry.header.size
    if(total>64*1024*1024)throw new Error('Unpacked addon package exceeds 64 MB')
  }
  if(!names.has('manifest.json')||!names.has('index.js'))throw new Error('A Mornye package needs manifest.json and index.js at its root')
  const manifest=validateManifest(JSON.parse(zip.readAsText('manifest.json'))),code=zip.readAsText('index.js')
  if(Buffer.byteLength(code)>8*1024*1024)throw new Error('Addon script exceeds 8 MB')
  return {zip,manifest,code}
}
function isPlaceholderAlbum(value) {
  const album = typeof value === 'string' ? value.trim() : ''
  return !album || /^(?:unknown(?:\s+album)?|untitled(?:\s+album)?|n\/?a|none|null|undefined)$/i.test(album)
}

function albumNameOf(track) {
  const album = track?.album
  const candidates = [
    track?.album_name,
    track?.albumName,
    track?.album_title,
    track?.albumTitle,
    typeof album === 'string' ? album : null,
    album && typeof album === 'object' ? album.name || album.title || album.album_name || album.albumName : null,
  ]
  return candidates.find(value => typeof value === 'string' && !isPlaceholderAlbum(value))?.trim() || null
}

function albumIdOf(track) {
  const album = track?.album && typeof track.album === 'object' ? track.album : null
  const direct = [track?.album_id, track?.albumId, album?.id, album?.album_id, album?.albumId]
    .find(value => value != null && String(value).trim())
  if (direct != null) return String(direct).trim()
  const url = String(track?.album_url || track?.albumUrl || '')
  const match = url.match(/\/albums?\/([^/?#]+)/i)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return match[1] }
}

const { hasAtmosMetadata } = require('./atmos')
const { addonDownloadQuality, isAtmosQuality } = require('./playbackQuality')
const { probeAtmosFile } = require('../quality/atmos')
const { shouldRetryEnrichment, isLiveProvider } = require('./providerFastPath')

/** Keep album metadata string-valued before passing it into file taggers. */
function normalizeTrackMetadata(track) {
  if (!track || typeof track !== 'object') return track
  const album = albumNameOf(track)
  if (album) return { ...track, album, album_name: album }
  // Never leak album objects or generic placeholders to downstream taggers.
  const normalized = { ...track }
  if (track.album && typeof track.album === 'object' || typeof track.album === 'string' && isPlaceholderAlbum(track.album)) normalized.album = null
  if (typeof track.album_name === 'string' && isPlaceholderAlbum(track.album_name)) normalized.album_name = null
  return normalized
}

function trackOf(track, provider, addon = null) {
  const artists=Array.isArray(track.artists)?track.artists.map(a=>typeof a==='string'?a:a.name).filter(Boolean):[String(track.artists || track.artist || '')].filter(Boolean)
  return {provider,id:String(track.id),title:String(track.name || track.title || '').slice(0,500),artist:artists.join(', '),artists,artistIds:track.artist_id?[String(track.artist_id)]:[],album:albumNameOf(track),albumId:albumIdOf(track),track_num:Number(track.track_number || track.trackNumber)||null,disc_num:Number(track.disc_number || track.discNumber)||null,year:Number(String(track.release_date || '').slice(0,4))||null,isrc:track.isrc || null,genre:track.genre || null,duration:(Number(track.duration_ms ?? track.durationMs)||0)/1000 || null,thumbnail:track.cover_url || track.coverUrl || (typeof track.images==='string'?track.images:null),quality:track.audio_quality || null,atmos_available:hasAtmosMetadata(track)?1:0,atmos_requestable:/^amazon(?:-(?:new|web))?$/i.test(addon?.name || '') && (addon?.manifest?.qualityOptions || []).some(q => q.id === 'ac4')?1:0,spotify_id:track.spotify_id || track.spotifyId || null,deezer_id:track.deezer_id || track.deezerId || null,qobuz_id:track.qobuz_id || track.qobuzId || null,tidal_id:track.tidal_id || track.tidalId || null,kind:'song'}
}

// Move legacy on-disk state without overwriting any Mornye data already present.
// If a file collides, keep it in the legacy directory for manual recovery.
function migrateLegacyRoot(legacyRoot, currentRoot) {
  if (legacyRoot === currentRoot || !fs.existsSync(legacyRoot)) return currentRoot
  fs.mkdirSync(currentRoot, { recursive: true })
  const moveMissing = (source, target) => {
    for (const name of fs.readdirSync(source)) {
      const from = path.join(source, name), to = path.join(target, name)
      if (!fs.existsSync(to)) {
        try { fs.renameSync(from, to) } catch {}
      } else {
        try {
          if (fs.statSync(from).isDirectory() && fs.statSync(to).isDirectory()) moveMissing(from, to)
        } catch {}
      }
    }
    try { if (fs.readdirSync(source).length === 0) fs.rmdirSync(source) } catch {}
  }
  try { moveMissing(legacyRoot, currentRoot) } catch (error) {
    console.warn(`[Mornye] Could not fully migrate legacy state: ${error.message}`)
  }
  return currentRoot
}

function migrateLegacyTables(db) {
  const tables = [
    ['spotiflac_repositories', 'mornye_repositories'],
    ['spotiflac_packages', 'mornye_packages'],
    ['spotiflac_tracks', 'mornye_tracks'],
  ]
  const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  for (const [legacy, current] of tables) {
    const hasLegacy = exists(legacy), hasCurrent = exists(current)
    if (hasLegacy && !hasCurrent) {
      db.exec(`ALTER TABLE ${legacy} RENAME TO ${current}`)
    } else if (hasLegacy && hasCurrent) {
      // Both names can exist after an interrupted upgrade; merge rows before
      // retiring the legacy table. Both schemas have identical columns.
      db.exec(`INSERT OR IGNORE INTO ${current} SELECT * FROM ${legacy}; DROP TABLE ${legacy}`)
    }
  }
}

class PackageService {
  constructor(db, {root, fetchImpl = fetch, tools}={}) {
    const dataDir = require('../ipc/db').getStorageDir() || process.env.LOKAL_DATA_DIR || path.join(process.cwd(),'data')
    const legacyRoot = path.join(dataDir, 'spotiflac')
    const mornyeRoot = path.join(dataDir, 'mornye')
    this.db=db
    this.root = root || migrateLegacyRoot(legacyRoot, mornyeRoot)
    this.fetch=fetchImpl;this.toolProvider=tools
    this.storage=new AddonStorage(this.root);this.runtimes=new Map();this.networks=new Map();this.sessions=new Map();this.operations=new Map();this.locks=new Map();this.forms=new Map()
    migrateLegacyTables(db)
    db.exec('CREATE TABLE IF NOT EXISTS mornye_repositories (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT, refreshed_at INTEGER, index_json TEXT, error TEXT); CREATE TABLE IF NOT EXISTS mornye_packages (key TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL, repository_id TEXT, digest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, installed_at INTEGER NOT NULL, methods_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mornye_tracks (provider TEXT NOT NULL, id TEXT NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY(provider,id));')
    const defaultId=hash(REGISTRY).slice(0,16)
    db.prepare('INSERT OR IGNORE INTO mornye_repositories (id,url,name) VALUES (?,?,?)').run(defaultId,REGISTRY,'Mornye official')
    db.prepare('UPDATE mornye_repositories SET name=? WHERE id=? AND name=?').run('Mornye official',defaultId,'SpotiFLAC official')
    const newRegistryId=hash(AMAZON_NEW_REGISTRY).slice(0,16)
    db.prepare('INSERT OR IGNORE INTO mornye_repositories (id,url,name) VALUES (?,?,?)').run(newRegistryId,AMAZON_NEW_REGISTRY,'Amazon (New) updates')
  }
  tools() {
    if(this.toolProvider)return this.toolProvider()
    if(process.versions.electron){const t=require('../ipc/tools');return {ffmpeg:t.findFfmpeg(),ffprobe:t.findFfprobe()}}
    const settings=Object.fromEntries(this.db.prepare("SELECT key,value FROM settings WHERE key IN ('ffmpeg_path','ffprobe_path')").all().map(r=>[r.key,r.value]))
    return {ffmpeg:settings.ffmpeg_path || 'ffmpeg',ffprobe:settings.ffprobe_path || 'ffprobe'}
  }
  find(key) {const row=this.db.prepare('SELECT * FROM mornye_packages WHERE key=?').get(key);return row?{...row,manifest:JSON.parse(row.manifest_json),methods:JSON.parse(row.methods_json)}:null}
  /** Included in Electron's packaged files; never requires a third-party
   * registry or changes the existing Amazon user's credentials/settings.
   * Installed packages newer than the bundled copy are preserved.
   */
  async ensureBundledAmazonNew() {
    const existing = this.find(keyOf('amazon-new'))
    if (existing && compareVersions(existing.manifest.version, '2.3.16') >= 0) return existing
    const bytes = await fsp.readFile(path.join(__dirname, 'bundled', 'amazon-new.sflx'))
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex')
    if (checksum !== '967bc8cf940cf39029ef7e33f55bf37c5f686028332570ef484579ebc75c5543') {
      throw new Error('Bundled Amazon (New) archive checksum mismatch')
    }
    return this.install({ buffer: bytes })
  }

  settings(addon) {
    // Settings saved by another build can be unreadable (the OS credential vault
    // key changed): the addon then shows its defaults rather than failing to list.
    let values={};try{values=this.storage.read(addon.key,'settings')}catch(error){console.warn(`[Mornye] Could not read settings of ${addon.name}: ${error.message}`)}
    const defaults={}
    for(const field of addon.manifest.settings || [])if(field.default!==undefined)defaults[field.key]=field.default
    const qualitySettings={}
    for(const quality of addon.manifest.qualityOptions || [])qualitySettings[quality.id]=Object.fromEntries((quality.settings || []).filter(f=>f.default!==undefined).map(f=>[f.key,f.default]))
    return {...defaults,qualitySettings,...values}
  }
  publicView(addon) {
    const values=this.settings(addon),schema=(addon.manifest.settings || []).map(field=>({...field,type:field.type==='boolean'?'toggle':field.type,help:field.description,options:field.options?.map(o=>typeof o==='object'?o:{value:o,label:o})}))
    const secretKeys=new Set(schema.filter(f=>f.secret).map(f=>f.key))
    const qualitySettings={}
    for(const quality of addon.manifest.qualityOptions || [])qualitySettings[quality.id]=Object.fromEntries((quality.settings || []).filter(f=>!f.secret).map(f=>[f.key,values.qualitySettings?.[quality.id]?.[f.key] ?? f.default]))
    const resources=['stream',...(addon.methods.includes('customSearch')||addon.methods.includes('searchTracks')?['search']:[]),...['album','artist','playlist'].filter(r=>addon.methods.includes(`get${r[0].toUpperCase()+r.slice(1)}`))]
    let icon=null
    if(addon.manifest.icon){try{const file=safePath(path.join(this.root,'packages',addon.key),addon.manifest.icon);const data=fs.readFileSync(file);if(data.length<256*1024&&/\.(png|jpg|jpeg|webp)$/i.test(file))icon=`data:image/${/\.png$/i.test(file)?'png':/\.webp$/i.test(file)?'webp':'jpeg'};base64,${data.toString('base64')}`}catch{}}
    return {key:addon.key,provider:`a-${addon.key}`,id:addon.name,name:addon.manifest.displayName,version:addon.manifest.version,description:addon.manifest.description || '',icon:icon||require('../online/addonBrand').addonIcon({name:addon.manifest.displayName,id:addon.name}),resources,enabled:!!addon.enabled,installedAt:addon.installed_at,kind:'mornye',host:'Mornye package',repositoryId:addon.repository_id,settingsSchema:schema,settings:{...Object.fromEntries(Object.entries(values).filter(([k])=>!secretKeys.has(k)&&k!=='qualitySettings')),qualitySettings},configuredSecrets:[...secretKeys].filter(k=>values[k]),qualityOptions:addon.manifest.qualityOptions || [],signedSession:!!addon.manifest.signedSession,actions:addon.manifest.globalActions || [],searchFilters:addon.manifest.searchBehavior?.filters || [],compatibilityVersion:COMPAT_VERSION,access:this.access(addon,values),linksOnly:!addon.manifest.type.includes('download_provider')}
  }
  /**
   * Whether an addon still needs setting up before it can stream or download:
   * an unverified signed session, an account login it hasn't done, or a
   * required setting left empty. Read from what's saved (no runtime starts).
   */
  access(addon,values=this.settings(addon)) {
    const missing=(addon.manifest.settings || []).filter(field=>field.required&&field.type!=='button'&&(values[field.key]===undefined||values[field.key]==='')).map(field=>field.label || field.key)
    if(addon.manifest.signedSession){
      const config=addon.manifest.signedSession,live=this.sessions.get(hash(JSON.stringify(config)))
      let verified=false;try{verified=!!(live || new SignedSession(config,this.storage,null,addon.key)).status().authenticated}catch{}
      return {kind:'verification',ready:verified&&!missing.length,verified,missing}
    }
    const login=(addon.manifest.globalActions || []).some(item=>/log\s*in|sign\s*in|connect|auth|account/i.test(`${item.action} ${item.label || ''}`))
    if(login){
      let auth=this.networks.get(addon.key)?.auth;if(!auth){try{auth=this.storage.read(addon.key,'connection').auth}catch{}}
      const tokens=!!(auth?.access_token || auth?.refresh_token || auth?.code)
      let account=false;try{account=Object.keys(this.storage.read(addon.key,'credentials')).length>0}catch{}
      return {kind:'login',ready:(tokens||account)&&!missing.length,verified:tokens||account,missing}
    }
    return {kind:missing.length?'settings':'none',ready:!missing.length,verified:true,missing}
  }
  list() {
    // One broken package must not hide the others (or the HTTP addons).
    return this.db.prepare('SELECT key FROM mornye_packages ORDER BY installed_at').all().flatMap(({key})=>{
      try{return [this.publicView(this.find(key))]}
      catch(error){console.warn(`[Mornye] Skipped unreadable package ${key}: ${error.message}`);return []}
    })
  }
  repos() {return this.db.prepare('SELECT id,url,name,refreshed_at,error FROM mornye_repositories ORDER BY rowid').all()}
  async refreshDue(maxAgeMs=6*60*60*1000) {
    const repos=this.repos().filter(repo=>!repo.refreshed_at || Date.now()-repo.refreshed_at>maxAgeMs)
    await Promise.all(repos.map(repo=>this.refreshRepo(repo.id).catch(()=>null)))
    return this.repos()
  }
  async addRepo(raw) {
    const url=new URL(String(raw).trim())
    if(url.protocol!=='https:'||url.username||url.password)throw new Error('Repository URLs must use HTTPS')
    if(!/\.json$/i.test(url.pathname))url.pathname=url.pathname.replace(/\/$/,'')+'/registry.json'
    url.hash='';const id=hash(url.href).slice(0,16)
    this.db.prepare('INSERT OR IGNORE INTO mornye_repositories (id,url,name) VALUES (?,?,?)').run(id,url.href,url.hostname)
    await this.refreshRepo(id);return this.repos().find(r=>r.id===id)
  }
  async document(raw, max=2*1024*1024) {
    // Registry/package redirects use the same domain-restricted, DNS-checked
    // transport as runtime calls. A repository cannot redirect to local files.
    const url=new URL(raw),network=new ExtensionNetwork({network:[url.hostname],storage:false,file:false})
    const {response,status}=await network.request(raw,{signal:AbortSignal.timeout(30000)})
    try {
      if(status!==200)throw new Error(`Repository returned HTTP ${status}`)
      const chunks=[];let bytes=0
      for await(const chunk of response){bytes+=chunk.length;if(bytes>max)throw new Error('Repository response is too large');chunks.push(chunk)}
      return Buffer.concat(chunks)
    }finally{response.destroy()}
  }
  async refreshRepo(id) {
    const repo=this.db.prepare('SELECT * FROM mornye_repositories WHERE id=?').get(id)
    if(!repo)throw new Error('Repository not found')
    try{
      const index=JSON.parse((await this.document(repo.url)).toString())
      if(index.version!==1||!Array.isArray(index.extensions)||index.extensions.length>2000)throw new Error('Invalid Mornye registry')
      const valid=e=>{try{return /^[a-z0-9][a-z0-9_-]{0,99}$/.test(e.id || e.name || '')&&typeof e.version==='string'&&/^[a-f0-9]{64}$/i.test(e.sha256 || '')&&new URL(e.download_url).protocol==='https:'}catch{return false}}
      // Download sources must all be well formed; metadata ("integration")
      // entries are only offered as playlist-link readers, and skipped when
      // incomplete (installing one still checks it reads links).
      const entries=index.extensions.filter(e=>e.category==='download'||(e.category==='integration'&&valid(e))).map(e=>{
        if(!valid(e))throw new Error('Invalid registry package entry')
        return {...e,id:e.id || e.name}
      })
      if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new Error('Duplicate registry package IDs')
      this.db.prepare('UPDATE mornye_repositories SET index_json=?,refreshed_at=?,error=NULL WHERE id=?').run(JSON.stringify(entries),Date.now(),id)
      // A registry that names itself gets that name (the official one keeps its own).
      const title=typeof index.name==='string'?index.name.replace(/[\u0000-\u001f]/g,'').trim().slice(0,80):''
      if(title&&repo.url!==REGISTRY)this.db.prepare('UPDATE mornye_repositories SET name=? WHERE id=?').run(title,id)
    }catch(error){this.db.prepare('UPDATE mornye_repositories SET error=? WHERE id=?').run(error.message,id);throw error}
    return this.catalogue(id)
  }
  catalogue(id) {
    const repos=id?[this.db.prepare('SELECT * FROM mornye_repositories WHERE id=?').get(id)].filter(Boolean):this.db.prepare('SELECT * FROM mornye_repositories').all()
    return repos.flatMap(repo=>JSON.parse(repo.index_json || '[]').map(entry=>{const installed=this.find(keyOf(entry.id));return {...entry,repositoryId:repo.id,installed:!!installed,installedVersion:installed?.manifest.version,updateAvailable:!!installed&&compareVersions(entry.version,installed.manifest.version)>0,compatible:compareVersions(entry.min_app_version,COMPAT_VERSION)<=0}}))
  }
  removeRepo(id) {this.db.prepare('DELETE FROM mornye_repositories WHERE id=?').run(id);return {ok:true}}
  async locked(key, action) {
    const previous=this.locks.get(key) || Promise.resolve()
    const promise=previous.catch(()=>{}).then(action);this.locks.set(key,promise)
    try{return await promise}finally{if(this.locks.get(key)===promise)this.locks.delete(key)}
  }
  async install({repositoryId,id,url,buffer}={}) {
    let entry
    if(repositoryId){entry=this.catalogue(repositoryId).find(e=>e.id===id);if(!entry)throw new Error('Package not found in this repository');url=entry.download_url}
    if(!buffer){if(!url||!/[.]sflx$|[.]spotiflac-ext$/i.test(new URL(url).pathname))throw new Error('Choose a .sflx or .spotiflac-ext package');buffer=await this.document(url,32*1024*1024)}
    const digest=crypto.createHash('sha256').update(buffer).digest('hex')
    if(entry && digest!==entry.sha256.toLowerCase())throw new Error('Package SHA-256 does not match its repository')
    const {zip,manifest,code}=readArchive(buffer)
    if(entry&&(manifest.name!==entry.id||manifest.version!==entry.version))throw new Error('Package identity/version does not match its registry entry')
    const key=keyOf(manifest.name)
    return this.locked(key,async()=>{
      const existing=this.find(key)
      if(existing&&existing.name!==manifest.name)throw new Error('Addon identity collision')
      if(existing&&compareVersions(manifest.version,existing.manifest.version)<0)throw new Error('Cannot downgrade an installed addon')
      const staged=path.join(this.root,'staging',crypto.randomUUID()),target=path.join(this.root,'packages',key),backup=target+'.previous'
      await fsp.mkdir(staged,{recursive:true})
      let runtime
      try{
        for(const entry of zip.getEntries()){if(entry.isDirectory)continue;const file=safePath(staged,entry.entryName);await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,entry.getData(),{mode:0o600})}
        const candidate={key,name:manifest.name,manifest,enabled:1}
        runtime=this.createRuntime(candidate,code,{root:path.join(staged,'validation-data')})
        await runtime.ready
        if(manifest.type.includes('download_provider')&&!runtime.methods.includes('download'))throw new Error('Download provider has no registered download() method')
        if((manifest.urlHandler?.enabled||!manifest.type.includes('download_provider'))&&!runtime.methods.includes('handleUrl'))throw new Error('Playlist-link addon has no registered handleUrl() method')
        const methods=runtime.methods
        runtime.close();runtime=null
        await fsp.rm(path.join(staged,'validation-data'),{recursive:true,force:true})
        this.retire(key)
        await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.rm(backup,{recursive:true,force:true})
        if(fs.existsSync(target))await fsp.rename(target,backup)
        try{
          await fsp.rename(staged,target)
          this.db.prepare('INSERT INTO mornye_packages (key,name,manifest_json,repository_id,digest,enabled,installed_at,methods_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET manifest_json=excluded.manifest_json,repository_id=excluded.repository_id,digest=excluded.digest,methods_json=excluded.methods_json').run(key,manifest.name,JSON.stringify(manifest),repositoryId || null,digest,existing?.enabled ?? 1,existing?.installed_at || Date.now(),JSON.stringify(methods))
        }catch(error){await fsp.rm(target,{recursive:true,force:true});if(fs.existsSync(backup))await fsp.rename(backup,target);throw error}
        await fsp.rm(backup,{recursive:true,force:true})
        return this.publicView(this.find(key))
      }finally{runtime?.close();await fsp.rm(staged,{recursive:true,force:true})}
    })
  }
  createRuntime(addon,code,{root,grants=[],onProgress,onTransfer,onByteProgress,signal,heapMb}={}) {
    let network=this.networks.get(addon.key)
    if(!network){network=new ExtensionNetwork(addon.manifest.permissions);this.restoreConnection(addon.key,network);this.networks.set(addon.key,network)}
    let session
    if(addon.manifest.signedSession){const scope=hash(JSON.stringify(addon.manifest.signedSession));session=this.sessions.get(scope);if(!session){session=new SignedSession(addon.manifest.signedSession,this.storage,network,addon.key);this.sessions.set(scope,session)}}
    const host=new ExtensionHost({addon,storage:this.storage,network,session,root:root || path.join(this.root,'data',addon.key,'files'),grants,tools:this.tools(),db:this.db,onProgress,onTransfer,onByteProgress,signal})
    const runtime=new ExtensionRuntime(code,{permissions:addon.manifest.permissions,signedSession:addon.manifest.signedSession,settings:this.settings(addon),rawFfmpeg:addon.manifest.capabilities?.rawFfmpeg,heapMb},host)
    runtime.ready.catch(()=>{})
    return runtime
  }
  async runtime(key) {
    const addon=this.find(key)
    if(!addon||!addon.enabled)throw new Error('This addon is not installed or is turned off')
    let runtime=this.runtimes.get(key)
    if(!runtime||runtime.closed){
      const code=fs.readFileSync(path.join(this.root,'packages',key,'index.js'),'utf8')
      runtime=this.createRuntime(addon,code);this.runtimes.set(key,runtime)
      runtime.initialized = runtime.ready.then(() => runtime.invoke('initialize',[this.settings(addon)]))
    }
    await runtime.initialized
    return runtime
  }
  // A login (tokens, the cookies a verification page set) outlives restarts:
  // it's kept sealed with the addon's other credentials.
  restoreConnection(key,network) {
    let saved={};try{saved=this.storage.read(key,'connection')}catch{}
    if(saved.auth&&typeof saved.auth==='object')network.auth={...saved.auth}
    if(saved.cookies){try{network.cookies=CookieJar.deserializeSync(saved.cookies)}catch{}}
    network.persist=()=>this.saveConnection(key,network)
  }
  saveConnection(key,network,{now=false}={}) {
    clearTimeout(network.persistTimer);network.persistTimer=null
    const write=()=>{network.persistTimer=null;try{if(!this.find(key))return;const {pending,...auth}=network.auth || {};this.storage.write(key,'connection',{auth,cookies:network.cookies.serializeSync()})}catch{}}
    if(now)return write()
    network.persistTimer=setTimeout(write,250);network.persistTimer.unref?.()
  }
  // Disconnect: the login, its cookies and what the addon stored as its
  // account credentials. The generation makes a token exchange still in
  // flight drop its result instead of writing it back afterwards.
  forgetConnection(key) {const network=this.networks.get(key);if(network){network.generation=(network.generation || 0)+1;clearTimeout(network.persistTimer);network.persistTimer=null;for(const field of Object.keys(network.auth || {}))delete network.auth[field];network.cookies=new CookieJar()}try{this.storage.write(key,'connection',{})}catch{}try{this.storage.write(key,'credentials',{})}catch{}}
  /** Drops the saved-login key and files (see AddonStorage.reset); addons then need their logins again. */
  resetCredentials() {
    for(const key of [...this.runtimes.keys(),...this.networks.keys()])this.retire(key)
    this.sessions.clear();this.storage.reset()
    return {ok:true}
  }
  retire(key) {const network=this.networks.get(key);if(network?.persistTimer)this.saveConnection(key,network,{now:true});this.runtimes.get(key)?.close();this.runtimes.delete(key);for(const op of this.operations.values())if(op.key===key)op.controller.abort();this.networks.delete(key);if(process.versions.electron)require('./authWindow').closeAuthWindow(key)}
  shutdown() { for(const [key,network] of this.networks)if(network.persistTimer)this.saveConnection(key,network,{now:true}); for(const key of [...this.runtimes.keys()]) this.retire(key); for(const op of this.operations.values()) op.controller.abort(); this.operations.clear() }
  async remove(key) {
    if(!/^[a-f0-9]{10}$/.test(key))throw new Error('Invalid addon key')
    return this.locked(key,async()=>{this.retire(key);this.db.prepare('DELETE FROM mornye_packages WHERE key=?').run(key);await fsp.rm(path.join(this.root,'packages',key),{recursive:true,force:true});await fsp.rm(path.join(this.root,'data',key),{recursive:true,force:true});return {ok:true}})
  }
  setEnabled(key,enabled){this.retire(key);this.db.prepare('UPDATE mornye_packages SET enabled=? WHERE key=?').run(enabled?1:0,key);return {ok:true}}
  setSettings(key,values) {
    const addon=this.find(key);if(!addon)throw new Error('Addon not found')
    const current=this.storage.read(key,'settings')
    const fields=addon.manifest.settings || []
    const assign=(schema,input,target)=>{for(const field of schema){if(field.type==='button'||!Object.hasOwn(input || {},field.key))continue;const value=input[field.key];if(field.secret&&value==='')continue;if(field.type==='boolean'&&typeof value!=='boolean'||field.type==='number'&&!Number.isFinite(Number(value))||field.type==='select'&&!(field.options || []).some(o=>(typeof o==='object'?o.value:o)===value))throw new Error(`Invalid setting: ${field.key}`);target[field.key]=field.type==='number'?Number(value):field.type==='boolean'?value:String(value??'').slice(0,8000)}}
    assign(fields,values,current)
    if(values.qualitySettings){current.qualitySettings ||= {};for(const quality of addon.manifest.qualityOptions || []){current.qualitySettings[quality.id] ||= {};assign(quality.settings || [],values.qualitySettings[quality.id],current.qualitySettings[quality.id])}}
    if(values.downloadQuality && (addon.manifest.qualityOptions || []).some(q=>q.id===values.downloadQuality))current.downloadQuality=values.downloadQuality
    this.storage.write(key,'settings',current);this.retire(key);return {ok:true}
  }
  remember(key,tracks) {
    const stmt=this.db.prepare('INSERT OR REPLACE INTO mornye_tracks (provider,id,metadata_json) VALUES (?,?,?)')
    for(const track of tracks)if(track?.id!=null)stmt.run(`a-${key}`,String(track.id),JSON.stringify(track))
  }
  async search(key,query,{limit=20}={}) {
    const runtime=await this.runtime(key),addon=this.find(key)
    let results
    if(addon.manifest.urlHandler?.enabled && /^(https?:|[a-z]+:)/i.test(query))results=await runtime.invoke('handleUrl',[query])
    else results=await runtime.invoke(runtime.methods.includes('searchTracks')?'searchTracks':'customSearch',runtime.methods.includes('searchTracks')?[query,limit]:[query,{limit,filter:addon.manifest.searchBehavior?.filters?.find(f=>/^(songs?|tracks?)$/.test(f.id))?.id || 'tracks'}])
    const tracks=Array.isArray(results)?results:results?.tracks || results?.album?.tracks || results?.artist?.top_tracks || (results?.track?[results.track]:[])
    let songs=tracks.filter(t=>t?.id!=null&&(t.name||t.title)&&(!t.item_type||t.item_type==='track'))
    // Amazon can return the same ASIN in multiple search widgets. Collapse
    // exact identities, not different releases with matching titles. Preserve
    // an explicit Atmos mode if it appears only in a later duplicate row.
    if (/^amazon(?:-(?:new|web))?$/i.test(addon.name)) {
      const unique=new Map()
      for (const song of songs) {
        const id=String(song.id)
        const existing=unique.get(id)
        if (!existing) unique.set(id,song)
        else if (hasAtmosMetadata(song) && !hasAtmosMetadata(existing)) unique.set(id,{...existing,...song})
      }
      songs=[...unique.values()]
    }
    this.remember(key,songs);return songs.slice(0,limit).map(t=>trackOf(t,`a-${key}`,addon))
  }
  async browse(key,query,filter) {
    const runtime=await this.runtime(key),addon=this.find(key)
    const allowed=addon.manifest.searchBehavior?.filters || []
    if(!allowed.some(f=>f.id===filter))throw new Error('Unknown addon search filter')
    const result=await runtime.invoke('customSearch',[String(query).slice(0,500),{filter,limit:30}])
    return (Array.isArray(result)?result:result?.tracks || []).filter(item=>item?.id && ['album','artist','playlist'].includes(item.item_type || item.itemType)).slice(0,100).map(item=>({id:String(item.id),provider:`a-${key}`,type:item.item_type || item.itemType,title:item.name,artist:item.artists,thumbnail:item.cover_url || item.images,year:item.release_date,totalTracks:item.total_tracks}))
  }
  async album(key,id,playlist=false) {
    const runtime=await this.runtime(key),data=await runtime.invoke(playlist?'getPlaylist':'getAlbum',[id])
    if(!data)throw new Error('Addon returned no album')
    this.remember(key,data.tracks || [])
    return {provider:`a-${key}`,id:String(data.id || id),title:data.name,artist:data.artists || data.owner || '',artistId:data.artist_id,artwork_url:data.cover_url || data.images,year:Number(String(data.release_date || '').slice(0,4))||null,release_type:data.album_type || 'album',tracks:(data.tracks || []).map(t=>trackOf({...t,album_id:t.album_id || id,album_name:t.album_name || data.name,cover_url:t.cover_url || data.cover_url},`a-${key}`,this.find(key)))}
  }
  async artist(key,id) {
    const data=await (await this.runtime(key)).invoke('getArtist',[id]);if(!data)throw new Error('Addon returned no artist')
    this.remember(key,data.top_tracks || data.tracks || [])
    return {provider:`a-${key}`,id:String(data.id || id),name:data.name,image:data.image_url,albums:(data.albums || []).map(a=>({provider:`a-${key}`,albumId:a.id,title:a.name,artist:a.artists || data.name,year:Number(String(a.release_date || '').slice(0,4))||null,release_type:a.album_type || 'album',artwork_url:a.cover_url,track_count:a.total_tracks})),tracks:(data.top_tracks || data.tracks || []).map(t=>trackOf(t,`a-${key}`,this.find(key)))}
  }
  async invokeAction(key,action,input,token) {
    const runtime=await this.runtime(key),addon=this.find(key)
    const form=token&&this.forms.get(token)
    const declared=[...(addon.manifest.settings || []).filter(s=>s.type==='button').map(s=>s.action),...(addon.manifest.globalActions || []).map(a=>a.action)]
    if(form){if(form.key!==key||form.action!==action||form.expires<Date.now()||form.steps>=8)throw new Error('Invalid or expired addon form');this.forms.delete(token)}
    else if(!declared.includes(action) && !(action === 'completeGrant' && addon.manifest.signedSession))throw new Error('This action is not declared by the addon')
    const result=await runtime.invoke(action,input?[input]:[],{timeoutMs:Math.min(120000,Math.max(1000,Number(addon.manifest.capabilities?.actionTimeoutSeconds || 30)*1000))})
    const payload=result?.result || result || {},schema=payload.action_form || payload.byoa_form
    if(schema){if(schema.version!==1||!runtime.methods.includes(schema.submit_action)||!Array.isArray(schema.fields)||schema.fields.length>12)throw new Error('Invalid addon account form');const next=crypto.randomUUID();this.forms.set(next,{key,action:schema.submit_action,steps:(form?.steps || 0)+1,expires:Date.now()+300000});payload.formToken=next}
    return payload
  }
  async authStatus(key) {const runtime=await this.runtime(key),access=this.access(this.find(key)),session=runtime.host.session?.status();return {...session,authenticated:session?session.authenticated:access.verified,access,open_auth_url:runtime.host.session?.pending?.url || runtime.host.auth.pending?.url || ''}}
  async authCallback(key,raw) {
    const runtime=await this.runtime(key)
    if(runtime.host.session?.pending)return runtime.host.session.callback(raw,runtime.host.signal)
    const pending=runtime.host.auth.pending,url=new URL(raw)
    if(!pending||Date.now()-pending.createdAt>180000||url.searchParams.get('state')!==pending.state)throw new Error('Invalid or expired OAuth callback')
    if(pending.callback){const expected=new URL(pending.callback);if(url.protocol!==expected.protocol||url.host!==expected.host||url.pathname!==expected.pathname)throw new Error('Unexpected OAuth callback URL')}
    runtime.host.auth.code=url.searchParams.get('code') || '';runtime.host.auth.pending=null;runtime.host.network.persist?.();return {success:true}
  }
  async download(key,id,{signal,onProgress,onLive,quality,purpose='download',allowAtmos=false}={}) {
    const addon=this.find(key);if(!addon||!addon.enabled)throw new Error('Addon is not available')
    const controller=new AbortController(),opId=crypto.randomUUID(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
    let monitoringTransfer=false,transferStalled=false,inactivityTimer=null,lastPercent=-1,lastPart=null,lastWritten=0
    const recordActivity=()=>{
      if(!monitoringTransfer)return
      clearTimeout(inactivityTimer)
      inactivityTimer=setTimeout(()=>{transferStalled=true;controller.abort(new Error('Provider stopped delivering audio for 90 seconds'))},90000)
      inactivityTimer.unref?.()
    }
    this.operations.set(opId,{key,controller})
    const staged=path.join(this.root,'work',opId);await fsp.mkdir(staged,{recursive:true})
    // Downloads get more room than browsing: a worker that ran out mid-song
    // ("reaching memory limit") failed the whole stream.
    // Playback can start on the file as it arrives (media.js decides whether
    // it's playable as is): only when no post-processing hook will rewrite it.
    const hooks=addon.manifest.postProcessing?.enabled&&(addon.manifest.postProcessing.hooks || []).some(hook=>hook.defaultEnabled)
    // The same bytes and authorization path are used for saving and playing.
    // Only Qobuz exposes growing media to the player; segmented, encrypted
    // and converted providers finish downloading before playback starts.
    const liveProvider=isLiveProvider(addon)
    const startedAt=Date.now()
    const phase=stage=>console.info(`[Mornye] ${addon.name} ${purpose} stage=${stage} elapsedMs=${Date.now()-startedAt}`)
    let sawBytes=false
    const onTransfer=hooks?undefined:info=>{
      const written=Number(info?.written)||0
      if(info?.part!==lastPart||written>lastWritten){lastPart=info?.part;lastWritten=written;recordActivity()}
      if(!sawBytes&&written>0){sawBytes=true;phase('first_byte')}
      if(liveProvider&&purpose==='playback')onLive?.(info)
    }
    let lastByteActivity=0
    const onByteProgress=bytes=>{
      if(!Number.isFinite(bytes)||bytes<=0)return
      if(!sawBytes){sawBytes=true;phase('first_byte')}
      // Byte delivery is authoritative even for segmented transfers with no
      // finished segment yet, or when optional post-processing is enabled.
      // Throttle timer resets; do not throttle bytes or player callbacks.
      const now=Date.now()
      if(now-lastByteActivity>=250){lastByteActivity=now;recordActivity()}
    }
    const relayProgress=update=>{
      const percent=Number(update?.percent)
      if(Number.isFinite(percent)){
        if(percent>lastPercent)recordActivity()
        lastPercent=percent // retries can restart at zero
      }
      onProgress?.(update)
    }
    const runtime=this.createRuntime(addon,fs.readFileSync(path.join(this.root,'packages',key,'index.js'),'utf8'),{grants:[staged],onProgress:relayProgress,onTransfer,onByteProgress,signal:combined,heapMb:512})
    try{
      phase('initialize')
      await runtime.ready;await runtime.invoke('initialize',[this.settings(addon)],{signal:combined})
      phase('availability_prepare')
      const rememberedRow=this.db.prepare('SELECT metadata_json FROM mornye_tracks WHERE provider=? AND id=?').get(`a-${key}`,String(id))
      let track=JSON.parse(rememberedRow?.metadata_json || 'null')
      if(!track&&runtime.methods.includes('getTrack'))track=await runtime.invoke('getTrack',[String(id)],{signal:combined})
      track ||= {id:String(id),name:'',artists:'',duration_ms:0,provider_id:addon.name}
      const providerName=addon.name.replace(/-web$/,'')
      const isAmazonProvider = /^amazon(?:-new)?$/i.test(providerName)
      // A source track may not have an Amazon album ID until checkAvailability()
      // resolves it to an Amazon ASIN. Reuse this fallback before and after matching.
      const resolveAmazonAlbum = async () => {
        if(!isAmazonProvider||albumNameOf(track)||!runtime.methods.includes('getAlbum')) return
        const albumId=albumIdOf(track)
        if(!albumId) return
        try {
          const album=await runtime.invoke('getAlbum',[albumId],{timeoutMs:60000,signal:combined})
          const name=albumNameOf({album_name:album?.name||album?.title||album?.album_name||album?.albumName})
          if(!name) return
          const albumFields={
            album:name,album_name:name,
            album_artist:(typeof track.album_artist === 'string' && !track.album_artist.trim() ? null : track.album_artist)||album.album_artist||album.artist||album.artists,
            cover_url:track.cover_url||album.cover_url||album.cover_art,
            release_date:track.release_date||album.release_date||album.year,
            total_tracks:track.total_tracks||album.total_tracks||album.track_count,
            total_discs:track.total_discs||album.total_discs,
          }
          track={...track,...Object.fromEntries(Object.entries(albumFields).filter(([,value])=>value!==undefined&&value!==null&&value!==''))}
        } catch(error) {
          // Keep downloads usable when metadata lookup fails, but never swallow cancellation.
          if(combined.aborted || runtime.closed) throw error
          console.warn('[Mornye] Amazon album lookup failed:', error.message || error)
        }
      }
      const checkAvailability=()=>{
        const options={track,duration_ms:track.duration_ms || 0}
        const directFields={qobuz:'qobuz_id',tidal:'tidal_id',deezer:'deezer_id',soundcloud:'spotify_id',amazon:'spotify_id','amazon-new':'spotify_id'}
        const directField=directFields[providerName]
        if(directField)options[directField]=String(track[directField] || (isAmazonProvider || providerName === 'soundcloud' ? track.id : id))
        return runtime.methods.includes('checkAvailability')
          ?runtime.invoke('checkAvailability',[track.isrc || '',track.name || '',track.artists || '',options],{timeoutMs:25000,signal:combined})
          :Promise.resolve({available:true,track_id:String(id)})
      }
      phase('availability')
      let available=await checkAvailability()
      // Retry one failed authoritative ticket after optional enrichment, for
      // every provider (including an exact Tidal ID). Play and Save follow
      // the same path, with the same bounded timeout and no special skips.
      if(shouldRetryEnrichment({available,hasEnrichment:runtime.methods.includes('enrichTrack')})){
        phase('cross_provider_enrichment')
        try{
          const enriched=await runtime.invoke('enrichTrack',[track],{timeoutMs:20000,signal:combined})
          if(enriched&&typeof enriched==='object'&&!Array.isArray(enriched)){
            const values=Object.fromEntries(Object.entries(enriched).filter(([,value])=>value!==undefined&&value!==null&&value!==''&&value!==0&&!(typeof value==='string'&&!value.trim())&&!(Array.isArray(value)&&value.length===0)))
            track={...track,...values}
          }
        }catch(error){
          // Enrichment is optional; do not turn a failed availability ticket
          // into an enrichment error unless the worker cannot continue.
          if(combined.aborted||runtime.closed)throw error
          console.warn('[Mornye] Optional enrichment failed; checking availability again')
        }
        phase('availability_retry')
        available=await checkAvailability()
      }
      if(!available?.available)throw new Error(available?.reason || 'The addon cannot download this track')
      // Optional album metadata must not precede provider authorization.
      await resolveAmazonAlbum()
      const matchedTrackId=available.track_id || available.trackId
      // Cross-provider matches often start with only Spotify metadata. Once Amazon
      // returns its ASIN, load Amazon's canonical track before the addon downloads.
      if(isAmazonProvider&&matchedTrackId&&!albumNameOf(track)&&runtime.methods.includes('getTrack')) {
        try {
          const amazonTrack=await runtime.invoke('getTrack',[String(matchedTrackId)],{timeoutMs:60000,signal:combined})
          if(amazonTrack&&typeof amazonTrack==='object'&&!Array.isArray(amazonTrack)) {
            const values=Object.fromEntries(Object.entries(amazonTrack).filter(([field,value])=>{
              if(value===undefined||value===null||value===''||value===0||(typeof value==='string'&&!value.trim())||(Array.isArray(value)&&value.length===0)) return false
              if((field==='album_name'||field==='album')&&typeof value==='string'&&isPlaceholderAlbum(value)) return false
              if(field==='album_artist'&&typeof value==='string'&&!value.trim()) return false
              return true
            }))
            track={...track,...values}
          }
        } catch(error) {
          if(combined.aborted || runtime.closed) throw error
          console.warn('[Mornye] Amazon track metadata lookup failed:', error.message || error)
        }
        await resolveAmazonAlbum()
      }
      const prepared={...(available.prepared_context || available.preparedContext || {}),host_track:track}
      // The Amazon extension prefers web_metadata over host_track, so keep both
      // in sync with the resolved Amazon metadata instead of the original track.
      if(isAmazonProvider) prepared.web_metadata=track
      const chosen=addonDownloadQuality(addon,this.settings(addon),{quality,allowAtmos,purpose})
      const downloadingAtmos=isAtmosQuality(chosen)
      phase('download_start')
      monitoringTransfer=true;recordActivity()
      let result
      try{
        result=await runtime.invoke('download',[available.track_id || available.trackId || String(id),chosen,path.join(staged,'audio.flac'),{preparedContext:prepared,resolutionTimeoutMs:60000}],{timeoutMs:24*3600000,signal:combined})
      }catch(error){
        if(transferStalled)throw new Error('The provider stopped delivering audio for 90 seconds. Retry the track.')
        throw error
      }finally{monitoringTransfer=false;clearTimeout(inactivityTimer)}
      phase('download_complete')
      if(!result?.success)throw Object.assign(new Error(result?.error_message || result?.error || 'Addon download failed'),{authUrl:result?.auth_url,errorType:result?.error_type})
      let file=safePath(runtime.host.root,result.file_path || result.filePath || result.path,runtime.host.grants)
      if(!fs.statSync(file).isFile()||!fs.statSync(file).size)throw new Error('Addon produced an empty file')
      const tools=this.tools(),decryption=result.decryption || (result.decryption_key?{strategy:'ffmpeg.mov_key',key:result.decryption_key}:null)
      if(decryption){
        if(decryption.strategy!=='ffmpeg.mov_key'||! /^[a-f0-9]{32}$/i.test(decryption.key || ''))throw new Error('Unsupported audio decryption descriptor')
        const ext=result.output_extension || decryption.output_extension || '.flac'
        if(!['.flac','.m4a','.mp4','.ogg','.opus'].includes(ext))throw new Error('Invalid decrypted output container')
        const target=path.join(staged,`decrypted${ext}`)
        onProgress?.({message:'Decrypting audio…'})
        await runTool(tools.ffmpeg,['-nostdin','-y','-decryption_key',decryption.key,'-i',file,'-map','0:a:0','-c:a','copy',target],combined)
        file=target
      }
      let info=await mediaInfo(file,tools,combined)
      // Spatial E-AC-3 is not a FLAC input. Add-on container flags must not
      // cause it to be transcoded before the JOC check; it gets a lossless
      // bitstream-copy remux after positive verification instead.
      if(!downloadingAtmos && (info.codec==='flac'&&!/\.flac$/i.test(file)||result.requires_container_conversion || result.requiresContainerConversion)){
        const target=path.join(staged,'remuxed.flac');onProgress?.({message:'Converting audio container…'})
        await runTool(tools.ffmpeg,['-nostdin','-y','-i',file,'-map','0:a:0','-c:a',info.codec==='flac'?'copy':'flac',target],combined);file=target;info=await mediaInfo(file,tools,combined)
      }
      for(const hook of !downloadingAtmos && addon.manifest.postProcessing?.enabled ? addon.manifest.postProcessing.hooks || [] : []){
        const formats=hook.supportedFormats || hook.formats
        if(!hook.defaultEnabled||formats?.length&&!formats.includes(path.extname(file).slice(1)))continue
        const processed=await runtime.invoke('postProcessV2',[{path:file},track,hook.id],{timeoutMs:120000,signal:combined})
        if(!processed?.success)throw new Error(processed?.error || 'Addon post-processing failed')
        if(processed.new_file_uri || processed.newFileUri)throw new Error('Addon post-processing cannot replace destination URIs')
        if(processed.new_file_path || processed.newFilePath)file=safePath(runtime.host.root,processed.new_file_path || processed.newFilePath,runtime.host.grants)
      }
      info=await mediaInfo(file,tools,combined)
      if(downloadingAtmos && String(chosen).toLowerCase()==='ac4') {
        // Amazon delivers AC-4 inside MP4. Validate the actual codec after
        // decryption; never decode, FLAC-convert or remux its presentation.
        // This verifies AC-4 encoding, not an Atmos object presentation.
        if(info.codec!=='ac4') throw new Error('Amazon did not return the requested AC-4 audio. No stereo track was substituted.')
        if(!/\.(?:mp4|m4a)$/i.test(file)) throw new Error('Amazon AC-4 must be delivered in an MP4 container')
        if(!String(info.format || '').split(',').some(fmt=>['mov','mp4','m4a','3gp','3g2','mj2'].includes(fmt.trim()))) throw new Error('Amazon AC-4 returned a non-MP4 audio container; nothing was saved')
      }
      if(downloadingAtmos && String(chosen).toLowerCase()!=='ac4') {
        // Verify E-AC-3 JOC; plain E-AC-3 does not imply Dolby Atmos.
        if(info.codec!=='eac3' || await probeAtmosFile(file,{codec:info.codec,ffprobe:tools.ffprobe})!==1) {
          throw new Error('The addon did not supply verified E-AC-3 JOC Dolby Atmos audio; nothing was saved')
        }
        const target=path.join(staged,'verified.atmos.m4a')
        await runTool(tools.ffmpeg,[
          '-nostdin','-y','-i',file,'-map','0:a:0','-c:a','copy',
          '-metadata','title='+String(track.name || track.title || '').slice(0,500),
          '-metadata','artist='+(Array.isArray(track.artists) ? track.artists.map(a => typeof a === 'string' ? a : a?.name || '').join(', ') : String(track.artists || track.artist || '')),
          '-metadata','album='+(albumNameOf(track) || ''),
          target,
        ],combined)
        file=target
        info=await mediaInfo(file,tools,combined)
        if(info.codec!=='eac3' || await probeAtmosFile(file,{codec:info.codec,ffprobe:tools.ffprobe})!==1) {
          throw new Error('Dolby Atmos JOC metadata was not preserved by the container remux')
        }
      }
      if(track.duration_ms && Math.abs(info.duration_ms-Number(track.duration_ms))>12000)throw new Error('Downloaded audio does not match the track duration')
      if(purpose==='playback'&&!['flac','mp3','aac','opus','vorbis','pcm_s16le','pcm_s24le','pcm_f32le'].includes(info.codec)){
        const lossless=['alac','flac','wavpack','ape'].includes(info.codec),target=path.join(staged,lossless?'playable.flac':'playable.m4a')
        await runTool(tools.ffmpeg,['-nostdin','-y','-i',file,'-map','0:a:0','-c:a',lossless?'flac':'aac',...(lossless?[]:['-b:a','256k']),target],combined);file=target;info=await mediaInfo(file,tools,combined)
      }
      // The player is told the type from the file name: an addon that writes
      // MP3 or AAC into "audio.flac" (a lower quality it fell back to) gets a
      // file the player can't open. Rewrap it in the container its audio needs.
      const containers={flac:['flac'],mp3:['mp3'],aac:['m4a','mp4','aac'],alac:['m4a','mp4'],opus:['ogg','opus','webm'],vorbis:['ogg','webm'],pcm_s16le:['wav'],pcm_s24le:['wav'],pcm_f32le:['wav']}
      if(purpose==='playback'&&containers[info.codec]&&!containers[info.codec].includes(path.extname(file).slice(1).toLowerCase())){
        const target=path.join(staged,`playable-copy.${containers[info.codec][0]}`)
        await runTool(tools.ffmpeg,['-nostdin','-y','-i',file,'-map','0:a:0','-c:a','copy',target],combined);file=target;info=await mediaInfo(file,tools,combined)
      }
      combined.throwIfAborted()
      return {file,staging:staged,metadata:normalizeTrackMetadata({...track,...result}),info,cleanup:()=>fsp.rm(staged,{recursive:true,force:true})}
    }catch(error){await fsp.rm(staged,{recursive:true,force:true});throw error}
    finally{monitoringTransfer=false;clearTimeout(inactivityTimer);runtime.close();this.operations.delete(opId)}
  }
}
const services=new WeakMap()
function service(db,options){let instance=services.get(db);if(!instance){instance=new PackageService(db,options);services.set(db,instance)}return instance}
function shutdown(db){services.get(db)?.shutdown()}
module.exports={PackageService,service,shutdown,REGISTRY,COMPAT_VERSION,FEATURES,compareVersions,validateManifest,readArchive,trackOf,keyOf}
