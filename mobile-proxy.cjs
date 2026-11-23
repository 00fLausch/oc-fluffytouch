'use strict';

// This proxy is local-only. Authentication and authorization remain with OpenCode.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { HistoryLog, serveHistoryLog } = require('./history-log.cjs');
const catalog = require('./features.json');
const { version } = require('./package.json');
const selected = process.env.OC_FLUFFYTOUCH_FEATURES;
const features = selected === undefined ? Object.keys(catalog) : selected === 'none' ? [] : selected.split(',').filter(Boolean);
if (features.some(name => !Object.hasOwn(catalog, name) || !catalog[name].requires.every(dep => features.includes(dep)))) {
  throw new Error('Invalid OC fluffyTouch feature selection');
}
const enabled = name => features.includes(name);
const hasAudio = enabled('read-aloud') || enabled('transcript');
const profile = process.env.OC_FLUFFYTOUCH_PROFILE || '';
const bridgeToken = hasAudio ? process.env.OC_FLUFFYTOUCH_BRIDGE_TOKEN : undefined;
if (hasAudio && !/^[a-f0-9]{64}$/.test(bridgeToken || '')) throw new Error('Start the paired audio bridge via Start-OCFluffyTouch.ps1');
const pairId = bridgeToken ? createHash('sha256').update(bridgeToken, 'ascii').digest('hex') : null;
const bridgeHeader = 'x-fluffytouch-bridge-token';
const expertModel = enabled('expert') ? (process.env.OC_FLUFFYTOUCH_EXPERT_MODEL || '') : '';
if (expertModel && !/^[a-z0-9_.-]+\/[a-z0-9_.:+@/-]+$/i.test(expertModel)) throw new Error('Invalid expert model reference');

let historyLog;
function getHistoryLog() {
  const directory = process.env.OPENCODE_TOUCH_LOG_DIR || path.join(process.env.LOCALAPPDATA,'OCFluffyTouch');
  return historyLog ||= new HistoryLog(directory);
}

const upstreamPort = Number(process.argv[2]);
const listenPort = Number(process.argv[3] || 14973);
const voicePort = Number(process.argv[4] || 14974);
if (![upstreamPort, listenPort, voicePort].every((n) => Number.isInteger(n) && n > 0 && n < 65536)) {
  throw new Error('Expected upstream, proxy and voice port numbers');
}

