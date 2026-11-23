'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomBytes } = require('node:crypto');

test('proxy preserves streaming, auth and websocket while modifying only HTML and worker', {timeout:10000}, async (t) => {
  const token=randomBytes(32).toString('hex');
  let nativeBridgeHeader, voicesHeaders;
  const backend = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end('const precache=[{url:"index.html",revision:"old",integrity:"sha256-abc"},{url:"asset.js",revision:"x",integrity:"sha256-def"}];');
    } else if (req.url === '/api/event') {
      nativeBridgeHeader = req.headers['x-fluffytouch-bridge-token'];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 30);
    } else if (req.url === '/api/session?limit=1' && req.headers.cookie === 'session=valid') {
      res.end('{"data":[]}');
    } else if (req.url === '/api/session') {
      res.writeHead(401, { 'set-cookie': 'session=stub; HttpOnly; SameSite=Lax' });
      res.end('unauthorized');
    } else if (req.url === '/api/session?limit=1') {
      res.writeHead(401).end();
    } else {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "style-src 'unsafe-inline'" });
      res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body>original</body></html>');
    }
  });
  backend.on('upgrade', (_req, socket, head) => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => backend.close());
  const voice = http.createServer((req, res) => {
    voicesHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  let voicePath = null, voiceHeaders;
  voice.on('upgrade', (req, socket) => {
    voicePath = req.url;
    voiceHeaders = req.headers;
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.write('voice-ok');
  });
  voice.listen(0, '127.0.0.1');
  await once(voice, 'listening');
  t.after(() => voice.close());
  const reserved = net.createServer();
  reserved.listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const preferred = path.join(process.env.LOCALAPPDATA || os.tmpdir(),'Temp','opencode');
  const logDir = fs.mkdtempSync(path.join(fs.existsSync(preferred) ? preferred : os.tmpdir(),'oc-touch-proxy-'));
  const sockets=[];
  const child = spawn(process.execPath, [
    path.join(__dirname, 'mobile-proxy.cjs'),
    String(backend.address().port),
    String(port),
    String(voice.address().port),
  ], { stdio: 'ignore', env:{...process.env,OPENCODE_TOUCH_LOG_DIR:logDir,OC_FLUFFYTOUCH_FEATURES:'transcript,read-aloud,history',OC_FLUFFYTOUCH_BRIDGE_TOKEN:token} });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) { const exited=once(child,'exit'); child.kill(); await exited; }
    fs.rmSync(logDir,{recursive:true,force:true});
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/__opencode_touch_health`); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /unsafe-inline/);
  const htmlText = await html.text();
  assert.match(htmlText, /opencode-touch-ios-fix[\s\S]*font-size: 16px !important/);
  assert.match(htmlText, /<script src="\/__opencode_touch\/ios\.js" data-fluffytouch-features="transcript,read-aloud,history" defer><\/script>/);
  assert.equal(htmlText.includes(token),false);
  assert.doesNotMatch(htmlText, /maximum-scale=1/);
  const ios = await fetch(base, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } });
  assert.match(await ios.text(), /initial-scale=1, maximum-scale=1/);
  const inject = await fetch(`${base}/__opencode_touch/ios.js`);
  assert.equal(inject.status, 200);
  assert.match(inject.headers.get('content-type'), /text\/javascript/);
  const injectText = await inject.text();
  assert.match(injectText, /opencode-touch-mic/);
  assert.match(injectText, /__opencode_touch\/speak/);
  const worklet = await fetch(`${base}/__opencode_touch/worklet.js`);
  assert.equal(worklet.status, 200);
  assert.match(await worklet.text(), /capture-processor[\s\S]*playback-processor/);
  const sw = await (await fetch(`${base}/sw.js`)).text();
  assert.match(sw, /revision:"old-fluffytouch-v2-[a-f0-9]{10}"/);
  assert.match(sw, /asset\.js",revision:"x",integrity:"sha256-def"/);
  assert.match(sw, /self\.skipWaiting/);
  const auth = await fetch(`${base}/api/session`);
  assert.equal(auth.status, 401);
  assert.match(auth.headers.get('set-cookie'), /session=stub/);
  assert.equal(await auth.text(), 'unauthorized');
  assert.equal((await fetch(`${base}/__opencode_touch/voices`)).status,401);
  assert.equal((await fetch(`${base}/__opencode_touch/voices`,{headers:{cookie:'session=valid',origin:'https://unrelated.invalid'}})).status,403);
  assert.equal((await fetch(`${base}/__opencode_touch/voices`,{headers:{cookie:'session=valid'}})).status,200);
  assert.equal(voicesHeaders['x-fluffytouch-bridge-token']===token,true);
  assert.equal(voicesHeaders.cookie,undefined);
  assert.equal((await fetch(`${base}/__opencode_touch/verlaufslog`)).status,405);
  assert.match(fs.readFileSync(path.join(logDir,'verlaufslog.jsonl'),'utf8'),/log\.started/);
  const events = await fetch(`${base}/api/event`,{headers:{'x-fluffytouch-bridge-token':'unused-header'}});
  assert.equal(nativeBridgeHeader,undefined);
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /first/);
  assert.equal(first.done, false);
  assert.match(Buffer.from((await reader.read()).value).toString(), /second/);
  const socket = net.connect(port, '127.0.0.1');
  sockets.push(socket);
  await once(socket, 'connect');
  socket.write('GET /pty HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [handshake] = await once(socket, 'data');
  assert.match(handshake.toString(), /101 Switching Protocols/);
  socket.write('test');
  const [echo] = await once(socket, 'data');
  assert.equal(echo.toString(), 'test');

  const voiceSocket = net.connect(port, '127.0.0.1');
  sockets.push(voiceSocket);
  await once(voiceSocket, 'connect');
  voiceSocket.write(`GET /__opencode_touch/asr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${base}\r\nCookie: session=valid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  const [voiceHandshake] = await once(voiceSocket, 'data');
  let voiceReply = voiceHandshake.toString();
  assert.match(voiceReply, /101 Switching Protocols/);
  if (!/voice-ok/.test(voiceReply)) {
    const [voicePayload] = await once(voiceSocket, 'data');
    voiceReply += voicePayload.toString();
  }
  assert.match(voiceReply, /voice-ok/);
  assert.equal(voicePath, '/asr');
  assert.equal(voiceHeaders['x-fluffytouch-bridge-token']===token,true);
  assert.equal(voiceHeaders.host,`127.0.0.1:${voice.address().port}`);
  for (const header of ['cookie','authorization','origin']) assert.equal(voiceHeaders[header],undefined);
});

