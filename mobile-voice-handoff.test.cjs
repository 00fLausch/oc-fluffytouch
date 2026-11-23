'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./mobile-ios.js'), 'utf8');

function setup(fetch, storage = {getItem: () => 'session'}, timer = ()=>{}, speak = async()=>true, {stubRole = true, expert = null} = {}) {
  let role;
  const request = (url, opts) => {
    if (stubRole && url.endsWith('/instructions/entries')) return ok(role ? [role] : []);
    if (stubRole && url.endsWith('/instructions/entries/opencode-touch-live-role')) {
      assert.equal(opts.method,'PUT');
      role = {key:'opencode-touch-live-role',value:JSON.parse(opts.body).value};
      return ok(role);
    }
    return fetch(url, opts);
  };
  const sandbox = {
    fetch:request, crypto:require('node:crypto').webcrypto, setTimeout:timer, clearTimeout() {}, AbortController, AbortSignal, localStorage: storage, location: { pathname: '/session/ses_test' }, navigator:{},
    document: { currentScript:{getAttribute:name=>name==='data-fluffytouch-expert-model'?expert:null}, querySelector: () => null, getElementById: () => null, addEventListener() {}, readyState: 'loading' },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
  };
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `
    globalThis.testApi = { consultExpert, handleVoiceMemory, captureFrame, listenAgain, setMic:fn=>{startRecording=fn}, play:(...args)=>playVoiceReply(...args), handleSettingTurn, settingRequest, requestsTaskContinuation, decideLiveTurn, handoffTask, taskOutcome, conversationContext, describeWork, memoryCommand, summarizeHandoff, createLiveThread, unsentTurns, toggleVoiceMode, mode:()=>voiceMode, generateVoice, setPlayback: fn => {playVoiceReply=fn}, setMode: (mode) => { voiceMode = mode; } };
    globalThis.testApi.followTimeline = (...args) => followTimeline(...args);
    globalThis.testApi.transcribe = (mode, text) => {
      const state = recorder = { conversation: mode };
      stopRecording = async () => { recorder = null; return text; };
      return finishConversation(mode, state);
    };
    startSpeaking = (...args)=>testSpeak(...args);
  })();`), Object.assign(sandbox,{testSpeak:speak}));
  return sandbox.testApi;
}

const ok = data=>({ok:true,json:async()=>({data})});
function liveThread(api, history = [], sent = 0) {
  return Object.assign(api.createLiveThread(),{history,sent});
}

test('quoted clarification of model scope cannot write a setting', async () => {
  const replies = [];
  const api = setup(async url => assert.fail(`unexpected request: ${url}`));
  const mode = {kind:'live',session:'ses_test',history:[],abort:new AbortController(),pendingSetting:{kind:'ambiguous',target:'Nova',expires:Date.now()+60000}};
  api.setMode(mode);
  api.setPlayback(async (_, text) => { replies.push(text); return true; });
  assert.ok(await api.handleSettingTurn(mode, {frage:'„im Hauptchat“'}));
  assert.match(replies[0], /meinst du genau/);
  assert.equal(mode.pendingSetting.kind,'ambiguous');
});

test('spoken voice numbers and formats are matched against the catalog before acknowledgement',async()=>{
  let voice='probe.wav',persist=true;const replies=[];
  const api=setup(async url=>{assert.equal(url,'/__opencode_touch/voices');return {ok:true,json:async()=>({voices:['demo4.flac','demo4.wav']})}}, {getItem:()=>voice,setItem:(key,v)=>{assert.equal(key,'oc-touch-voice');if(persist)voice=v}});
  const mode={session:'ses_test',abort:new AbortController()};api.setMode(mode);api.setPlayback(async(_,text)=>replies.push([voice,text]));
  const say=frage=>api.handleSettingTurn(mode,{frage});
  await say('Du sollst auf Demo 4 umstellen');assert.equal(voice,'probe.wav');assert.match(replies.at(-1)[1],/Welche/);
  await say('Wave');assert.deepEqual(replies.at(-1),['demo4.wav','Jetzt aktiv: Stimme demo4.wav.']);
  voice='probe.wav';await say('Stell auf Demo4 Wave um');assert.equal(voice,'demo4.wav');
  voice='probe.wav';persist=false;await say('Stell die Stimme auf Demo vier WAV um');assert.equal(voice,'probe.wav');assert.match(replies.at(-1)[1],/nicht bestätigt/);
});

test('named WAV wishes stay local, including with an outstanding task offer',async()=>{
  let voice='demo4.wav'; const spoken=[];
  const api=setup(async url=>{assert.equal(url,'/__opencode_touch/voices');return {ok:true,json:async()=>({voices:['probe.wav','probe 1.flac']})};},{getItem:()=>voice,setItem:(k,v)=>{assert.equal(k,'oc-touch-voice');voice=v}});
  const mode={session:'ses_test',abort:new AbortController()};api.setMode(mode);api.setPlayback(async(_,text)=>spoken.push([voice,text]));
  for (const frage of ['Nimm Probe WAV','Ich möchte Probe Wave als Stimme','Stell Probe WAV ein','Probe WAV einstellen']) {
    voice='demo4.wav';mode.offer='Einen Auftrag starten';const turn={frage};
    assert.equal(await api.handleSettingTurn(mode,turn),true);
    assert.equal(turn.voicePrivate,true);assert.equal(mode.offer,null);
    assert.deepEqual(spoken.at(-1),['probe.wav','Jetzt aktiv: Stimme probe.wav.']);
  }
});

test('a bare selection needs a catalog match; spoken hyphen and file variants are resolved locally', async()=>{
  const voices=['morgen-klar.wav','morgen-sanft.ogg','morgen-sanft.wav','morgen_neu.flac'];
  let selected='probe.wav'; const replies=[];
  const api=setup(async url=>{assert.equal(url,'/__opencode_touch/voices');return {ok:true,json:async()=>({voices})}}, {getItem:()=>selected,setItem:(_,v)=>selected=v});
  const mode={session:'ses_test',abort:new AbortController()};api.setMode(mode);api.setPlayback(async(_,text)=>replies.push(text));
  assert.equal(await api.handleSettingTurn(mode,{frage:'Morgen sanft'}),false);
  assert.equal(await api.handleSettingTurn(mode,{frage:'Nimm den kurzen Weg'}),false);
  for(const frage of ['Nimm Morgen sanft','Verwende Morgen minus sanft']){
    assert.equal(await api.handleSettingTurn(mode,{frage}),true);assert.equal(selected,'probe.wav');
    assert.match(replies.at(-1),/morgen-sanft\.ogg.*morgen-sanft\.wav/);assert.doesNotMatch(replies.at(-1),/klar|neu/);
  }
  await api.handleSettingTurn(mode,{frage:'WAV'});assert.equal(selected,'morgen-sanft.wav');
});