const css = `<style id="opencode-touch-ios-fix">
@media (max-width: 768px), (hover: none) and (pointer: coarse) {
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"] {
    font-size: 16px !important;
  }
}
@keyframes oc-mic-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, .55); }
  50% { box-shadow: 0 0 0 7px rgba(59, 130, 246, 0); }
}
@keyframes oc-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: .5; }
  40% { transform: translateY(-4px); opacity: 1; }
}
@keyframes oc-speak-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
#opencode-touch-mic.oc-mic-recording {
  background: #2563eb !important;
  color: #fff !important;
  opacity: 1 !important;
  animation: oc-mic-pulse 1.2s infinite;
}
#opencode-touch-mic[aria-pressed="true"] svg { stroke: #fff; }
#opencode-touch-live {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(92vw, 420px);
  z-index: 2147483000;
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 9px 13px;
  border-radius: 12px;
  background: rgba(24, 24, 27, .95);
  color: #f4f4f5;
  font: 440 13px/1.35 system-ui, -apple-system, sans-serif;
  box-shadow: 0 10px 28px rgba(0, 0, 0, .38);
  pointer-events: none;
}
#opencode-touch-live[data-tone="error"] { background: rgba(127, 29, 29, .96); }
#opencode-touch-dots { position: absolute; display: inline-flex; gap: 3px; align-items: center; transform: translateY(-50%); pointer-events: none; z-index: 11; }
.oc-dictation-follow { position: relative; overflow-anchor: none; scroll-behavior: auto !important; }
.oc-dictation-follow > [data-component="composer-editor"] { padding-inline-end: 36px; }
[data-slot="text-part-body"]::highlight(oc-pending-words), [data-slot="text-part-body"] *::highlight(oc-pending-words) { color: transparent; text-shadow: none; }
[data-component="composer-editor"] ~ div.pointer-events-none.absolute.text-v2-text-text-faint { display: none !important; }
[data-slot="session-chat-panel"] [data-slot="user-message-text"] { background: #222225 !important; color: #a8d9ff !important; }
[data-slot="user-message-text"] > span, .oc-user-ink { color: #a8d9ff; -webkit-text-fill-color: currentColor; }
@media (forced-colors: active) { [data-slot="session-chat-panel"] [data-slot="user-message-text"], [data-slot="user-message-text"] > span, .oc-user-ink { color: CanvasText !important; } }
#opencode-touch-live-chat { border: 1px solid #69738155; border-radius: 10px; background: var(--surface-raised-base, Canvas); padding: 6px 10px; margin-block-end: 6px; font-size: 12px; }
#opencode-touch-live-chat header { display: flex; align-items: center; gap: 8px; min-height: 26px; }
#opencode-touch-live-chat header [role="status"] { flex: 1; color: var(--text-weak, inherit); }
#opencode-touch-live-chat header button { min-width: 28px; min-height: 28px; font-size: 18px; }
.oc-live-chat-log { max-height: min(22vh, 150px); overflow: auto; overscroll-behavior: contain; }
.oc-live-chat-log p { display: grid; grid-template-columns: 40px 1fr; gap: 6px; padding-block: 2px; overflow-wrap: anywhere; white-space: pre-wrap; }
.oc-live-chat-log b { color: var(--text-weak, inherit); }
#opencode-touch-live-return { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-block-end: 6px; font-size: 12px; }
#opencode-touch-live-return button { min-height: 28px; padding: 2px 8px; border: 1px solid #3384bd88; border-radius: 5px; }
#opencode-touch-live-return button:disabled { opacity: .5; }
#opencode-touch-live-return [role="status"] { color: var(--text-weak, inherit); }
[data-slot="session-timeline-scroll"] [data-component="text-shimmer"],
[data-slot="session-chat-panel"] [data-component="text-shimmer"] {
  --text-shimmer-peak-color: #24dcff;
  --text-shimmer-sweep: linear-gradient(90deg, transparent calc(50% - var(--text-shimmer-spread)), #376aff 46%, var(--text-shimmer-peak-color) 50%, #1679ff 54%, transparent calc(50% + var(--text-shimmer-spread)));
}
#opencode-touch-voice-modes { display: inline-flex; align-items: center; flex: 0 0 auto; margin-inline-start: 4px; }
#opencode-touch-voice-modes > button { width: 28px; height: 28px; }
#opencode-touch-voice-modes > button[data-active="true"] { color: #24dcff; }
#opencode-touch-voice-menu { position: fixed; inset: auto; margin: 0; box-sizing: border-box; width: 180px; max-width: calc(100vw - 16px); border-radius: 8px; padding: 4px; border: 1px solid var(--border-base, #555); background: var(--surface-raised-base, Canvas); color: var(--text-base, CanvasText); box-shadow: 0 4px 18px #0004; }
#opencode-touch-voice-menu button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 30px; padding: 2px 8px; border-radius: 4px; color: inherit; font: inherit; font-size: 13px; text-align: start; }
#opencode-touch-voice-menu button:hover, #opencode-touch-voice-menu button:focus-visible { background: #1679ff22; }
#opencode-touch-voice-menu button[aria-pressed="true"]::after { content: '✓'; color: #1685dc; }
#opencode-touch-voice-menu [role="status"] { display: block; font-size: 11px; color: var(--text-weak, inherit); padding: 2px 8px; }
#opencode-touch-voice-menu [role="status"]:empty { display: none; }
.oc-model-settings { border-top: 1px solid #71819444; padding: 5px 6px; font-size: 13px; }
#oc-voice-memory { margin:auto; box-sizing:border-box; width:min(92vw,430px); max-height:76dvh; overflow:auto; padding:16px; border:1px solid #60748b; border-radius:12px; color:var(--text-base,CanvasText); background:var(--surface-raised-base,Canvas); }
#oc-voice-memory::backdrop { background:#0008; }
#oc-voice-memory textarea { width:100%; padding:6px; font-size:16px; border:1px solid #7896; color:inherit; background:transparent; }
#oc-voice-memory button { min-height:32px; padding:3px 8px; margin:4px; border:1px solid #7896; border-radius:5px; }
#oc-voice-memory output { display:block; margin:8px 0; font-weight:600; }
.oc-model-settings summary { cursor: pointer; padding-block: 5px; }
.oc-model-settings label { display: block; margin-block: 6px; }
.oc-model-settings select { display: block; width: 100%; min-height: 30px; color: inherit; background: var(--surface-raised-base, Canvas); }
#opencode-touch-voice-menu:has(details[open]) { width: min(330px, calc(100vw - 16px)); max-height: min(60dvh, 440px); overflow-y: auto; left: 8px !important; }
.oc-model-settings input,.oc-model-settings textarea { display:block; width:100%; box-sizing:border-box; padding:5px; font-size:16px; background:var(--surface-raised-base, Canvas); color:inherit; border:1px solid #71819466; border-radius:4px; }
#opencode-touch-voice-menu { padding:8px; max-height:65dvh; overflow-y:auto; overscroll-behavior:contain; }
#opencode-touch-voice-menu .oc-section-title { margin:10px 2px 5px; font-size:11px; line-height:1.4; font-weight:650; letter-spacing:.07em; text-transform:uppercase; color:var(--text-weak,inherit); }
#opencode-touch-voice-menu > .oc-section-title { margin-top:2px; }
#opencode-touch-voice-menu button, #opencode-touch-voice-menu summary { box-sizing:border-box; min-height:40px; margin-block:3px; padding:7px 9px; border:1px solid color-mix(in srgb,currentColor 35%,transparent); border-radius:6px; background:color-mix(in srgb,currentColor 6%,transparent); cursor:pointer; }
#opencode-touch-voice-menu button[aria-pressed="true"] { border-color:#4381b7; background:#2587d524; font-weight:650; }
#opencode-touch-voice-menu button[data-mode]::after { content:'○'; font-size:15px; }
#opencode-touch-voice-menu button[data-mode][aria-pressed="true"]::after { content:'✓'; color:#288ad3; }
#opencode-touch-voice-menu [data-keep-live-open]::after { content:'Aus'; font-size:12px; font-weight:650; margin-inline-start:8px; }
#opencode-touch-voice-menu [data-keep-live-open][aria-pressed="true"]::after { content:'Ein'; }
#opencode-touch-voice-menu [data-memory]::after { content:'›'; font-size:18px; }
#opencode-touch-voice-menu summary { display:flex; align-items:center; justify-content:space-between; font-weight:600; list-style:none; }
#opencode-touch-voice-menu summary::-webkit-details-marker { display:none; }
#opencode-touch-voice-menu summary::after { content:'▾'; }
#opencode-touch-voice-menu details[open] summary::after { content:'▴'; }
#opencode-touch-voice-menu label { display:block; font-size:12px; font-weight:550; margin:8px 0; }
#opencode-touch-voice-menu :is(select,input,textarea) { appearance:auto; margin-top:3px; border:1px solid color-mix(in srgb,currentColor 45%,transparent); border-radius:5px; min-height:40px; padding:6px; font-size:16px; font-weight:400; }
#opencode-touch-voice-menu [data-template-save] { background:#226da6; border-color:#226da6; color:white; }
#opencode-touch-voice-menu button:disabled { opacity:.45; cursor:default; }
#opencode-touch-voice-menu :is(button,summary,select,input,textarea):focus-visible { outline:2px solid #329cde; outline-offset:1px; }
@keyframes oc-summary-pulse { 0%,100% { color: inherit; filter: none; } 52% { color: #29cfff; filter: drop-shadow(0 0 4px #397dff); } }
.oc-summary-speaking { animation: oc-summary-pulse 1.35s ease-in-out infinite; }
[data-slot="text-part-copy-wrapper"]:has(.oc-summary-speaking) { opacity: 1 !important; visibility: visible !important; }
#oc-auto-summary-speaker { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; }
@media (prefers-reduced-motion: reduce) { .oc-summary-speaking { animation: none; color: #29cfff; } }
#opencode-touch-dots i {
  width: 4px; height: 4px; border-radius: 50%; background: #3b82f6;
  animation: oc-bounce 1s infinite;
}
#opencode-touch-dots i:nth-child(2) { animation-delay: .15s; }
#opencode-touch-dots i:nth-child(3) { animation-delay: .3s; }
.oc-live-text { white-space: pre-wrap; word-break: break-word; }
.oc-speaking {
  color: #3b82f6 !important;
  opacity: 1 !important;
  animation: oc-speak-pulse 1.4s infinite;
}
</style>`;

