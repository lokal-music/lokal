const path = require('path')
const fs = require('fs-extra')
const { randomUUID, createHash } = require('crypto')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { getDB, getStorageDir } = require('../electron/ipc/db')
const { findPhonePlaceholder } = require('./linkUploadMatch')
const { phoneFileName, reservePhoneDestination } = require('./phoneFileNaming')
const { phoneDownloadDirectory } = require('../electron/storageLocations')

// The phone must opt in before using this endpoint. Only an individually
// paired device can upload, and only newly created files are ever removed.
async function receivePhoneFile(req,res) {
  if(!req.linkDevice || req.linkDevice.legacy)return res.status(401).json({error:'Pair this phone before sending files.'})
  if(!req.is('application/octet-stream'))return res.status(415).json({error:'Send an audio file.'})
  let metadata
  try{metadata=JSON.parse(Buffer.from(String(req.headers['x-link-metadata']||''),'base64url').toString('utf8'))}catch{return res.status(400).json({error:'Invalid file metadata.'})}
  if(!metadata || typeof metadata!=='object' || Array.isArray(metadata))return res.status(400).json({error:'Invalid file metadata.'})
  const extension=String(metadata.extension||'').toLowerCase()
  if(!['flac','mp3','m4a','aac','ogg','opus','wav','aiff','aif','alac','ape','wv','dsf','dff','webm'].includes(extension))return res.status(400).json({error:'Unsupported audio format.'})
  // Honor the dedicated incoming-phone folder; otherwise preserve the old
  // Lokal Phone subfolder on the user's normal download drive.
  const directory=phoneDownloadDirectory()
  // Network drives can disappear after a valid folder was selected.
  // Respond explicitly rather than letting a rejected async handler hang.
  try { await fs.ensureDir(directory) }
  catch (error) {
    return res.status(503).json({
      error: 'Phone copy destination is unavailable: ' +
        (error?.message || String(error)),
    })
  }
  const id=randomUUID(),partial=path.join(directory,`.${id}.${extension}.part`)
  let destination=null,stored=false,bytes=0
  const hash=createHash('sha256')
  const count=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>1024*1024*1024)return callback(new Error('File exceeds the 1 GiB limit.'));hash.update(chunk);callback(null,chunk)}})
  try {
    await pipeline(req,count,fs.createWriteStream(partial,{flags:'wx'}))
    if(!bytes)throw new Error('The file was empty.')
    const digest=hash.digest('hex')
    if(metadata.sha256 && metadata.sha256!==digest)throw new Error('The file checksum did not match.')
    const db=getDB()
    const matches=await require('./phoneFileMatch').resolvePhoneFiles(db,[{size:bytes,sha256:digest}])
    if(matches.length){
      try {
        if(await require('./phoneFileMetadata').repairPhoneFileMetadata(db,matches[0].trackId,getStorageDir()))
          require('../electron/ipc/remote').events.emit('library',{type:'phone-metadata-repair'})
      }
      catch(error){ console.warn('[phone-copy] Metadata repair failed:',error.message) }
      return res.json({ok:true,trackId:matches[0].trackId,alreadyPresent:true})
    }
    const { parseFile }=await import('music-metadata')
    const parsed=await parseFile(partial,{duration:true})
    if(!Number.isFinite(parsed.format.duration)||parsed.format.duration<=0)throw new Error('The upload is not a playable audio file.')
    const clean=(value,fallback)=>typeof value==='string'&&value.trim()?value.trim().slice(0,1000):fallback
    const tags=parsed.common
    const title=clean(metadata.title,clean(tags.title,'Unknown track')),artist=clean(metadata.artist,clean(tags.artist,'Unknown artist')),album=clean(metadata.album,clean(tags.album,''))
    // Keep the phone's filename if supplied; older phones fall back to the
    // embedded artist/title. Track IDs remain UUIDs, filenames do not.
    const filename=phoneFileName({originalFilename:metadata.originalFilename,artist,title,extension})
    destination=await reservePhoneDestination(partial,directory,filename)
    const concurrent=getDB().prepare("SELECT id,file_path FROM tracks WHERE file_hash=? AND file_path NOT LIKE 'ghost://%' LIMIT 1").get(digest)
    if(concurrent && await fs.pathExists(concurrent.file_path))return res.json({ok:true,trackId:concurrent.id,alreadyPresent:true})
    // Promote a matching sync placeholder in place so its likes, playlist
    // membership and listening history continue to reference the playable row.
    const ghost=findPhonePlaceholder(db,title,artist,parsed.format.duration)
    const trackId=ghost?.id || id
    const picture=tags.picture?.[0]
    const artwork=picture?.data?.length
      ? await require('../electron/artwork/thumb').writeCover(path.join(getStorageDir(),'artwork'),trackId,picture.data,{overwrite:true})
      : null
    const stat=await fs.stat(destination)
    db.transaction(()=>{
    if(ghost)db.prepare('UPDATE tracks SET file_path=?,file_hash=?,duration=? WHERE id=?').run(destination,digest,parsed.format.duration,trackId)
    else db.prepare('INSERT INTO tracks (id,file_path,file_hash,title,artist,album,album_artist,duration,track_num,year) VALUES (?,?,?,?,?,?,?,?,?,?)').run(trackId,destination,digest,title,artist,album,clean(tags.albumartist,''),parsed.format.duration,tags.track?.no||null,tags.year||null)
    require('./phoneFileMetadata').savePhoneFileMetadata(db,trackId,parsed,{artwork,mtimeMs:stat.mtimeMs})
    const artistId=require('../electron/artistId').resolveArtistId(db,artist)
    db.prepare('INSERT OR IGNORE INTO artist_track_links(artist_id,track_id) VALUES (?,?)').run(artistId,trackId)
    })()
    stored=true
    require('../electron/ipc/remote').events.emit('library',{type:'phone-download'})
    res.json({ok:true,trackId,file_hash:digest})
  } catch(error) {
    if(!res.headersSent&&!res.destroyed)res.status(400).json({error:error.message || 'The audio file could not be saved.'})
  } finally {await fs.remove(partial);if(destination&&!stored)await fs.remove(destination)}
}
module.exports={receivePhoneFile}