test('detailed queue preserves the instruction; ordinary settings talk cannot become execution',async()=>{
  const api=setup(async url=>({ok:true,json:async()=>({data:url.endsWith('/active')?{}:{text:'{"intent":"resume","reply":""}'}})}));
  const mode={session:'ses_test',thread:liveThread(api),abort:new AbortController()};api.setMode(mode);
  const task='Prüfe die Sicherheitsgrenzen. Keine früheren Aufgaben wiederholen.';
  for(const lead of ['Folgeauftrag: ','Übergib den Auftrag: ']) {
    const follow=await api.decideLiveTurn(mode,[],lead+task);assert.equal(follow.queue,true);assert.equal(follow.task,task);
  }
  const mention=await api.decideLiveTurn(mode,[],'Das Modell gefällt mir.');assert.equal(mention.resume,false);assert.equal(mention.clarify,true);
});

test('memory inventory reads the voice store only and marks the reply private',async()=>{
  const calls=[];const api=setup(async(url,opts)=>{calls.push([url,opts.method||'GET']);return {ok:true,json:async()=>({items:[{text:'Testnotiz'}]})}});
  let reply;const mode={};api.setMode(mode);api.setPlayback(async(_,s)=>reply=s);
  const turn={frage:'Was hast du dir gemerkt?'};assert.equal(await api.handleVoiceMemory(mode,[],turn),true);assert.equal(turn.voicePrivate,true);assert.equal(reply,'Testnotiz');assert.deepEqual(calls,[['/__opencode_touch/memory','GET']]);
});

test('conversation reads backwards across pages up to the last completed compaction', async () => {
  const urls = [];
  const pages = [
    { data: [{ type: 'assistant', content: [{ type: 'text', text: 'Fertig' }] }, { type: 'compaction', status: 'failed' }], cursor: { next: 'abc+1' } },
    { data: [{ type: 'user', text: 'Bitte ändern' }, { type: 'compaction', status: 'completed', summary: 'Frühere Entscheidung', recent: 'Letztes Detail' }, { type: 'user', text: 'Nicht doppelt laden' }], cursor: { next: 'older' } },
  ];
  const api = setup(async url => { urls.push(url); return { ok: true, json: async () => pages.shift() }; });
  const context = await api.conversationContext('ses_test');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /cursor=abc%2B1/);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), [{ rolle: 'Komprimierung', zusammenfassung: 'Frühere Entscheidung', letzterAbschnitt: 'Letztes Detail' }, { rolle: 'user', text: 'Bitte ändern' }, { rolle: 'assistant', text: 'Fertig' }]);
});

test('active settings questions and an ambiguous model follow-up are consumed directly', async()=>{
  const calls=[],spoken=[], api=setup(async url=>{calls.push(url);assert.equal(url,'/api/session/ses_test');return {ok:true,json:async()=>({data:{model:{providerID:'p',id:'m',variant:'high'}}})}}, {getItem:()=> 'probe.wav'});
  const mode={session:'ses_test',abort:new AbortController()};api.setMode(mode);api.setPlayback(async(_,s)=>spoken.push(s));
  for(const [frage,expected] of [['Welches Modell ist im Hauptchat aktiv?',/p\/m/],['Welche Thinking-Stufe ist eingestellt?',/high/],['Welche Stimme ist aktiv?',/probe\.wav/]]) {
    assert.equal(await api.handleSettingTurn(mode,{frage}),true);assert.match(spoken.at(-1),expected);
  }
  mode.pendingSetting={kind:'main',names:['Nova (a)','Nova (b)'],expires:Date.now()+50000};assert.equal(await api.handleSettingTurn(mode,{frage:'Dann nimm Nova'}),true);assert.match(spoken.at(-1),/Nova \(a\).*Nova \(b\)/);assert.equal(calls.length,2);
});

test('explicit memory confirms only matching persisted entry; retry reuses its ID',async()=>{
  const writes=[],spoken=[];const api=setup(async(url,opts)=>{assert.equal(url,'/__opencode_touch/memory');const item=JSON.parse(opts.body);writes.push(item);return {ok:true,json:async()=>({items:writes.length===1?[]:[item]})}});
  const mode={};api.setMode(mode);api.setPlayback(async(_,s)=>spoken.push(s));const say=frage=>api.handleVoiceMemory(mode,[],{frage});
  assert.equal(await say('Merk dir: Ich mag kurze Sätze.'),true);assert.equal(writes.length,0);
  assert.equal(await say('Ja, speichern'),true);assert.match(spoken.at(-1),/nicht bestätigt/);
  assert.equal(await say('Ja, speichern'),true);assert.equal(writes[0].id,writes[1].id);assert.match(spoken.at(-1),/gemerkt/);
});

test('a setting-list follow-up allows an unrelated turn through and never writes a setting',async()=>{
  const api=setup(()=>{throw Error('unexpected write')});const mode={session:'ses_test',pendingSetting:{kind:'budget',names:['high'],expires:Date.now()+50000}};api.setMode(mode);
  assert.equal(await api.handleSettingTurn(mode,{frage:'Wie weit ist der Auftrag?'}),false);assert.equal(mode.pendingSetting,null);
});

test('marking the previous turn private removes its pending note; cancelling stores nothing',async()=>{
  const api=setup(()=>{throw Error('unexpected persistence')});
  const prev={frage:'Privater Satz',note:'private'}, thread=liveThread(api,[{frage:'Öffentlicher Satz',note:'public'},prev]), mode={thread};
  api.setMode(mode);api.setPlayback(async()=>true);await api.handleVoiceMemory(mode,thread.history,{frage:'Merk dir das.'});
  assert.equal(prev.voicePrivate,true);assert.deepEqual(Array.from(api.unsentTurns(thread),t=>t.note),['public']);
  await api.handleVoiceMemory(mode,[],{frage:'Abbrechen'});assert.equal(mode.memoryPending,null);
});

test('auto memory requires per-conversation opt-in and reuses the existing entry on repetition',async()=>{
  let items=[],writes=0;const api=setup(async(_,opts)=>{if(opts.method==='POST'){items.push(JSON.parse(opts.body));writes++}return {ok:true,json:async()=>({items})}});
  const mode={};api.setMode(mode);api.setPlayback(async()=>true);const pref='Ich bevorzuge kurze Antworten.';
  const say=frage=>api.handleVoiceMemory(mode,[],{frage});assert.equal(await say(pref),false);await say('Aktiviere automatische Erinnerungen');await say(pref);await say(pref);assert.equal(writes,1);
  await say('Stoppe automatische Erinnerungen');assert.equal(await say(pref),false);
});

test('microphone gate rejects silence and clicks, preserves onset, and emits a single pause boundary',()=>{
  const api=setup(()=>{});const sent=[];const m={conversation:{},ctx:{sampleRate:48000},ws:{send:b=>sent.push(b)}};
  const quiet=new Float32Array(1024),tone=Float32Array.from(quiet,(_,i)=>0.04*Math.sin(2*Math.PI*220*i/48000));
  for(let i=0;i<40;i++)api.captureFrame(m,quiet);api.captureFrame(m,tone);for(let i=0;i<40;i++)api.captureFrame(m,quiet);assert.equal(sent.length,0);
  for(let i=0;i<12;i++)api.captureFrame(m,tone);assert.ok(sent.length>=12);let ends=0;for(let i=0;i<100;i++)if(api.captureFrame(m,quiet)==='end')ends++;assert.equal(ends,1);
});