// Same-origin, so the OpenCode CSP (script-src 'self') permits it.
const scriptTag = `<script src="/__opencode_touch/ios.js" data-fluffytouch-features="${features.join(',')}"${expertModel ? ` data-fluffytouch-expert-model="${expertModel}"` : ''} defer></script>`;
const cacheSuffix = '-fluffytouch-v2-' + createHash('sha256').update(JSON.stringify([version,features,expertModel])).digest('hex').slice(0, 10);
const staticFiles = new Map([
  ['/__opencode_touch/ios.js', { file: path.join(__dirname, 'mobile-ios.js'), type: 'text/javascript; charset=utf-8' }],
  ['/__opencode_touch/worklet.js', { file: path.join(__dirname, 'mobile-worklet.js'), type: 'text/javascript; charset=utf-8' }],
]);

function upstreamHeaders(req) {
  const headers = { ...req.headers, 'accept-encoding': 'identity' };
  delete headers[bridgeHeader];
  // HTML must not be replaced by a cached unmodified 304 response.
  if ((req.headers.accept || '').includes('text/html')) {
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }
  return headers;
}

function voiceAuthorized(req) {
  if (!(req.headers.cookie || req.headers.authorization)) return Promise.resolve(false);
  return new Promise(resolve => {
    const check = http.get({ hostname: '127.0.0.1', port: upstreamPort, path: '/api/session?limit=1', headers: {
      host: req.headers.host || 'localhost', cookie: req.headers.cookie || '', authorization: req.headers.authorization || ''
    } }, reply => { reply.resume(); resolve(reply.statusCode === 200); });
    check.setTimeout(3000, () => check.destroy());
    check.on('error', () => resolve(false));
  });
}

