const os = require('os')
const { randomUUID } = require('crypto')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')
const { LinkStore, safeEqual } = require('./store')
const { installCapture } = require('./capture')
const { reconcilePlaylists, savePlaylistSnapshot } = require('./reconcile')
const { createLinkedLibraryRefresh } = require('./libraryRefresh')
const { envelope, decode, text } = require('./protocol')
const { advertise } = require('./discovery')
let instance

function getLink() { return instance }
function createLink({ server, db, remote, enabled = () => true }) {
  if (instance) return instance
  const currentUser = () => String(remote.getRemoteState().userId || 'guest')
  const store = new LinkStore(db)
  installCapture(store, currentUser)
  const libraryRefresh = createLinkedLibraryRefresh()
  const sockets = new Map(), pending = new Map(), snapshots = new Map()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  let stopDiscovery
  let lastTheme=''
  const desktopTheme=()=>{
    const theme=db.prepare("SELECT value FROM settings WHERE key='theme'").get()?.value || 'dark'
    let overrides={};try{overrides=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='theme_overrides'").get()?.value || '{}')}catch{}
    return {theme,accentColor:overrides['--accent'] || null}
  }
  const themeListener=()=>{
    const theme=desktopTheme(),signature=JSON.stringify(theme);if(signature===lastTheme)return;lastTheme=signature
    for(const socket of sockets.values())send(socket,'theme',theme)
  }
  const send = (socket, type, body, id) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(envelope(type, body, id))) }
  const auth = token => {
    const device = store.authenticate(token)
    if (device && device.user_id === currentUser()) return device
    const legacy = String(process.env.REMOTE_TOKEN || '').trim()
    return legacy && token && safeEqual(legacy, token) ? { id:'legacy',name:'Legacy remote',user_id:currentUser(),legacy:true } : null
  }
  const ensureDiscovery = () => {
    if (!stopDiscovery && enabled()) try { stopDiscovery=advertise({id:store.deviceId,port:Number(process.env.PORT)||3421,version:require('../../package.json').version}) } catch {}
  }
  function closeDevice(id, reason = 'revoked') { sockets.get(id)?.close(4001,reason); sockets.delete(id); snapshots.delete(id) }
  function assertActive(device) {
    if (!enabled() || device.user_id !== currentUser() || (!device.legacy && !db.prepare('SELECT id FROM remote_devices WHERE id=? AND revoked=0').get(device.id))) throw new Error('Device access is no longer available')
  }
  server.on('upgrade', (req,socket,head) => {
    let url
    try { url=new URL(req.url,'http://localhost') } catch { socket.destroy(); return }
    if (url.pathname!=='/api/remote/ws') {socket.destroy();return}
    if (!remote.getRemoteState().connected) {socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return}
    const token=req.headers['x-remote-token'] || url.searchParams.get('token')
    const device=auth(token)
    // Browser cross-origin upgrades must not become a localhost control channel.
    const origin=req.headers.origin
    let sameOrigin=true
    if (origin) { try { sameOrigin=new URL(origin).host===req.headers.host } catch { sameOrigin=false } }
    if (!enabled() || !device || !sameOrigin || !require('../../server/apiKey').isLocalAddress(req.socket.remoteAddress)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    wss.handleUpgrade(req,socket,head,ws => wss.emit('connection',ws,device))
  })
  wss.on('connection',(socket,device) => {
    closeDevice(device.id,'reconnected')
    sockets.set(device.id,socket)
    socket.alive=true
    socket.on('pong',()=>{socket.alive=true})
    send(socket,'hello',{desktopId:store.deviceId,name:os.hostname(),user:{id:device.user_id},proto:1,capabilities:['remote','handoff','history','library','theme'],syncPreview:{history:db.prepare('SELECT COUNT(*) n FROM history_events WHERE user_id=?').get(device.user_id).n,operations:db.prepare('SELECT COUNT(*) n FROM library_ops WHERE user_id=?').get(device.user_id).n}})
    send(socket,'state',{...remote.getRemoteState(),target:'desktop'})
    send(socket,'theme',desktopTheme())
    socket.on('message',async raw => {
      let message
      try {
        assertActive(device)
        message=decode(raw)
        if (!device.legacy) store.touch(device.id)
        const body=message.body
        switch (message.type) {
          case 'hello': break
          case 'state': snapshots.set(device.id,{...body,updatedAt:Date.now()}); break
          case 'ack': {
            const request=pending.get(message.id)
            if (request?.deviceId===device.id) { clearTimeout(request.timer);pending.delete(message.id);request.resolve(body) }
            break
          }
          case 'command': {
            if (body.action==='resolveTracks') {
              const tracks=body.value?.queue;
              if(!Array.isArray(tracks)||tracks.length>5000)throw new Error('Invalid track query');
              const missing=[];
              for(let index=0;index<tracks.length;index++){const track=store.matchTrack(tracks[index]);if(!track||track.file_path.startsWith('ghost://')||!require('fs').existsSync(track.file_path))missing.push(index)}
              send(socket,'ack',{ok:true,missing},message.id);break;
            }
            const result=await remote.sendRemoteCommand({action:body.action,value:body.value,ts:Date.now()})
            send(socket,'ack',result?.error?{ok:false,error:result.error}:{ok:true,...result},message.id)
            break
          }
          case 'queue': send(socket,'queue',{queue:remote.getRemoteState().queue || [],index:remote.getRemoteState().currentIndex ?? -1},message.id);break
          case 'history.pull': if (device.legacy) throw new Error('Pair this device before syncing');send(socket,'history.events',store.pull('history_events',device.user_id,body.cursor),message.id);break
          case 'history.push': if (device.legacy) throw new Error('Pair this device before syncing');send(socket,'ack',{ok:true,accepted:store.pushHistory(body.items,device.user_id,device.id)},message.id);break
          case 'library.pull':
            if (device.legacy) throw new Error('Pair this device before syncing')
            reconcilePlaylists(store, device.user_id)
            send(socket,'library.ops',store.pull('library_ops',device.user_id,body.cursor),message.id)
            break
          case 'library.push': {
            if (device.legacy) throw new Error('Pair this device before syncing')
            // Capture desktop changes before applying phone edits. Snapshot the
            // resulting state afterwards so remote operations are not echoed.
            reconcilePlaylists(store, device.user_id)
            const accepted = store.applyOps(body.items,device.user_id,device.id)
            savePlaylistSnapshot(store, device.user_id)
            libraryRefresh.accepted(accepted)
            send(socket,'ack',{ok:true,accepted},message.id)
            break
          }
          case 'theme': // Adopt only after the desktop owner explicitly opts in.
            if (db.prepare("SELECT value FROM settings WHERE key='link_theme_sync'").get()?.value==='1') await remote.sendRemoteCommand({action:'linkTheme',value:body,_trustedLinkTheme:true})
            break
          case 'bye':socket.close(1000);break
          default:throw new Error('Unsupported incoming link message')
        }
      } catch (error) { send(socket,'ack',{ok:false,error:text(error.message,200)},message?.id) }
    })
    socket.on('error',()=>{})
    socket.on('close',()=>{ if(sockets.get(device.id)===socket){sockets.delete(device.id);snapshots.delete(device.id)} })
  })
  const stateListener=state => {
    for (const [id,socket] of sockets) {
      const device=store.devices(currentUser()).find(item=>item.id===id && !item.revoked)
      if ((!device && id!=='legacy') || !enabled()) {closeDevice(id,'access changed');continue}
      send(socket,'state',{...state,target:'desktop'})
    }
  }
  remote.events.on('state',stateListener)
  remote.events.on('theme',themeListener)
  const heartbeat=setInterval(()=>{
    if (!enabled() && stopDiscovery) {stopDiscovery();stopDiscovery=null}
    for(const socket of sockets.values()){if(!socket.alive)socket.terminate();else{socket.alive=false;socket.ping()}}
  },30000)
  heartbeat.unref?.()
  const api = {
    store, auth,
    async createPairing() {
      if (!enabled()) throw new Error('Enable Phone Remote before pairing.')
      ensureDiscovery()
      const pairing=store.createPairing(currentUser())
      const info=remote.getRemoteConnectionInfo()
      const host=info.primary?new URL(info.primary).hostname:null
      const uri=host?`lokal://pair?${new URLSearchParams({host,port:String(Number(process.env.PORT)||3421),id:store.deviceId,code:pairing.code})}`:null
      return {...pairing,uri,qrDataUrl:uri?await QRCode.toDataURL(uri,{width:256,margin:2}):null,name:os.hostname()}
    },
    pair(body,address) { const result=store.pair(body,address);closeDevice(body.deviceId,'paired again');return result },
    devices() { return store.devices(currentUser()).map(device=>({...device,connected:sockets.has(device.id),state:snapshots.get(device.id)||null})) },
    revoke(id) { const result=store.revoke(id,currentUser());if(result)closeDevice(id);return {ok:result} },
    commandDevice(id,command) {
      const socket=sockets.get(id)
      if (!socket || !store.devices(currentUser()).some(d=>d.id===id&&!d.revoked)) return Promise.resolve({ok:false,error:'Phone is not connected.'})
      const requestId=randomUUID()
      return new Promise(resolve=>{
        const timer=setTimeout(()=>{pending.delete(requestId);resolve({ok:false,error:'Phone did not respond.'})},String(command.action).startsWith('handoff')?120000:7000)
        pending.set(requestId,{deviceId:id,resolve,timer});send(socket,'command',command,requestId)
      })
    },
    close() {clearInterval(heartbeat);libraryRefresh.close();stopDiscovery?.();remote.events.removeListener('state',stateListener);remote.events.removeListener('theme',themeListener);for(const socket of sockets.values())socket.close(1001);wss.close();for(const request of pending.values()){clearTimeout(request.timer);request.resolve({ok:false,error:'Link closed'})}instance=null},
  }
  server.once('close',api.close)
  instance=api
  if(store.devices(currentUser()).some(d=>!d.revoked))ensureDiscovery()
  return api
}
module.exports={createLink,getLink}