test('dictation sends quiet speech and the final short buffer without the Live gate',()=>{
  const api=setup(), sent=[], state={ws:{send:b=>sent.push(b)}};
  const quietSpeech=new Float32Array(1024).fill(0.001), tail=new Float32Array(13).fill(-0.001);
  assert.equal(api.captureFrame(state,quietSpeech),'audio');
  assert.equal(api.captureFrame(state,tail),'audio');
  assert.deepEqual(sent,[quietSpeech.buffer,tail.buffer]);
});

test('explicit model change applies directly; ambiguous scope asks first and cancellation writes nothing', async () => {
  const model={id:'demo-sol-2',providerID:'fixture',name:'Demo Sol 2'};
  const writes=[], spoken=[];
  const api=setup(async(url,options)=>{
    if(url==='/api/model') return {ok:true,json:async()=>({data:[model]})};
    if(url.endsWith('/model')){writes.push(JSON.parse(options.body));return {ok:true};}
    return {ok:true,json:async()=>({data:{model}})};
  });
  const mode={session:'ses_test',abort:new AbortController()};api.setMode(mode);api.setPlayback(async(_,text)=>spoken.push(text));
  const say=frage=>api.handleSettingTurn(mode,{frage});
  assert.equal(await say('Ich mag Sol.'),false);
  assert.equal(await say('Wechsle das Modell auf Sol'),true);
  assert.match(spoken.at(-1),/Wo soll das Modell wechseln/);assert.equal(writes.length,0);
  await say('Nein');await say('Ja');assert.equal(writes.length,0);
  await say('Wechsle bitte das Modell im Hauptchat auf Demo Sol 2.');assert.equal(writes.length,1);
  assert.deepEqual(writes[0],{model:{providerID:'fixture',id:'demo-sol-2'}});
  assert.match(spoken.at(-1),/Jetzt aktiv: Modell im Hauptchat Demo Sol 2/);
  assert.equal(api.settingRequest('Wechsel nicht die Stimme zu Probe'),null);
  await say('Wechsel das Modell auf Sol');await say('Im Hauptchat');assert.equal(writes.length,2);
});

test('only clear German continuation commands cause a handoff', () => {
  const { requestsTaskContinuation: hasCommand } = setup();
  for (const line of ['Mach los!', 'Mach jetzt weiter.', 'Mach bitte mit der Aufgabe weiter!', 'Setz die aktuelle Aufgabe fort.']) assert.ok(hasCommand(line), line);
  for (const line of ['Mach nicht weiter.', 'Kannst du weitermachen?', '„Mach weiter“', 'Mach weiter?']) assert.ok(!hasCommand(line), line);
});

test('speaking a result never adds background notes or consumes unsent context', async () => {
  const requests=[], played=[];
  const api=setup(async url=>{requests.push(url);assert.fail(url)});
  const thread=liveThread(api,[{frage:'Nur mobil'}]);
  const mode={session:'ses_test',abort:new AbortController(),thread,history:thread.history,pendingResult:{id:'msg_test',text:'Fertig'}};
  api.setMode(mode);api.setPlayback(async (_,text)=>{played.push(text);return true;});api.setMic(async()=>({}));
  await api.listenAgain(mode);
  assert.deepEqual(played,['Fertig']);assert.deepEqual(requests,[]);assert.equal(mode.pendingResult,null);
  assert.equal(thread.sent,0);
});

test('progress distinguishes a finished step from task success, interruption and unavailable status', () => {
  const {describeWork} = setup();
  const step = { type:'assistant', content:[{type:'tool',name:'Test',state:{status:'completed'}}] };
  const success = {type:'idle', outcome:'succeeded'};
  const running = describeWork('s', {s:{type:'running'}}, [step,success]);
  assert.equal(running.arbeit,'läuft');
  assert.equal(running.letzteSchritte[0].status,'completed');
  assert.equal(describeWork('s',{},[success,step]).arbeit,'abgeschlossen');
  assert.equal(describeWork('s',{},[{type:'idle',outcome:'interrupted'},step]).arbeit,'unterbrochen');
  assert.equal(describeWork('s',null,null).arbeit,'unbekannt');
  assert.match(describeWork('s',{},[{type:'user'},success]).arbeit,/nicht bestätigt/);
});

test('memory commands are explicit and personal turns and replies stay out of handoff summaries', async () => {
  const api = setup(async (_url, options) => {
    const {prompt} = JSON.parse(options.body);
    assert.doesNotMatch(prompt, /Privatbeispiel/);
    assert.match(prompt, /Nur die Schrift ändern/);
    return {ok:true,json:async()=>({data:{text:'{"summary":"Nur die Schrift ändern"}'}})};
  });
  assert.equal(api.memoryCommand('Merk dir: Ich mag kurze Antworten.'),'Ich mag kurze Antworten.');
  assert.equal(api.memoryCommand('Merk dir das.'),'');
  for (const text of ['Merk dir das nicht.', 'Er sagte „Merk dir das“.', 'Merk dir das?']) assert.equal(api.memoryCommand(text),null);
  const thread = liveThread(api,[
    {frage:'Merk dir: Privatbeispiel',antwort:'Privatbeispiel',voicePrivate:true},
    {frage:'Nur die Schrift ändern',antwort:'Privatbeispiel',privateReply:true},
  ]);
  assert.equal(await api.summarizeHandoff('ses_test',api.unsentTurns(thread)),'Nur die Schrift ändern');
});

test('paraphrased requests use semantic intent, while chat and invalid decisions do not resume', async () => {
  const responses = ['{"intent":"resume","reply":""}', '{"intent":"chat","reply":"Alles klar, ich warte."}', '{"intent":"resume"}'];
  const api = setup(async (url, options) => {
    if (url === '/api/session/active') return { ok: true, json: async () => ({data:{}}) };
    assert.equal(url, '/api/session/ses_test/generate');
    assert.match(JSON.parse(options.body).prompt, /aussage/);
    return { ok: true, json: async () => ({ data: { text: responses.shift() } }) };
  });
  const mode = { session: 'ses_test', abort: new AbortController() };
  assert.equal((await api.decideLiveTurn(mode, [], 'Na dann leg damit mal los.')).resume, true);
  assert.equal((await api.decideLiveTurn(mode, [], 'Bitte damit noch nicht anfangen.')).reply, 'Alles klar, ich warte.');
  assert.equal((await api.decideLiveTurn(mode, [], 'Was meinst du dazu?')).resume, false);
});

test('running task stays read-only even if the speech model suggests a handoff', async () => {
  const urls = [];
  const api = setup(async url => {
    urls.push(url);
    return { ok:true, json:async()=> url === '/api/session/active' ? {data:{ses_test:{type:'running'}}} : {data:{text:'{"intent":"resume","reply":""}'}} };
  });
  const mode = { session:'ses_test', abort:new AbortController() };
  const decision = await api.decideLiveTurn(mode, [], 'Mach weiter');
  assert.equal(decision.resume,false);
  assert.deepEqual(urls,['/api/session/active','/api/session/ses_test/generate']);
});

