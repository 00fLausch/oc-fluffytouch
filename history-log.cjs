'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const sessionPattern = /^ses_[a-z\d_-]{1,100}$/i;
const idPattern = /^[a-z\d:._-]{1,180}$/i;
const textLimit = 24000;
const liveTypes = new Set(['user','assistant','private','intent','setting.verified','setting.unverified',
  'memory.saved','memory.unverified','handoff.requested','handoff.admitted','handoff.not-sent','handoff.unconfirmed',
  'handoff.readback','live.interrupted']);
const fail = status => { throw Object.assign(new Error('Verlaufslog'), {status}); };

function timeLabel(ms) {
  const offset = -new Date(ms).getTimezoneOffset();
  const hours = String(Math.floor(Math.abs(offset)/60)).padStart(2,'0');
  const minutes = String(Math.abs(offset)%60).padStart(2,'0');
  return new Date(ms + offset*60000).toISOString().slice(0,-1) + (offset < 0 ? '-' : '+') + hours + ':' + minutes;
}

class HistoryLog {
  constructor(directory, { now = Date.now, maxBytes = 5*1024*1024 } = {}) {
    this.file = path.join(directory,'verlaufslog.jsonl');
    this.previous = this.file + '.1';
    this.now = now;
    this.maxBytes = maxBytes;
    this.startedAt = now();
    this.scanned = new Map();
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    this.oldIds = this.restore(this.previous);
    this.ids = this.restore(this.file);
    if (!fs.existsSync(this.file)) this.append(null,[{chat:'system',event:'log.started',at:this.startedAt}]);
  }

  restore(file) {
    const ids = new Set();
    if (!fs.existsSync(file)) return ids;
    for (const line of fs.readFileSync(file,'utf8').split('\n')) {
      try {
        const row = JSON.parse(line);
        const at = Date.parse(row.time);
        if (Number.isFinite(at)) this.startedAt = Math.min(this.startedAt,at);
        if (row.id) ids.add(`${row.session}:${row.chat}:${row.id}`);
        if (row.chat === 'main' && Number.isFinite(at)) this.scanned.set(row.session,Math.max(at,this.scanned.get(row.session) || 0));
      } catch { /* A truncated last line does not invalidate earlier records. */ }
    }
    return ids;
  }

  append(session, events) {
    const written = new Set();
    const received = this.now();
    let batch = '', batchIds = [], size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    const flush = () => {
      if (!batch) return;
      fs.appendFileSync(this.file,batch,{encoding:'utf8',mode:0o600});
      for (const key of batchIds) this.ids.add(key);
      batch = ''; batchIds = [];
    };
    for (const item of events) {
      const key = item.id && `${session}:${item.chat}:${item.id}`;
      if (key && (this.ids.has(key) || this.oldIds.has(key) || written.has(key))) continue;
      const { at, ...fields } = item;
      const line = JSON.stringify({ time:timeLabel(at), recorded:timeLabel(received), ...(session ? {session} : {}), ...fields })+'\n';
      const bytes = Buffer.byteLength(line);
      if (size && size + bytes > this.maxBytes) {
        flush();
        fs.renameSync(this.file,this.previous);
        this.oldIds = this.ids; this.ids = new Set(); size = 0;
      }
      batch += line; size += bytes;
      if (key) { written.add(key); batchIds.push(key); }
    }
    flush();
  }
}

function textFields(text) {
  return typeof text === 'string' ? { text:text.slice(0,textLimit), ...(text.length > textLimit ? {truncated:true} : {}) } : {};
}

function liveEntries(items, now) {
  if (!Array.isArray(items) || items.length > 32) fail(400);
  return items.map(row => {
    if (!row || !liveTypes.has(row.event) || typeof row.id !== 'string' || !idPattern.test(row.id) ||
        !Number.isFinite(row.at) || Math.abs(row.at - now) > 86400000*7) fail(400);
    const meta = {};
    for (const key of ['route','state','setting','messageId','turnId']) {
      if (typeof row[key] === 'string' && idPattern.test(row[key])) meta[key] = row[key];
    }
    return { chat:'live', event:row.event, id:row.id, at:row.at, ...meta,
      ...(row.event === 'private' || row.event.startsWith('memory.') ? {} : {
        ...textFields(row.text), ...(row.truncated === true && typeof row.text === 'string' ? {truncated:true} : {}) }) };
  });
}

