'use strict';
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { getEncoding } = require('js-tiktoken');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const limit = 8000;
let enc, store;
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

class MemoryStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS memories(profile TEXT, id TEXT, text TEXT NOT NULL, PRIMARY KEY(profile,id))');
  }
  read(profile) {
    const items = this.db.prepare('SELECT id,text FROM memories WHERE profile=? ORDER BY rowid').all(profile);
    const content = JSON.stringify(items.map(item => item.text));
    const used = items.length ? (enc ||= getEncoding('cl100k_base')).encode(content, [], []).length : 0;
    return { items, used, limit };
  }
  change(profile, { op, id, text, previous }) {
    if (!/^[a-f0-9-]{36}$/i.test(id || '') || !['add','edit','delete'].includes(op)) fail(400, 'Ungültiger Eintrag.');
    if (op !== 'delete' && (typeof text !== 'string' || !text.trim() || text.length > 100000)) fail(400, 'Ungültiger Speichertext.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT text FROM memories WHERE profile=? AND id=?').get(profile,id);
      if (op === 'add') {
        if (!existing) this.db.prepare('INSERT INTO memories VALUES (?,?,?)').run(profile,id,text.trim());
        else if (existing.text !== text.trim()) fail(409,'Eintrag bereits vorhanden.');
      } else {
        if (!existing || existing.text !== previous) fail(409,'Eintrag wurde geändert. Bitte neu öffnen.');
        if (op === 'delete') this.db.prepare('DELETE FROM memories WHERE profile=? AND id=?').run(profile,id);
        else this.db.prepare('UPDATE memories SET text=? WHERE profile=? AND id=?').run(text.trim(),profile,id);
      }
      const result = this.read(profile);
      if (result.used > limit) fail(409, `Speicher voll: Bitte um mindestens ${result.used-limit} Tokens kürzen.`);
      this.db.exec('COMMIT'); return result;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
}

async function serveMemory(req,res,port) {
  const reply = (code, body) => { res.writeHead(code, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); };
  try {
    const user = req.headers['tailscale-user-login'];
    if (typeof user !== 'string' || !user.trim()) fail(403,'Persönliches Tailnet-Profil erforderlich.');
    if (req.method !== 'GET' && (req.method !== 'POST' || req.headers.origin !== `https://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json'))) fail(403,'Anfrage nicht erlaubt.');
    const ok = await new Promise((resolve,reject) => {
      const auth = http.get({hostname:'127.0.0.1',port,path:'/api/session?limit=1',headers:{cookie:req.headers.cookie || '',authorization:req.headers.authorization || '',host:req.headers.host}}, r=>{r.resume();resolve(r.statusCode===200);});
      auth.setTimeout(5000,()=>auth.destroy(new Error('timeout'))); auth.on('error',reject);
    });
    if (!ok) fail(401,'OpenCode-Anmeldung erforderlich.');
    if (!store) {
      const dir = path.join(process.env.LOCALAPPDATA,'OCFluffyTouch'); fs.mkdirSync(dir,{recursive:true});
      store = new MemoryStore(path.join(dir,'voice-memory.sqlite3'));
    }
    const profile = createHash('sha256').update(user.trim().toLowerCase()).digest('hex');
    if (req.method === 'GET') return reply(200,store.read(profile));
    let count=0; const parts=[];
    for await (const chunk of req) { count+=chunk.length; if(count>400000) fail(413,'Eintrag zu groß.'); parts.push(chunk); }
    let data; try {data=JSON.parse(Buffer.concat(parts).toString('utf8'));} catch {fail(400,'Ungültige Anfrage.');}
    reply(200,store.change(profile,data));
  } catch (e) { reply(e.status || 503,{error:e.status ? e.message : 'Erinnerungsspeicher nicht erreichbar.'}); }
}
module.exports={serveMemory,MemoryStore};