test('main-chat job finishes during status playback: read the result once after drain, before reopening mic',async()=>{
  const events=[];let poll,drainStatus,drainResult;
  const user={type:'user',id:'msg_work'};
  const ok=data=>({ok:true,json:async()=>({data})});
  const api=setup(async(url,opts)=>{
    if(url==='/api/session/active')return ok({ses_test:{type:'running'}});
    if(url.includes('type=user'))return ok([user]);
    if(url.includes('limit=50'))return ok([{type:'idle',outcome:'succeeded'},{type:'assistant',finish:'stop',content:[{type:'text',text:'Der Filter funktioniert.'}]},user]);
    if(url.endsWith('/generate'))return ok({text:JSON.parse(opts.body).prompt.includes('tatsächliche Ergebnis')?'Der Filter funktioniert.':'{"intent":"chat","reply":"Der Filter wird geprüft."}'});
    throw Error(url);
  },undefined,(fn,ms)=>{if(ms===2500)poll=fn});
  const history=[],mode={kind:'live',session:'ses_test',abort:new AbortController(),history,thread:{history,sent:0}};api.setMode(mode);
  api.setMic(async()=>{events.push('mic');return {}});
  api.setPlayback(async(_,text)=>{events.push(text);return new Promise(r=>{if(events.length===1)drainStatus=r;else drainResult=r})});
  const decision=await api.decideLiveTurn(mode,[],'Wie weit bist du?');
  const turn=api.play(mode,decision.reply,'status').then(()=>api.listenAgain(mode));
  poll();await new Promise(setImmediate);assert.deepEqual(events,['Der Filter wird geprüft.']);assert.equal(mode.pendingResult.id,user.id);
  drainStatus(true);await new Promise(setImmediate);assert.deepEqual(events,['Der Filter wird geprüft.','Der Filter funktioniert.']);assert.equal(mode.pendingResult.id,user.id);
  drainResult(true);await turn;assert.equal(mode.pendingResult,null);assert.equal(mode.lastReportedId,user.id);assert.equal(events.at(-1),'mic');
});

test('explicit follow-up queues immediately and switches result tracking only after admission',async()=>{
  let admit, poll, pages=0;
  const calls=[],spoken=[];
  const brief='Prüfe den Filter unter dieser Einschränkung: '+ 'Langtext '.repeat(40).trim();
  const api=setup((url,options)=>{
    if(url.endsWith('/generate'))return Promise.resolve({ok:true,json:async()=>({data:{text:JSON.stringify({summary:brief})}})});
    if(url.includes('limit=50')){
      pages++;
      return {ok:true,json:async()=>({data:[{type:'user',id:'msg_older',time:{created:1}}],cursor:{next:'old-page'}})};
    }
    calls.push([url,JSON.parse(options.body)]);
    return new Promise(resolve=>{admit=()=>resolve({ok:true,json:async()=>({data:{id:'msg_next'}})});});
  },undefined,(fn,ms)=>{if(ms===2500)poll=fn;},async(_,__,msg)=>{spoken.push(msg.text);return true});
  const command={frage:'Gib das jetzt auch noch als Folgeauftrag an den Coding-Assistenten weiter.'};
  const thread=liveThread(api,[{frage:'Den Filter prüfen',note:'Den Filter prüfen'},{frage:'Einschränkung: '+ 'Langtext '.repeat(40)},command]);
  const mode={session:'ses_test',thread,returnId:'msg_old',enabledAt:Date.now(),abort:new AbortController()};api.setMode(mode);
  const decision=await api.decideLiveTurn(mode,[],command.frage,command);
  assert.ok(decision.queue);
  const pending=api.handoffTask(mode,decision.queue);
  await new Promise(setImmediate);
  assert.deepEqual(calls,[['/api/session/ses_test/prompt',{text:brief,delivery:'queue',resume:true,metadata:{source:'live-assistant',purpose:'execute-request'}}]]);assert.deepEqual(spoken,[]);
  assert.equal(mode.returnId,'msg_old');mode.pendingResult={id:'msg_old',text:'Altes Ergebnis'};
  admit();await pending;assert.equal(mode.returnId,'msg_next');assert.equal(mode.pendingResult,null);assert.equal(api.unsentTurns(thread).length,0);
  assert.deepEqual(spoken,[calls[0][1].text]);
  assert.equal(typeof poll,'function');poll();await new Promise(setImmediate);
  assert.equal(pages,1);assert.equal(mode.returnId,'msg_next');assert.equal(mode.pendingResult,null);
  mode.abort.abort();
});

test('send only the executable brief including its restriction, never the raw conversation', async () => {
  const urls = [];
  const instruction = 'Heute war viel los. Mach weiter, aber ändere nur die Farbe meiner Schrift.';
  const api = setup(async (url, options) => { urls.push(url); if (url.endsWith('/generate')) return {ok:true,json:async()=>({data:{text:'{"summary":"Ändere ausschließlich die Schriftfarbe."}'}})}; assert.equal(JSON.parse(options.body).text,'Ändere ausschließlich die Schriftfarbe.'); return {ok:true,json:async()=>({data:{id:'msg_new'}})}; });
  const thread = liveThread(api,[{ frage: instruction, handoff: true }]);
  const mode = { session: 'ses_test', kind:'live', thread, abort: new AbortController() };
  api.setMode(mode);
  await api.handoffTask(mode);
  assert.deepEqual(urls, ['/api/session/ses_test/generate','/api/session/ses_test/prompt']);
  assert.equal(mode.parked,true);
});

test('return waits for the handed-off message and its idle outcome', () => {
  const {taskOutcome} = setup();
  const user = {type:'user',id:'msg_new'}, answer = {type:'assistant',finish:'stop',content:[{type:'text',text:'Erledigt'}]}, idle = {type:'idle',outcome:'succeeded'};
  assert.equal(taskOutcome([idle,answer],user.id),null);
  assert.equal(taskOutcome([answer,user,idle],user.id),null);
  assert.equal(taskOutcome([idle,answer,user],user.id).text,'Erledigt');
  const other = {type:'user',id:'msg_other'};
  assert.equal(taskOutcome([answer,other,user],user.id),null);
  const ambiguous=taskOutcome([idle,answer,other,user],user.id);
  assert.match(ambiguous.unassigned,/nicht eindeutig/);
  assert.equal(ambiguous.error,undefined);
  assert.equal(ambiguous.text,undefined);
  assert.equal(taskOutcome([other,idle,answer,user],user.id).text,'Erledigt');
});

test('a conversational offer is optional, rate limited, and a yes accepts just that offer once', async () => {
  const task = 'Die mobile Ansicht vereinfachen';
  const api = setup(async url => ({ok:true,json:async()=>url === '/api/session/active' ? {data:{}} :
    {data:{text:JSON.stringify({intent:'chat',reply:'Klingt gut.',offer:task})}}}));
  const mode = {session:'ses_test',thread:liveThread(api),abort:new AbortController()};
  const prior = [{frage:'Eine Idee'}, {antwort:'Besprochen'}];
  assert.equal((await api.decideLiveTurn(mode,prior,'Das wäre rund.')).offer,undefined);
  mode.thread.history.push({frage:task,note:task});
  assert.equal((await api.decideLiveTurn(mode,prior,'Das wäre rund.')).offer,task);
  mode.offer = task; mode.thread.lastOfferAt = Date.now();
  assert.equal((await api.decideLiveTurn(mode,prior,'Ja, bitte.')).task,task);
  assert.equal((await api.decideLiveTurn(mode,prior,'Ja, bitte.')).resume,false);
  assert.equal((await api.decideLiveTurn(mode,prior,'Das wäre rund.')).offer,undefined);
});