function sameVoiceOrigin(req, required) {
  const {host, origin, 'sec-fetch-site':site} = req.headers;
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (!required && !origin) return true;
  if (!host || !origin) return false;
  const scheme = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) ? 'http' : 'https';
  return origin === `${scheme}://${host}`;
}

function bridgeHeaders() {
  return {host:`127.0.0.1:${voicePort}`, [bridgeHeader]:bridgeToken};
}

async function serveVoices(req, res) {
    if (!sameVoiceOrigin(req, false)) { res.writeHead(403).end(); return; }
    if (!await voiceAuthorized(req)) { res.writeHead(401).end(); return; }
    const upstream = http.get({ hostname: '127.0.0.1', port: voicePort, path: '/voices', headers: bridgeHeaders() }, (reply) => {
      res.writeHead(reply.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      reply.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
}

function proxyRequest(req, res) {
  if (req.url === '/__opencode_touch/memory') {
    if (!enabled('memory')) res.writeHead(404).end();
    else serveOptionalMemory(req, res);
    return;
  }
  if (req.url === '/__opencode_touch/verlaufslog') {
    if (!enabled('history')) res.writeHead(404).end();
    else void serveHistoryLog(req,res,upstreamPort,getHistoryLog);
    return;
  }
  if (req.method === 'GET' && req.url === '/__opencode_touch/voices') {
    if (!enabled('read-aloud')) res.writeHead(404).end();
    else void serveVoices(req, res).catch(() => res.destroy());
    return;
  }
  if (req.url === '/__opencode_touch_health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ service: 'oc-fluffytouch-proxy-v2', upstreamPort, profile, voicePort:hasAudio ? voicePort : null, pairId }));
    return;
  }
  const staticFile = req.method === 'GET'
    ? staticFiles.get(new URL(req.url, 'http://localhost').pathname)
    : null;
  if (staticFile) {
    if (staticFile.file.endsWith('mobile-worklet.js') && !hasAudio) { res.writeHead(404).end(); return; }
    let body;
    try {
      body = fs.readFileSync(staticFile.file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'content-type': staticFile.type, 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  const upstream = http.request({
    host: '127.0.0.1', port: upstreamPort, path: req.url,
    method: req.method, headers: upstreamHeaders(req),
  }, (response) => {
    const isHtml = req.method === 'GET' && response.statusCode === 200 &&
      /^text\/html(?:;|$)/i.test(response.headers['content-type'] || '') &&
      !response.headers['content-encoding'];
    const isWorker = req.method === 'GET' && response.statusCode === 200 &&
      new URL(req.url, 'http://localhost').pathname === '/sw.js' &&
      !response.headers['content-encoding'];
    if (!isHtml && !isWorker) {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
      return;
    }
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) response.destroy(new Error('HTML too large'));
      else chunks.push(chunk);
    });
    response.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    response.on('end', () => {
      const content = Buffer.concat(chunks).toString('utf8');
      let updated;
      if (isWorker) {
        // Workbox precaches index.html with a revision and an integrity hash.
        // Its HTML is modified above, so give it a new cache key and remove only
        // that obsolete hash; all other OpenCode assets keep their integrity.
        const indexEntry = /(\{url:["'](?:\/)?index\.html["'],revision:["'])([^"']+)(["'],integrity:["'])[^"']+(["']\})/;
        if (!indexEntry.test(content)) {
          res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          res.end('Unsupported OpenCode service worker: index cache entry not found.');
          return;
        }
        updated = `self.addEventListener('install',()=>self.skipWaiting());\n` +
          `self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));\n` +
          content.replace(indexEntry, (_match, prefix, revision) => `${prefix}${revision}${cacheSuffix}"}`);
      } else {
        updated = content.replace(/<\/head\s*>/i, `${css}${scriptTag}</head>`);
        // iOS PWA and Safari sometimes zoom editable controls even at 16px,
        // depending on font/zoom settings. Limit focus zoom on iPhone/iPad;
        // browsers may differ in whether they still permit pinch zoom.
        if (/iPhone|iPad|iPod/i.test(req.headers['user-agent'] || '')) {
          updated = updated.replace(/(<meta\s+name=["']viewport["']\s+content=["'])([^"']*)(["'])/i,
            (_match, start, value, end) => `${start}${value}, maximum-scale=1${end}`);
        }
      }
      const body = Buffer.from(updated);
      const headers = { ...response.headers, 'content-length': body.length, 'cache-control': 'no-store' };
      delete headers.etag;
      delete headers['last-modified'];
      delete headers['transfer-encoding'];
      if (isHtml) headers.vary = headers.vary ? `${headers.vary}, User-Agent` : 'User-Agent';
      res.writeHead(response.statusCode, headers);
      res.end(body);
    });
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function serveOptionalMemory(req, res) {
  const unavailable = () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(503, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify({error:'Voice-Erinnerungen nicht verfügbar. Prüfe die Installation von Node.js und js-tiktoken.'}));
  };
  try { void require('./voice-memory.cjs').serveMemory(req,res,upstreamPort).catch(unavailable); }
  catch { unavailable(); }
}

const server = http.createServer(proxyRequest);
server.on('upgrade', async (req, clientSocket, head) => {
  clientSocket.on('error', () => {});
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const voicePath = pathname === '/__opencode_touch/asr' ? '/asr' : pathname === '/__opencode_touch/speak' ? '/speak' : null;
  let headers = {...req.headers};
  delete headers[bridgeHeader];
  if (voicePath) {
    const reject = status => clientSocket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (!enabled(voicePath === '/asr' ? 'transcript' : 'read-aloud')) { reject('404 Not Found'); return; }
    if (!sameVoiceOrigin(req, true)) { reject('403 Forbidden'); return; }
    if (!await voiceAuthorized(req)) { reject('401 Unauthorized'); return; }
    if (clientSocket.destroyed) return;
    headers = bridgeHeaders();
    for (const name of ['connection','upgrade','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
  }
  const targetPort = voicePath ? voicePort : upstreamPort;
  const upstream = http.request({
    host: '127.0.0.1', port: targetPort, path: voicePath || req.url,
    method: req.method, headers,
  });
  upstream.on('upgrade', (response, socket, upstreamHead) => {
    const status = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`;
    const raw = response.rawHeaders.reduce((out, value, index) =>
      out + (index % 2 === 0 ? `${value}: ` : `${value}\r\n`), '');
    clientSocket.write(`${status}${raw}\r\n`);
    if (upstreamHead.length) clientSocket.write(upstreamHead);
    if (head.length) socket.write(head);
    socket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => socket.destroy());
    socket.pipe(clientSocket).pipe(socket);
  });
  upstream.on('response', (response) => {
    clientSocket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
    response.resume();
  });
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
  upstream.end();
});
server.listen(listenPort, '127.0.0.1', () => {
  if (enabled('history')) try { getHistoryLog(); } catch { console.error('Verlaufslog konnte nicht geöffnet werden.'); }
});
