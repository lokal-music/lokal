const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('crypto')
const { MAX_BATCH, text, trackKey, nextClock, compareStamp } = require('./protocol')
const hash = token => createHash('sha256').update(String(token)).digest('hex')
const safeEqual = (a, b) => { const aa = Buffer.from(String(a)), bb = Buffer.from(String(b)); return aa.length === bb.length && timingSafeEqual(aa, bb) }

class LinkStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db
    db.function('link_normalize', value => String(value || '').toLowerCase().replace(/\s+/g,' ').trim())
    this.now = now
    this.clock = ''
    this.pairing = null
    this.attempts = new Map()
    this.suppressed = 0
    db.exec(`
      CREATE TABLE IF NOT EXISTS link_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS link_track_aliases (track_key TEXT PRIMARY KEY, track_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS history_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, device_id TEXT NOT NULL, track_key TEXT NOT NULL, file_hash TEXT, played_at INTEGER NOT NULL, ms_played INTEGER NOT NULL, source TEXT NOT NULL, track_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS library_ops (cursor INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, device_id TEXT NOT NULL, hlc TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL, fields_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_field_clocks (user_id TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL, hlc TEXT NOT NULL, device_id TEXT NOT NULL, op_id TEXT NOT NULL, PRIMARY KEY(user_id, entity, entity_id, field));
      CREATE TABLE IF NOT EXISTS link_tombstones (user_id TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, hlc TEXT NOT NULL, device_id TEXT NOT NULL, op_id TEXT NOT NULL, PRIMARY KEY(user_id, entity, entity_id));
      CREATE INDEX IF NOT EXISTS link_history_user_cursor ON history_events(user_id, cursor);
      CREATE INDEX IF NOT EXISTS link_ops_user_cursor ON library_ops(user_id, cursor);
    `)
    let id = db.prepare("SELECT value FROM link_meta WHERE key='device_id'").get()?.value
    if (!id) { id = randomUUID(); db.prepare("INSERT INTO link_meta VALUES ('device_id', ?)").run(id) }
    this.deviceId = id
    this.clock = db.prepare("SELECT MAX(hlc) AS value FROM library_ops").get()?.value || db.prepare("SELECT value FROM link_meta WHERE key='hlc'").get()?.value || ''
    if (!db.prepare('PRAGMA table_info(playlists)').all().some(column => column.name === 'uuid')) db.exec('ALTER TABLE playlists ADD COLUMN uuid TEXT')
    const update = db.prepare('UPDATE playlists SET uuid=? WHERE id=?')
    for (const row of db.prepare("SELECT id FROM playlists WHERE uuid IS NULL OR uuid=''").all()) update.run(randomUUID(), row.id)
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS playlists_uuid ON playlists(uuid)')
  }
  tick(incoming = '') {
    this.clock = nextClock(this.clock, incoming, this.now())
    this.db.prepare("INSERT OR REPLACE INTO link_meta VALUES ('hlc', ?)").run(this.clock)
    return this.clock
  }
  createPairing(userId) {
    this.pairing = { code: String(require('crypto').randomInt(100000, 1000000)), userId, expiresAt: this.now() + 120000 }
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt, desktopId: this.deviceId }
  }
  pair({ code, deviceName, deviceId }, address) {
    const now = this.now()
    const prior = this.attempts.get(address)
    const attempt = prior && prior.until > now ? prior : { count: 0, until: now + 60000 }
    this.attempts.set(address, attempt)
    for (const [key, value] of this.attempts) if (value.until < now) this.attempts.delete(key)
    if (this.attempts.size > 2000) this.attempts.delete(this.attempts.keys().next().value)
    if (++attempt.count > 10) throw Object.assign(new Error('Too many pairing attempts. Try again shortly.'), { status: 429 })
    const pairing = this.pairing
    if (!pairing || pairing.expiresAt <= now || !safeEqual(pairing.code, String(code))) throw Object.assign(new Error('Pairing code is invalid or expired.'), { status: 401 })
    const id = text(deviceId, 128), name = text(deviceName, 100)
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id) || !name) throw Object.assign(new Error('A device ID and name are required.'), { status: 400 })
    const token = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT INTO remote_devices (id,name,token_hash,user_id,created,last_seen,revoked) VALUES (?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash,user_id=excluded.user_id,created=excluded.created,last_seen=excluded.last_seen,revoked=0').run(id, name, hash(token), pairing.userId, now, now)
    this.pairing = null
    return { token, desktopId: this.deviceId, user: { id: pairing.userId } }
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 512) return null
    return this.db.prepare('SELECT id,name,user_id FROM remote_devices WHERE token_hash=? AND revoked=0').get(hash(token)) || null
  }
  devices(userId) { return this.db.prepare('SELECT id,name,created,last_seen,revoked FROM remote_devices WHERE user_id=? ORDER BY created DESC').all(userId) }
  revoke(id, userId) { return this.db.prepare('UPDATE remote_devices SET revoked=1 WHERE id=? AND user_id=?').run(id, userId).changes > 0 }
  touch(id) { this.db.prepare('UPDATE remote_devices SET last_seen=? WHERE id=?').run(this.now(), id) }
  pull(table, userId, cursor = 0) {
    if (!['history_events', 'library_ops'].includes(table)) throw new Error('Unknown link log')
    const after = Math.max(0, Number.isSafeInteger(Number(cursor)) ? Number(cursor) : 0)
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE user_id=? AND cursor>? ORDER BY cursor LIMIT ?`).all(userId, after, MAX_BATCH)
    return { items: rows.map(({ user_id, ...row }) => row), cursor: rows.at(-1)?.cursor ?? after, hasMore: rows.length === MAX_BATCH }
  }
  matchTrack(fields) {
    if (fields.file_hash) {
      const row = this.db.prepare('SELECT * FROM tracks WHERE file_hash=? LIMIT 1').get(text(fields.file_hash))
      if (row) return row
    }
    const key = text(fields.track_key, 1500), parts = key.split('|'), duration = Number(parts.pop())
    const title = parts.pop(), artist = parts.join('|')
    const alias=this.db.prepare('SELECT t.* FROM link_track_aliases a JOIN tracks t ON t.id=a.track_id WHERE a.track_key=?').get(key)
    if (!title || !artist || !Number.isFinite(duration)) return null
    const exact = this.db.prepare("SELECT * FROM tracks WHERE link_normalize(title)=? AND link_normalize(artist)=? AND abs(COALESCE(duration,0)-?)<=2 ORDER BY CASE WHEN file_path LIKE 'ghost://%' THEN 1 ELSE 0 END, abs(COALESCE(duration,0)-?) LIMIT 1").get(title, artist, duration, duration)
    if (exact && !String(exact.file_path).startsWith('ghost://')) return exact
    // Album-owner tags identify many collaborations differently between PC
    // and phone. Restrict to the same title, album and duration so remixes and
    // unrelated tracks aren't merged just because the release artist matches.
    const metadata = fields.track && typeof fields.track === 'object' ? fields.track : fields
    const owner = text(metadata.album_artist || metadata.albumArtist, 500)
    const album = text(metadata.album, 500)
    if (owner && album && title) {
      const byOwner = this.db.prepare("SELECT * FROM tracks WHERE link_normalize(title)=? AND link_normalize(album)=? AND link_normalize(COALESCE(NULLIF(album_artist,''),artist))=? AND abs(COALESCE(duration,0)-?)<=2 AND file_path NOT LIKE 'ghost://%' ORDER BY abs(COALESCE(duration,0)-?) LIMIT 1")
        .get(title, album.toLowerCase(), owner.toLowerCase(), duration, duration)
      if (byOwner) return byOwner
    }
    return exact || alias || null
  }
  ensureTrack(fields, key) {
    const existing=this.matchTrack({...fields,track_key:key});
    const parts=String(key).split('|'),duration=Number(parts.pop())||0,title=parts.pop()||'Unknown track',artist=parts.join('|')||'Unknown artist';
    const id='link_'+hash(key);
    const source = String(fields.source_ref || '')
    const youtube = fields.online_ref && /^yt:[a-zA-Z0-9_-]{11}$/.test(source)
    const soundcloud = fields.online_ref && /^sc:\d+$/.test(source)
    // A cross-device catalogue reference stays playable after synchronization.
    // Never reuse or store a provider-signed media URL from a remote device.
    const filePath = youtube ? 'ghost://youtube/online/'+source.slice(3)
      : soundcloud ? 'ghost://soundcloud/online/'+source.slice(3)
      : 'ghost://link/'+id
    const image = String(fields.artwork_url || '')
    const artwork = /^https:\/\//.test(image) && !/[?&](?:token|signature|expires|auth)=/i.test(image)
      ? image.slice(0, 2000) : null
    // The provider's stable recording may already be in the local DB under
    // a different song ID. Reuse it rather than INSERT OR IGNORE silently
    // skipping the new row because file_path is UNIQUE.
    if (youtube || soundcloud) {
      const byPath=this.db.prepare('SELECT * FROM tracks WHERE file_path=?').get(filePath)
      if (byPath) return byPath
      // Repair old metadata-only link placeholders when a newer paired
      // device finally supplies a stable provider identity.
      if (existing && String(existing.file_path).startsWith('ghost://link/')) {
        this.db.prepare('UPDATE tracks SET file_path=?,source_ref=?,artwork_url=COALESCE(artwork_url,?) WHERE id=?')
          .run(filePath,source,artwork,existing.id)
        return this.db.prepare('SELECT * FROM tracks WHERE id=?').get(existing.id)
      }
    }
    if (existing) return existing;
    this.db.prepare('INSERT OR IGNORE INTO tracks (id,file_path,file_hash,title,artist,album,duration,source_ref,artwork_url) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,filePath,text(fields.file_hash)||id,text(fields.title)||title,text(fields.artist)||artist,text(fields.album),duration,youtube||soundcloud ? source : null,artwork);
    return this.db.prepare('SELECT * FROM tracks WHERE id=?').get(id);
  }
  pushHistory(items, userId, deviceId) {
    if (!Array.isArray(items) || items.length > MAX_BATCH) throw new Error('Invalid history batch')
    return this.db.transaction(() => {
      let accepted = 0
      for (const item of items) {
        if (!item || typeof item.event_id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(item.event_id) || !text(item.track_key,1500) || !Number.isSafeInteger(item.played_at) || item.played_at < 0 || item.played_at > this.now()+300000 || !Number.isSafeInteger(item.ms_played) || item.ms_played < 0 || item.ms_played > 86400000) throw new Error('Invalid history event')
        if (!/^[a-zA-Z0-9_-]{8,128}$/.test(item.device_id || '')) throw new Error('Invalid history source')
        const result = this.db.prepare('INSERT OR IGNORE INTO history_events (event_id,user_id,device_id,track_key,file_hash,played_at,ms_played,source,track_json) VALUES (?,?,?,?,?,?,?,?,?)').run(item.event_id,userId,item.device_id,text(item.track_key,1500),text(item.file_hash),item.played_at,item.ms_played,text(item.source,50)||'phone',JSON.stringify(item.track || {}))
        if (!result.changes) continue
        accepted++
        // Track metadata is nested in the history envelope, while its stable
        // identity and file hash are top-level. Match both before creating a
        // metadata-only placeholder that cannot be played on this computer.
        let track = this.matchTrack({...item, track: item.track})
        const image = text(item.track?.artwork_url, 2000)
        const artworkUrl = /^https:\/\//.test(image) && !/[?&](?:token|signature|expires|auth)=/i.test(image) ? image : null
        if (!track) {
          const parts=item.track_key.split('|'); const duration=Number(parts.pop())||0; const title=parts.pop()||'Unknown track'; const artist=parts.join('|')||'Unknown artist'
          const id='link_'+hash(item.track_key)
          this.db.prepare('INSERT OR IGNORE INTO tracks (id,file_path,file_hash,title,artist,album,album_artist,duration,download_source,artwork_url) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(id,'ghost://link/'+id,item.file_hash||id,text(item.track?.title)||title,text(item.track?.artist)||artist,text(item.track?.album),text(item.track?.album_artist),duration,'mobile',artworkUrl)
          track=this.db.prepare('SELECT * FROM tracks WHERE id=?').get(id)
        }
        if (track && String(track.file_path).startsWith('ghost://link/')) {
          // Repair history placeholders created by older desktop releases,
          // without changing the provenance of any real local recording.
          this.db.prepare("UPDATE tracks SET download_source='mobile', artwork_url=COALESCE(artwork_url,?) WHERE id=?")
            .run(artworkUrl,track.id)
        }
        // Import directly: receiving a play never scrobbles it a second time.
        if (track && item.ms_played >= 30000) {
          this.db.prepare('INSERT INTO play_history (user_id,track_id,seconds_played,played_at) VALUES (?,?,?,?)').run(userId,track.id,Math.round(item.ms_played/1000),Math.floor(item.played_at/1000))
          this.suppressed++
          try { this.db.prepare("INSERT INTO listening_events (user_id,track_id,event_type,source_type,source_id,seconds_played,started_at,ended_at,created_at) VALUES (?,?,'qualified_play','link',?,?,?,?,?)").run(userId,track.id,item.event_id,Math.round(item.ms_played/1000),Math.floor((item.played_at-item.ms_played)/1000),Math.floor(item.played_at/1000),Math.floor(item.played_at/1000)) } finally {this.suppressed--}
        }
      }
      return accepted
    })()
  }
  appendOp({ entity, entity_id, op, fields = {} }, userId, deviceId = this.deviceId) {
    const item = { op_id: randomUUID(), device_id: deviceId, hlc: this.tick(), entity, entity_id, op, fields }
    this.applyOps([item], userId, deviceId)
    return item
  }
  applyOps(items, userId, deviceId) {
    if (!Array.isArray(items) || items.length > MAX_BATCH) throw new Error('Invalid library batch')
    return this.db.transaction(() => {
      let accepted = 0
      this.suppressed++
      try {
        for (const item of items) {
          const fields = item.fields || (typeof item.fields_json === 'string' ? JSON.parse(item.fields_json) : {})
          if (!item || !/^[a-zA-Z0-9_-]{8,128}$/.test(item.op_id || '') || !/^[a-zA-Z0-9_-]{8,128}$/.test(item.device_id || '') || !/^\d{16}:\d{8}$/.test(item.hlc || '') || !['like','playlist','track'].includes(item.entity) || !text(item.entity_id,1500) || !['like','unlike','playlist.create','playlist.rename','playlist.delete','playlist.add','playlist.remove','playlist.move','track.edit'].includes(item.op) || !fields || typeof fields !== 'object' || Array.isArray(fields) || JSON.stringify(fields).length > 32768) throw new Error('Invalid library operation')
          if (item.entity === 'like' ? !['like','unlike'].includes(item.op) : !item.op.startsWith(item.entity+'.')) throw new Error('Library operation entity mismatch')
          this.tick(item.hlc)
          const stored = this.db.prepare('INSERT OR IGNORE INTO library_ops (op_id,user_id,device_id,hlc,entity,entity_id,op,fields_json) VALUES (?,?,?,?,?,?,?,?)').run(item.op_id,userId,item.device_id,item.hlc,item.entity,item.entity_id,item.op,JSON.stringify(fields))
          if (!stored.changes) continue
          accepted++
          const tombstone = this.db.prepare('SELECT * FROM link_tombstones WHERE user_id=? AND entity=? AND entity_id=?').get(userId,item.entity,item.entity_id)
          if (tombstone && compareStamp(item,tombstone)<=0) continue
          const win = field => {
            const old = this.db.prepare('SELECT hlc,device_id,op_id FROM library_field_clocks WHERE user_id=? AND entity=? AND entity_id=? AND field=?').get(userId,item.entity,item.entity_id,field)
            if (old && compareStamp(item,old)<=0) return false
            this.db.prepare('INSERT OR REPLACE INTO library_field_clocks VALUES (?,?,?,?,?,?,?)').run(userId,item.entity,item.entity_id,field,item.hlc,item.device_id,item.op_id)
            return true
          }
          if (item.entity === 'like' && ['like','unlike'].includes(item.op) && win('liked')) {
            const track = this.ensureTrack(fields,item.entity_id)
            if (!track) continue
            if (item.op === 'like') this.db.prepare('INSERT OR IGNORE INTO user_likes (user_id,track_id) VALUES (?,?)').run(userId,track.id)
            else this.db.prepare('DELETE FROM user_likes WHERE user_id=? AND track_id=?').run(userId,track.id)
          } else if (item.entity === 'playlist') {
            let playlist = this.db.prepare('SELECT id FROM playlists WHERE uuid=? AND user_id=?').get(item.entity_id,userId)
            if (item.op === 'playlist.create' && win('created')) {
              if (!playlist) { const id=randomUUID(); this.db.prepare('INSERT INTO playlists (id,uuid,name,user_id) VALUES (?,?,?,?)').run(id,item.entity_id,text(fields.name,200)||'Playlist',userId); playlist={id};win('name') } else if(win('name')) this.db.prepare('UPDATE playlists SET name=? WHERE id=?').run(text(fields.name,200)||'Playlist',playlist.id)
            }
            if (!playlist) continue
            if (item.op === 'playlist.rename' && win('name')) this.db.prepare('UPDATE playlists SET name=? WHERE id=?').run(text(fields.name,200)||'Playlist',playlist.id)
            if (item.op === 'playlist.delete' && win('deleted')) {
              this.db.prepare('INSERT OR REPLACE INTO link_tombstones VALUES (?,?,?,?,?,?)').run(userId,item.entity,item.entity_id,item.hlc,item.device_id,item.op_id)
              this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=?').run(playlist.id)
              this.db.prepare('DELETE FROM playlists WHERE id=?').run(playlist.id)
            }
            if (['playlist.add','playlist.remove','playlist.move'].includes(item.op)) {
              const track=this.ensureTrack(fields,text(fields.track_key,1500)), member=text(fields.track_key,1500)
              if (!track || !member || !win('member:'+member)) continue
              if (item.op==='playlist.remove') this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?').run(playlist.id,track.id)
              else {
                const position=Number(fields.position)
                if (!Number.isFinite(position) || Math.abs(position)>1e12) throw new Error('Invalid playlist position')
                const existing=this.db.prepare('SELECT id FROM playlist_tracks WHERE playlist_id=? AND track_id=?').get(playlist.id,track.id)
                if (existing) this.db.prepare('UPDATE playlist_tracks SET position=? WHERE id=?').run(position,existing.id)
                else this.db.prepare('INSERT INTO playlist_tracks (playlist_id,track_id,position,added_by,added_at) VALUES (?,?,?,?,?)').run(playlist.id,track.id,position,userId,Math.floor(this.now()/1000))
              }
            }
          } else if (item.entity==='track' && item.op==='track.edit') {
            const track=this.matchTrack({ ...fields,track_key:item.entity_id })
            if (!track) continue
            this.db.prepare('INSERT OR IGNORE INTO link_track_aliases VALUES (?,?)').run(item.entity_id,track.id)
            for (const field of ['title','artist','album','album_artist','genre','year','track_num']) if (Object.hasOwn(fields,field) && win(field)) {
              const value=['year','track_num'].includes(field)?Number(fields[field]):text(fields[field],1000)
              if (typeof value==='number' && !Number.isFinite(value)) continue
              this.db.prepare(`UPDATE tracks SET ${field}=? WHERE id=?`).run(value,track.id)
            }
          }
        }
      } finally { this.suppressed-- }
      return accepted
    })()
  }
}
module.exports = { LinkStore, hash, safeEqual }