test('a near match after a model question suggests only an offered option and requires confirmation',async()=>{
  let writes=0,reply;const model={id:'nova',providerID:'p',name:'Nova'};
  const api=setup(async(url,opts)=>{if(opts?.method==='POST')writes++;return {ok:true,json:async()=>({data:url==='/api/model'?[model]:{model}})}});
  const mode={session:'ses_test',abort:new AbortController(),pendingSetting:{kind:'main',names:['Nova (p)','Sol (p)'],expires:Date.now()+60000}};
  api.setMode(mode);api.setPlayback(async(_,s)=>reply=s);const say=frage=>api.handleSettingTurn(mode,{frage});
  await say('Nava');assert.match(reply,/Meinst du.*Nova/);assert.equal(writes,0);await say('Ja, genau.');assert.equal(writes,1);assert.match(reply,/Jetzt aktiv.*Nova/);
});

test('budget change uses the current model and confirms only its returned variant',async()=>{
  let variant='low',persist=true,writes=0;const model={id:'demo',providerID:'fixture'};
  const api=setup(async(url,opts)=>{let data;
    if(url==='/api/model')data=[{...model,variants:[{id:'low'},{id:'high'}]}];
    else if(opts?.method==='POST'){const body=JSON.parse(opts.body);assert.deepEqual(body.model,{...model,variant:'high'});writes++;if(persist)variant='high';}
    else data={model:{...model,variant}};
    return {ok:true,json:async()=>({data})};
  });const mode={session:'ses_test',abort:new AbortController()};api.setMode(mode);let reply;api.setPlayback(async(_,s)=>reply=s);
  for(const frage of ['Das Thinking Budget ist hoch','Nova gefällt mir','Probe WAV klingt gut'])assert.equal(await api.handleSettingTurn(mode,{frage}),false);
  assert.equal(await api.handleSettingTurn(mode,{frage:'Kannst du mir sagen, welche Thinkingstufen mein aktuelles Modell hat?'}),true);
  assert.match(reply,/low, high/);assert.equal(writes,0);
  for(const frage of ['hi','high oder low?']) {
    assert.equal(await api.handleSettingTurn(mode,{frage}),true);assert.match(reply,frage==='hi'?/Meinst du.*hi.*high/:/Welche Thinking-Stufe/);assert.equal(mode.pendingSetting.kind,'budget');assert.equal(writes,0);
  }
  await api.handleSettingTurn(mode,{frage:'ja'});assert.equal(writes,0);
  await api.handleSettingTurn(mode,{frage:'hi'});assert.equal(writes,0);
  await api.handleSettingTurn(mode,{frage:'Ja, genau.'});assert.equal(writes,1);assert.match(reply,/Jetzt aktiv.*high/);
  persist=false;variant='low';await api.handleSettingTurn(mode,{frage:'Setz das Thinking Budget auf hoch'});assert.match(reply,/nicht bestätigt/);
});

test('voice stop ends the conversation without submitting a task', async () => {
  const api = setup(() => {throw Error('unexpected request')});
  assert.ok((await api.decideLiveTurn({}, [], 'Beende bitte das Live-Gespräch.')).end);
});

test('handoff collapses voice and queues only the short note in the same session', async () => {
  let release;
  const calls = [];
  const api = setup((url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    if (url.endsWith('/generate')) return Promise.resolve({ ok: true, json: async () => ({ data: { text: '{"summary":"Die Änderung gilt nur mobil."}' } }) });
    return new Promise((resolve) => { release = resolve; });
  });
  const thread = liveThread(api,[{ frage: 'Schon übergeben' }, { frage: 'Nur mobil ändern', antwort: 'Verstanden.' }, { frage: 'Mach weiter.' }],1);
  const abort = new AbortController();
  const mode = { session: 'ses_test', thread, abort };
  api.setMode(mode);
  const pending = api.handoffTask(mode);
  await api.handoffTask(mode);
  assert.equal(mode.parked, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '/api/session/ses_test/generate');
  assert.match(calls[0][1].prompt, /Nur mobil ändern/);
  assert.doesNotMatch(calls[0][1].prompt, /Schon übergeben|Mach weiter\./);
  assert.equal(calls[1][0], '/api/session/ses_test/prompt');
  assert.equal(calls[1][1].delivery, 'queue');
  assert.equal(calls[1][1].text, 'Die Änderung gilt nur mobil.');
  assert.doesNotMatch(calls[1][1].text, /Verstanden|Nur mobil ändern|Schon übergeben/);
  release({ ok: true, json:async()=>({data:{id:'msg_test'}}) });
  await pending;
  assert.equal(thread.sent, 3);
  assert.equal(thread.history.length, 3);
  assert.equal(thread.sending, false);
});

test('no concrete brief: clarify locally instead of falling back to a continuation command', async () => {
  const texts = [];
  const api = setup(async (url, options) => {
    if (url.endsWith('/generate')) return { ok: true, json: async () => ({ data: { text: '{"summary":""}' } }) };
    texts.push(JSON.parse(options.body).text);
    return { ok: true };
  });
  const thread = liveThread(api,[{ frage: 'Wie geht es dir?' }, { frage: 'Mach los.' }]);
  const mode = { session: 'ses_test', thread, abort: new AbortController() };
  api.setMode(mode);
  const replies=[];api.setPlayback(async(_,text)=>replies.push(text));api.setMic(async()=>({}));
  await api.handoffTask(mode);
  assert.deepEqual(texts, []);assert.match(replies[0],/Was genau/);assert.equal(thread.sent,0);
});

test('invalid summary does not forward the transcript or start the task', async () => {
  const urls = [];
  const api = setup(async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ data: { text: 'invalid' } }) };
  });
  const thread = liveThread(api,[{ frage: 'Nur die mobile Ansicht ändern.' }, { frage: 'Mach los.' }]);
  const mode = { session: 'ses_test', thread, abort: new AbortController() };
  api.setMode(mode);
  await api.handoffTask(mode);
  assert.deepEqual(urls, ['/api/session/ses_test/generate']);
  assert.equal(thread.sent, 0);
  assert.match(thread.notice, /Nichts gesendet/);
});

test('unconfirmed handoff retains unsent context and never retries by itself', async () => {
  let calls = 0;
  const api = setup(async url => { if(url.endsWith('/generate'))return {ok:true,json:async()=>({data:{text:'{"summary":"Prüfe den Filter."}'}})};calls++; throw new Error('offline'); });
  const thread = liveThread(api,[{ frage: 'Prüfe den Filter.' }]);
  const mode = { session: 'ses_test', thread, abort: new AbortController() };
  api.setMode(mode);
  await api.handoffTask(mode);
  assert.equal(calls, 1);
  assert.equal(thread.sent, 0);
  assert.equal(thread.sending, false);
  assert.match(thread.notice, /nicht bestätigt/);
});