function mainEntry(message, since) {
  const assistant = message.type === 'assistant';
  if (!assistant && message.type !== 'user' || typeof message.id !== 'string' || !idPattern.test(message.id)) return;
  const at = assistant ? message.time?.completed : message.time?.created;
  if (!Number.isFinite(at) || at < since) return;
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = assistant ? parts.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : message.text;
  const tools = assistant ? parts.filter(part => part.type === 'tool' && typeof part.name === 'string').slice(0,30).map(part => part.name.slice(0,80)) : [];
  if ((!text || typeof text !== 'string') && !tools.length) return;
  const model = message.model;
  return { chat:'main', event:message.type, id:message.id, at, ...textFields(text),
    ...(tools.length ? {tools} : {}), ...(model?.id && model.providerID ? {model:`${model.providerID}/${model.id}`} : {}) };
}

async function readNative(req, port, url) {
  return await new Promise((resolve,reject) => {
    const headers = { cookie:req.headers.cookie || '', authorization:req.headers.authorization || '', host:req.headers.host };
    const upstream = http.get({hostname:'127.0.0.1',port,path:url,headers,signal:AbortSignal.timeout(4500)}, r => {
      if (r.statusCode !== 200) {
        r.resume(); reject(Object.assign(new Error('OpenCode'),{status:[401,403,404].includes(r.statusCode) ? r.statusCode : 502})); return;
      }
      const chunks=[];
      let bytes=0;
      r.on('error',reject);
      r.on('data', chunk => {
        bytes+=chunk.length;
        if (bytes > 4*1024*1024) r.destroy(new Error('Antwort zu groß'));
        else chunks.push(chunk);
      });
      r.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    upstream.on('error',reject);
  });
}

async function collectMain(req,port,session,log,firstPage) {
  const start = log.now();
  const since = Math.max(log.startedAt,(log.scanned.get(session) || 0)-5000);
  const collected = [], seen = new Set();
  let result=firstPage, gap=null;
  for (let i=0;i<5;i++) {
    if (!Array.isArray(result.data)) fail(502);
    collected.push(...result.data.map(message=>mainEntry(message,since)).filter(Boolean));
    const cursor = result.cursor?.next;
    const oldest = result.data.at(-1)?.time?.created;
    if (!cursor || Number.isFinite(oldest) && oldest < since) break;
    if (typeof cursor !== 'string' || seen.has(cursor)) fail(502);
    if (i===4) { gap={chat:'main',event:'sync.limited',at:start}; break; }
    seen.add(cursor);
    result=await readNative(req,port,`/api/session/${session}/message?limit=32&cursor=${encodeURIComponent(cursor)}`);
  }
  collected.sort((a,b)=>a.at-b.at);
  log.append(session,gap ? [...collected,gap] : collected);
  log.scanned.set(session,Math.max(start,log.scanned.get(session) || 0));
}

async function serveHistoryLog(req,res,port,getLog) {
  const reply = (status,body) => {
    if (!res.destroyed) { res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(body)); }
  };
  try {
    if (req.method !== 'POST') fail(405);
    if (!req.headers['tailscale-user-login']?.trim() || req.headers.origin !== `https://${req.headers.host}` ||
        req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(403);
    if (Number(req.headers['content-length']) > 512*1024) fail(413);
    const chunks=[];
    let bytes=0;
    for await (const chunk of req) {
      if ((bytes+=chunk.length) > 512*1024) fail(413);
      chunks.push(chunk);
    }
    let body;
    try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400); }
    const {session, entries, syncMain} = body || {};
    if (typeof session !== 'string' || !sessionPattern.test(session) || typeof syncMain !== 'boolean') fail(400);
    const live = liveEntries(entries, Date.now());
    // Native auth, scoped to the exact session. Browser submissions cannot supply main-chat entries.
    const base = `/api/session/${session}`;
    const first = await readNative(req,port,syncMain ? `${base}/message?limit=32&order=desc` : base);
    const log = getLog();
    log.append(session,live);
    if (syncMain) await collectMain(req,port,session,log,first);
    reply(200,{ok:true});
  } catch (e) { reply(e.status || 503,{error:'Verlaufslog nicht verfügbar.'}); }
}

module.exports = { HistoryLog, serveHistoryLog };