test('only selected modules are exposed; audio namespace requires native login and matching origin', {timeout:5000}, async (t) => {
  const backend = http.createServer((_req,res) => { res.setHeader('content-type','text/html'); res.end('<html><head></head><body></body></html>'); });
  backend.listen(0,'127.0.0.1'); await once(backend,'listening');
  const reserved = net.createServer();
  reserved.listen(0,'127.0.0.1'); await once(reserved,'listening');
  const port=reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const logDir=path.join(os.tmpdir(),`fluffytouch-disabled-${require('node:crypto').randomUUID()}`);
  const child=spawn(process.execPath,[path.join(__dirname,'mobile-proxy.cjs'),String(backend.address().port),String(port),String(backend.address().port)], {
    stdio:'ignore',env:{...process.env,OC_FLUFFYTOUCH_FEATURES:'transcript',OPENCODE_TOUCH_LOG_DIR:logDir,OC_FLUFFYTOUCH_BRIDGE_TOKEN:randomBytes(32).toString('hex')},
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited=once(child,'exit'); child.kill(); await exited; }
    backend.close();
  });
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<80;i++) { try { await fetch(`${base}/__opencode_touch_health`);break; } catch { await new Promise(r=>setTimeout(r,20)); } }
  assert.match(await (await fetch(base)).text(),/data-fluffytouch-features="transcript"/);
  for(const route of ['voices','memory','verlaufslog']) assert.equal((await fetch(`${base}/__opencode_touch/${route}`)).status,404);
  assert.equal(fs.existsSync(logDir),false);
  async function upgrade(route,origin) {
    const socket=net.connect(port,'127.0.0.1');
    try {
      await once(socket,'connect');
      socket.write(`GET /__opencode_touch/${route} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      return (await once(socket,'data'))[0].toString();
    } finally { socket.destroy(); }
  }
  assert.match(await upgrade('speak',base),/^HTTP\/1.1 404/);
  assert.match(await upgrade('asr','https://invalid.example'),/^HTTP\/1.1 403/);
  assert.match(await upgrade('asr',base),/^HTTP\/1.1 401/);
});

test('a missing optional tokenizer yields 503 and leaves the proxy up', {timeout:8000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fluffytouch-memory-test-'));
  const preload=path.join(dir,'missing-tokenizer.cjs');
  fs.writeFileSync(preload,"const m=require('node:module'), load=m._load; m._load=function(id,...args){if(id==='js-tiktoken')throw new Error('missing optional test module');return load.call(this,id,...args)};");
  const backend=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<html><head></head><body>fixture</body></html>');});
  backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const reserved=net.createServer().listen(0,'127.0.0.1');await once(reserved,'listening');
  const port=reserved.address().port;await new Promise(r=>reserved.close(r));
  const child=spawn(process.execPath,['--require',preload,path.join(__dirname,'mobile-proxy.cjs'),String(backend.address().port),String(port)],{
    stdio:'ignore',env:{...process.env,OC_FLUFFYTOUCH_FEATURES:'transcript,read-aloud,live,memory',OC_FLUFFYTOUCH_BRIDGE_TOKEN:randomBytes(32).toString('hex')},
  });
  t.after(async ()=>{
    if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}
    backend.close();fs.unlinkSync(preload);fs.rmdirSync(dir);
  });
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<80;i++){try{await fetch(`${base}/__opencode_touch_health`);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  const missing=await fetch(`${base}/__opencode_touch/memory`);
  assert.equal(missing.status,503);assert.match((await missing.json()).error,/nicht verfügbar/);
  assert.equal((await fetch(`${base}/__opencode_touch_health`)).status,200);
});