test('unnoted restrictions reach the brief, and admission consumes only the selected snapshot', async () => {
  let admitted=false;
  const constraint='Die Pause nur lokal verlängern.', privateText='Ungültiger privater Nebensatz';
  const future={frage:'Späterer Punkt'};
  const brief='Filter prüfen und die Pause nur lokal verlängern.';
  const api=setup(async(url,options)=>{
    if(url.endsWith('/generate')) {
      const prompt=JSON.parse(options.body).prompt;
      assert.match(prompt,/Filter prüfen/);assert.ok(prompt.includes(constraint));assert.ok(!prompt.includes(privateText));
      assert.doesNotMatch(prompt,/Persönliche Antwort|Expertenantwort/);
      return ok({text:JSON.stringify({summary:brief})});
    }
    if(url.endsWith('/prompt')){
      assert.equal(JSON.parse(options.body).text,brief);
      if(admitted)thread.history.push(future);
      return ok(admitted?{id:'msg_test'}:{});
    }
    return {ok:true,json:async()=>({data:[]})};
  });
  const thread=liveThread(api,[{frage:'Filter prüfen',note:'Filter prüfen'},{frage:constraint,antwort:'Persönliche Antwort',privateReply:true},
    {frage:privateText,voicePrivate:true},{frage:'Frage zur Zweitmeinung',antwort:'Expertenantwort',route:'expert'},{frage:'Mach weiter.'}]);
  const mode={session:'ses_test',thread,abort:new AbortController()};api.setMode(mode);
  await api.handoffTask(mode);assert.equal(thread.sent,0);assert.ok(api.unsentTurns(thread).some(t=>t.frage===constraint));
  admitted=true;api.setMode(mode);await api.handoffTask(mode);assert.deepEqual(Array.from(api.unsentTurns(thread)),[future]);
});

test('delegating a previous question resolves the older live turn and reads only the exact admitted text', async () => {
  const original = 'Hat die App selbst den Wechsel ausgelöst?\nBitte prüfe auch, welche Informationen sie dafür hatte.';
  const command = 'Du sollst jetzt dem Coding-Model sagen, es soll meine Frage beantworten, die ich zuvor gestellt habe.';
  const sourceTurn = { frage: original, antwort: 'Wir können den Ablauf prüfen.', note: 'Wechsel nachvollziehen' };
  const history = [sourceTurn, ...Array.from({length: 8}, (_, i) => ({frage: `Gesprächspunkt ${i}`, antwort: `Antwort ${i}`})),
    {frage: 'Private Testnotiz', voicePrivate: true}, {frage: 'Danke.', antwort: 'Private Antwort aus Erinnerung', privateReply: true}];
  history.push({frage:'Anderes offenes Thema',note:'Anderes offenes Thema'});
  const spoken = [], writes = [];
  let admit;
  const ok = data => ({ok: true, json: async () => ({data})});
  const api = setup(async (url, opts) => {
    if (url === '/api/session/active') return ok({});
    if (url.endsWith('/generate')) {
      const {prompt} = JSON.parse(opts.body);
      if (/Fragenbezug/.test(prompt)) {
        assert.match(prompt, /Hat die App selbst den Wechsel ausgelöst/);
        assert.match(prompt, /Wir können den Ablauf prüfen/);
        assert.doesNotMatch(prompt, /Private Testnotiz|Private Antwort aus Erinnerung/);
        return ok({text: '{"nummer":1}'});
      }
      // The old route detected a handoff but then treated the empty summary as a duplicate.
      return ok({text: /aussage/.test(prompt) ? '{"intent":"resume","reply":""}' : '{"summary":""}'});
    }
    if (url.endsWith('/inbox') || url.includes('type=user')) return ok([]);
    if (url.endsWith('/prompt')) {
      writes.push(JSON.parse(opts.body));
      return new Promise(resolve => { admit = () => resolve(ok({id:'msg_ref'})); });
    }
    assert.fail(`Unexpected request: ${url}`);
  }, undefined, undefined, async (_, __, msg) => { spoken.push(msg.text); return true; });
  const thread=Object.assign(liveThread(api,history),{recentTasks:['Früherer Auftrag']});
  const mode = { kind: 'live', session: 'ses_test', thread, history, abort: new AbortController() };
  api.setMode(mode); api.setMic(async () => ({}));
  api.setPlayback(async (_, text) => { spoken.push(text); return true; });
  const pending = api.transcribe(mode, command);
  await new Promise(setImmediate);
  assert.deepEqual(writes, [{ text: original, delivery: 'queue', resume: true,metadata:{source:'live-assistant',purpose:'answer-question'} }]);
  assert.deepEqual(spoken, []);
  assert.deepEqual(Array.from(api.unsentTurns(thread),t=>t.note).filter(Boolean), [sourceTurn.note,'Anderes offenes Thema']);
  admit(); await pending;
  assert.deepEqual(spoken, [original]);
  assert.deepEqual(Array.from(api.unsentTurns(thread),t=>t.note).filter(Boolean), ['Anderes offenes Thema']);
  assert.equal(mode.returnId, 'msg_ref');
});

test('an earlier question already queued or visible in the main chat is never submitted again',async()=>{
  for (const queued of [true,false]) {
    const question='Hat die App die Einstellung selbst gesetzt?';
    const history=[{frage:question,note:'Einstellung prüfen'},{frage:'Unabhängiges Thema',note:'Unabhängiges Thema'}];
    const calls=[],replies=[];
    const api=setup(async (url,opts)=>{
      calls.push(url);
      let data;
      if(url.endsWith('/generate')) data={text:'{"nummer":1}'};
      else if(url.endsWith('/inbox')) data=queued?[{type:'user',id:'msg_existing',payload:{text:question}}]:[];
      else if(url.includes('type=user')) data=[{type:'user',id:'msg_existing',text:question}];
      else if(url.includes('limit=100')) data=[];
      else assert.fail(`${opts?.method}: ${url}`);
      return {ok:true,json:async()=>({data})};
    });
    const thread=liveThread(api,history), mode={kind:'live',session:'ses_test',thread,history,abort:new AbortController()};
    api.setMode(mode);api.setMic(async()=>({}));api.setPlayback(async(_,text)=>{replies.push(text);return true;});
    await api.transcribe(mode,'Kannst du meine vorherige Frage an den Hauptchat weitergeben?');
    assert.match(replies.at(-1),queued?/bereits in der Warteschlange/:/bereits im Hauptchat/);
    assert.equal(calls.filter(v=>v.endsWith('/prompt')).length,0);
    assert.deepEqual(Array.from(api.unsentTurns(thread),t=>t.note).filter(Boolean),['Unabhängiges Thema']);
  }
});

