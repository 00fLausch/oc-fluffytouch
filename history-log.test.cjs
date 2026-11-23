'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {HistoryLog,serveHistoryLog} = require('./history-log.cjs');

function temp(t) {
  const preferred=path.join(process.env.LOCALAPPDATA || os.tmpdir(),'Temp','opencode');
  const dir=fs.mkdtempSync(path.join(fs.existsSync(preferred)?preferred:os.tmpdir(),'oc-touch-log-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}

const rows = file => fs.readFileSync(file,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));

async function listen(t,handler) {
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return server.address().port;
}

test('local log joins both chats by session and time, retries do not duplicate, and private data stays out',async t=>{
  const dir=temp(t), baseTime=Date.now();
  const log=new HistoryLog(dir,{now:()=>baseTime});
  const reads=[];
  const native=await listen(t,(req,res)=>{
    reads.push(req.url);
    if (req.headers.cookie!=='session=test' || !req.url.startsWith('/api/session/ses_test')) {res.writeHead(401);res.end();return;}
    res.setHeader('Content-Type','application/json');
    if (req.url.includes('cursor=earlier')) return res.end(JSON.stringify({data:[
      {type:'user',id:'msg_user',time:{created:baseTime+5},text:'Hauptchat-Frage'},
      {type:'user',id:'msg_old',time:{created:baseTime-5},text:'Vor Beginn nicht übernehmen'}
    ]}));
    res.end(JSON.stringify({data:[
      {type:'assistant',id:'msg_inflight',time:{created:baseTime+30},content:[{type:'text',text:'Noch nicht fertig'}]},
      {type:'assistant',id:'msg_answer',time:{created:baseTime+8,completed:baseTime+25},model:{providerID:'test',id:'coding'},
        content:[{type:'text',text:'Coding-Antwort'}, {type:'reasoning',text:'HiddenThought'},
          {type:'tool',name:'test-tool',state:{output:'HiddenToolOutput'}}]}
    ],cursor:{next:'earlier'}}));
  });
  let activeLog=log;
  const touch=await listen(t,(req,res)=>void serveHistoryLog(req,res,native,()=>activeLog));
  const url=`http://127.0.0.1:${touch}/__opencode_touch/verlaufslog`;
  const headers={'Content-Type':'application/json',Origin:`https://127.0.0.1:${touch}`,'Tailscale-User-Login':'paired@example.invalid',Cookie:'session=test'};
  const data={session:'ses_test',syncMain:true,entries:[
    {id:'v-user',event:'user',at:baseTime+2,text:'Live-Frage\nzweite Zeile',chat:'main',turnId:'turn1'},
    {id:'v-reply',event:'assistant',at:baseTime+3,text:'Live-Antwort',turnId:'turn1'},
    {id:'receipt',event:'handoff.admitted',at:baseTime+4,messageId:'msg_user',state:'queue'},
    {id:'private',event:'private',at:baseTime+4,text:'HiddenMemory'},
    {id:'private-change',event:'memory.saved',at:baseTime+4,text:'HiddenMemory'}
  ]};
  const post=(headers,body=data)=>fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await fetch(url)).status,405);
  assert.equal((await post({...headers,Origin:'https://elsewhere.invalid'})).status,403);
  assert.equal((await post({...headers,'Tailscale-User-Login':''})).status,403);
  assert.equal((await post({...headers,Cookie:''})).status,401);
  assert.equal((await post(headers,{...data,session:'../../not-a-session'})).status,400);
  assert.equal(rows(log.file).length,1);
  assert.equal((await post(headers)).status,200);
  activeLog=new HistoryLog(dir,{now:()=>baseTime+100});
  assert.equal((await post(headers)).status,200);
  const recorded=rows(log.file);
  assert.equal(recorded.length,8);
  assert.equal(recorded.find(v=>v.id==='v-user').chat,'live');
  assert.equal(recorded.find(v=>v.id==='v-user').text,'Live-Frage\nzweite Zeile');
  assert.equal(recorded.find(v=>v.id==='msg_user').chat,'main');
  assert.deepEqual(recorded.find(v=>v.id==='msg_answer').tools,['test-tool']);
  assert.equal(recorded.find(v=>v.id==='receipt').messageId,'msg_user');
  assert.equal(Date.parse(recorded.find(v=>v.id==='msg_answer').time),baseTime+25);
  assert.ok(recorded.every(v=>Number.isFinite(Date.parse(v.recorded))));
  assert.ok(reads.some(v=>v.includes('cursor=earlier')));
  assert.doesNotMatch(fs.readFileSync(log.file,'utf8'),/Hidden|Vor Beginn|Noch nicht fertig|session=test|paired@/);
});

test('rotation bounds the file size and retains recent events',t=>{
  const log=new HistoryLog(temp(t),{maxBytes:950});
  for (let i=0;i<12;i++) log.append('ses_test',[{at:Date.now(),chat:'live',event:'user',id:`v${i}`,text:'Test '.repeat(32)}]);
  assert.ok([log.file,log.previous].every(file=>fs.statSync(file).size<=950));
  assert.equal(rows(log.file).at(-1).id,'v11');
  const before=fs.statSync(log.file).size;
  log.append('ses_test',[{at:Date.now(),chat:'live',event:'user',id:rows(log.previous)[0].id,text:'Retry'}]);
  assert.equal(fs.statSync(log.file).size,before);
});