test('a missing or private previous question is not guessed; the dictated wording needs confirmation',async()=>{
  const history=[{frage:'Private Frage aus dem Sprachprofil',voicePrivate:true}];
  const sent=[],replies=[];
  const api=setup(async (url,opts)=>{
    if (url.endsWith('/inbox') || url.includes('type=user')) return {ok:true,json:async()=>({data:[]})};
    if (url.endsWith('/prompt')) {sent.push(JSON.parse(opts.body).text);return {ok:true,json:async()=>({data:{id:'msg_ref'}})};}
    assert.fail(`Unexpected request: ${url}`);
  });
  const thread=liveThread(api,history), mode={kind:'live',session:'ses_test',thread,history,abort:new AbortController()};
  api.setMode(mode);api.setMic(async()=>({}));api.setPlayback(async(_,text)=>{replies.push(text);return true;});
  await api.transcribe(mode,'Lass den Coding-Agenten meine vorige Frage beantworten.');
  assert.match(replies.at(-1),/Welche Frage/);assert.equal(sent.length,0);
  await api.transcribe(mode,'Hat der Live-Assistent den Wechsel ausgeführt?');
  assert.match(replies.at(-1),/genau diese Frage unverändert/);assert.equal(sent.length,0);
  await api.transcribe(mode,'Ja, genau.');
  assert.deepEqual(sent,['Hat der Live-Assistent den Wechsel ausgeführt?']);
});

test('a receipt is not an answer: one linked request, read after admission, then reuse the actual answer',async()=>{
  const question='Welche Einstellung wurde geändert?', receipt='Die Nachricht steht bereits im Hauptchat.', answer='Das Thinking Budget wurde auf high gestellt.';
  const history=[{frage:question}];
  const posts=[],spoken=[];const original={type:'user',id:'msg_q',text:question};let previous;
  const api=setup(async(url,opts)=>{let data;
    if(url.endsWith('/generate')) {const lookup=JSON.parse(opts.body).prompt.includes('Fragenbezug');data={text:JSON.stringify(lookup?{nummer:1}:{status:previous?'inhaltlich':'nur_empfang',beleg:previous?answer:receipt})};}
    else if(url.endsWith('/inbox'))data=[];
    else if(url.includes('type=user'))data=previous?[previous,original]:[original];
    else if(url.includes('limit=100'))data=[{type:'idle',outcome:'succeeded'},{type:'assistant',finish:'stop',content:[{type:'text',text:previous?answer:receipt}]},previous||original];
    else if(url.endsWith('/prompt')){const body=JSON.parse(opts.body);posts.push(body);previous={type:'user',id:'msg_answer_request',text:body.text};data={id:previous.id};}
    else assert.fail(url);return {ok:true,json:async()=>({data})};
  },undefined,undefined,async(_,__,msg)=>{spoken.push(msg.text);return true});
  const thread=liveThread(api,history), mode={kind:'live',session:'ses_test',thread,history,abort:new AbortController()};
  api.setMode(mode);api.setMic(async()=>({}));api.setPlayback(async(_,text)=>{spoken.push(text);return true});
  const command='Lass den Coding-Agenten meine vorige Frage beantworten.';await api.transcribe(mode,command);
  assert.equal(posts.length,1);assert.match(posts[0].text,/Beantworte.*msg_q.*inhaltlich/);assert.equal(posts[0].metadata.purpose,'answer-question');assert.deepEqual(spoken,[posts[0].text]);
  await api.transcribe(mode,command);assert.equal(posts.length,1);assert.equal(spoken.at(-1),answer);
});

test('opening Live does not write instructions; the first explicit submission waits for role readback', async ()=>{
  const actions=[];
  let entry, verified=false, admit;
  const api=setup(async (url,opts)=>{
    if (url==='/api/session/active') return ok({});
    if (url.endsWith('/generate')) return ok({text:'{"summary":"Prüfe nur den Filter."}'});
    if (url.endsWith('/instructions/entries')) {actions.push('read');return ok(verified && entry?[entry]:[]);}
    if (url.endsWith('/instructions/entries/opencode-touch-live-role')) {
      assert.equal(opts.method,'PUT');actions.push('write');entry={key:'opencode-touch-live-role',value:JSON.parse(opts.body).value};return ok(entry);
    }
    if (url.endsWith('/prompt')) {actions.push('submit');return new Promise(r=>{admit=()=>r(ok({id:'msg_role_test'}));});}
    assert.fail(url);
  },undefined,undefined,undefined,{stubRole:false});
  api.setMic(async()=>({}));api.setPlayback(async()=>true);
  api.toggleVoiceMode('live');await new Promise(setImmediate);
  assert.deepEqual(actions,[]);
  const mode=api.mode();mode.history.push({frage:'Prüfe nur den Filter.'});
  await api.transcribe(mode,'Mach los.');
  assert.deepEqual(actions,['read','write','read']);assert.equal(mode.thread.sent,0);
  assert.match(mode.thread.notice,/Rollenhinweis.*Nichts gesendet/);
  verified=true;
  const pending=api.transcribe(mode,'Mach los.');await new Promise(setImmediate);
  assert.deepEqual(actions.slice(3),['read','submit']);assert.equal(mode.thread.sent,0);
  admit();await pending;assert.equal(mode.thread.sent,3);
});

test('an ordinary personalized Live reply needs one generation and cannot export its private note', async ()=>{
  const marker='PERSÖNLICHES TESTMERKMAL', requests=[], posts=[];
  const api=setup(async (url,opts)=>{
    if (url==='/api/session/active') return ok({});
    if (url==='/__opencode_touch/memory') return {ok:true,json:async()=>({items:[{text:marker}]})};
    const body=JSON.parse(opts.body);
    if(url.endsWith('/generate')){
      requests.push(body.prompt);
      return ok({text:body.prompt.includes(marker)?JSON.stringify({intent:'chat',reply:marker,note:marker}):'{"summary":"Ändere nur die Schrift."}'});
    }
    if(url.endsWith('/prompt')) {posts.push(body);return ok({id:'msg_privacy'});}
    assert.fail(url);
  });
  const thread=liveThread(api),mode={kind:'live',session:'ses_test',thread,history:thread.history,abort:new AbortController()};
  api.setMode(mode);api.setMic(async()=>({}));api.setPlayback(async(_,text)=>{mode.history.at(-1).antwort=text;return true;});
  await api.transcribe(mode,'Ändere nur die Schrift.');
  assert.equal(requests.length,1);assert.ok(requests[0].includes(marker));
  assert.equal(mode.history[0].privateReply,true);assert.equal(mode.history[0].note,undefined);
  await api.transcribe(mode,'Mach los.');
  assert.equal(requests.length,2);assert.ok(!requests[1].includes(marker));assert.match(requests[1],/Ändere nur die Schrift/);
  assert.deepEqual(posts.map(post=>post.text),['Ändere nur die Schrift.']);
});

test('broken saved model selections fall back to the session model without writing settings', async ()=>{
  for (const choice of ['{','null','"fixture"','{"providerID":"fixture"}','{"id":"","providerID":"fixture"}']) {
    const api=setup(async (url,opts)=>{
      assert.equal(url,'/api/session/ses_test/generate');assert.deepEqual(JSON.parse(opts.body),{prompt:'Test'});return ok({text:'ok'});
    },{getItem:()=>choice,setItem:()=>assert.fail('Unexpected write')});
    assert.equal((await api.generateVoice('auto','ses_test','Test',new AbortController().signal)).text,'ok');
  }
});

test('expert mode checks the configured model and only generates advice',async()=>{
  const model={providerID:'fixture',id:'advice-v1'};
  const calls=[];let available=true;
  const api=setup(async(url,opts)=>{
    calls.push(url);
    if(url==='/api/model')return ok(available?[model]:[]);
    if(url==='/api/session/ses_test')return ok({model:{providerID:'fixture',id:'main'}});
    if(url.includes('/message?'))return ok([{type:'user',text:'Hauptchat-Kontext.'}]);
    if(url==='/api/experimental/generate') {
      const body=JSON.parse(opts.body);assert.deepEqual(body.model,model);assert.match(body.prompt,/Hauptchat-Kontext/);assert.doesNotMatch(body.prompt,/Private Notiz/);
      return ok({text:'Nur eine Empfehlung.'});
    }
    assert.fail(url);
  },undefined,undefined,undefined,{expert:'fixture/advice-v1'});
  const thread=liveThread(api,[{frage:'Private Notiz',voicePrivate:true}]),mode={kind:'live',session:'ses_test',thread,history:thread.history,abort:new AbortController()};
  const replies=[];api.setMode(mode);api.setPlayback(async(_,text)=>{replies.push(text);return true;});api.setMic(async()=>({}));
  await api.transcribe(mode,'Frag das große Modell nach einer Empfehlung.');
  assert.deepEqual(replies,['Nur eine Empfehlung.']);assert.equal(calls.filter(url=>url.endsWith('/generate')).length,1);
  available=false;calls.length=0;
  await api.transcribe(mode,'Frag das große Modell.');
  assert.deepEqual(calls,['/api/model']);assert.match(replies.at(-1),/nicht verfügbar/);
});

async function adoptRunningTask(listPage) {
  const polls=[], pages=[], summaries=[];
  const user={type:'user',id:'msg_long',time:{created:1}};
  const api=setup(async(url,opts)=>{
    if(url==='/api/session/active')return ok({ses_test:{type:'running'}});
    if(url.includes('type=user'))return ok([user]);
    if(url.includes('limit=50')){
      const query=new URL(url,'http://localhost').searchParams;
      pages.push({order:query.get('order'),cursor:query.get('cursor')});
      return {ok:true,json:async()=>listPage(query,user,pages.length)};
    }
    if(url.endsWith('/generate')){
      const {prompt}=JSON.parse(opts.body);
      if(prompt.includes('tatsächliche Ergebnis')) {summaries.push(prompt);return ok({text:'Lange Arbeit fertig.'});}
      return ok({text:'{"intent":"chat","reply":"Läuft noch."}'});
    }
    assert.fail(`unexpected request: ${url}`);
  },undefined,(fn,ms)=>{if(ms===2500)polls.push(fn);});
  const thread=liveThread(api);
  const mode={kind:'live',session:'ses_test',enabledAt:Date.now(),abort:new AbortController(),history:thread.history,thread};
  api.setMode(mode);api.setPlayback(async()=>true);api.setMic(async()=>({}));
  await api.decideLiveTurn(mode,[],'Wie weit bist du?');
  assert.equal(mode.returnId,user.id);assert.equal(polls.length,1);
  polls.shift()();await new Promise(setImmediate);
  return {mode,pages,polls,summaries};
}

test('Live locates an adopted running task even if its user message predates Live and is on a later page',async()=>{
  const tools=Array.from({length:48},(_,i)=>({type:'assistant',finish:'tool-calls',time:{created:51-i},content:[]}));
  const next='p/2+=';
  const {mode,pages,polls,summaries}=await adoptRunningTask((query,user)=>query.get('cursor')===next?{data:[user]}:{
    data:[{type:'idle',outcome:'succeeded'},{type:'assistant',finish:'stop',content:[{type:'text',text:'Fertig.'}]},...tools],cursor:{next},
  });
  assert.deepEqual(pages,[{order:'desc',cursor:null},{order:null,cursor:next}]);
  assert.deepEqual({...mode.pendingResult},{id:'msg_long',text:'Lange Arbeit fertig.'});
  assert.equal(mode.returnId,null);assert.equal(polls.length,0);
  assert.equal(summaries.length,1);assert.match(summaries[0],/Fertig\./);
});

test('a missing adopted task gives one notice at the end, at a repeated cursor, or after 20 pages',async()=>{
  const row={type:'assistant',finish:'tool-calls',time:{created:5},content:[]};
  for(const [nextCursor,expectedPages] of [[()=>null,1],[()=> 'same-page',2],[page=>`page-${page+1}`,20]]) {
    const {mode,pages,polls,summaries}=await adoptRunningTask((_query,_user,page)=>{
      const next=nextCursor(page);
      return {data:[row],...(next?{cursor:{next}}:{})};
    });
    assert.equal(pages.length,expectedPages);
    assert.equal(mode.pendingResult?.id,'msg_long');assert.match(mode.pendingResult.text,/nicht mehr eindeutig/);
    assert.equal(mode.returnId,null);assert.equal(polls.length,0);assert.equal(summaries.length,0);
  }
});

test('the Live panel follows the main timeline only while the reader stays at the bottom',()=>{
  const api=setup();const frames=new Map();let onScroll, nextFrame=0;
  const el={scrollHeight:1000,clientHeight:400,_top:600,
    get scrollTop(){return this._top;},set scrollTop(v){this._top=Math.max(0,Math.min(v,this.scrollHeight-this.clientHeight));},
    addEventListener(type,fn,options){assert.equal(type,'scroll');assert.equal(options.passive,true);onScroll=fn;},
    removeEventListener(type,fn){assert.equal(type,'scroll');assert.equal(fn,onScroll);onScroll=null;},
  };
  const attach=()=>api.followTimeline(el,()=>true,fn=>{frames.set(++nextFrame,fn);return nextFrame;},id=>frames.delete(id));
  const follower=attach();
  const run=()=>{for(const [id,fn] of frames){frames.delete(id);fn();}};
  const userScroll=top=>{el.scrollTop=top;onScroll();};
  el.scrollHeight=1200;follower.follow();follower.follow();assert.equal(frames.size,1);run();assert.equal(el.scrollTop,800);
  el.scrollHeight=1250;onScroll(); // Delayed event from own scroll, after the content has grown.
  follower.follow();run();assert.equal(el.scrollTop,850);
  el.scrollHeight=1500;follower.follow();userScroll(200);run();assert.equal(el.scrollTop,200);
  el.scrollHeight=1700;follower.follow();run();assert.equal(el.scrollTop,200);
  userScroll(1300);el.scrollHeight=1900;follower.follow();run();assert.equal(el.scrollTop,1500);
  follower.follow();follower.disconnect();assert.equal(frames.size,0);assert.equal(onScroll,null);
  el.scrollTop=300;const reopened=attach();reopened.follow();run();assert.equal(el.scrollTop,300);
  reopened.disconnect();
});
