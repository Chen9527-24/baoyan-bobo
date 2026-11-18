import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp,type AppOptions} from '../apps/server/src/app.js';
import type {VolcRealtimeProvider,VolcRealtimeConnectInput,VolcRealtimeEvent} from '../apps/server/src/volc-realtime.js';

const origin='http://localhost:5173',pin='482619';
const post=(a:any,path:string,body:unknown={})=>a.post('/api'+path).set('Origin',origin).send(body);
const transcript=(text:string):VolcRealtimeEvent=>({type:'transcript',text,delta:text,replace:true,final:true});
const reply=(text:string):VolcRealtimeEvent=>({type:'reply-text',text,delta:text,replace:false,final:true});
async function wait(check:()=>boolean){const until=Date.now()+3000;while(!check()){assert.ok(Date.now()<until,'event arrived');await new Promise(r=>setTimeout(r,5));}}
async function fixture(t:TestContext,extra:AppOptions={},registered=false){
 const sessions:{input:VolcRealtimeConnectInput;closed:boolean;frames:number;committed:number}[]=[];
 const provider:VolcRealtimeProvider={configured:true,voice:'fictional',async connect(input){const row={input,closed:false,frames:0,committed:0};sessions.push(row);return{get closed(){return row.closed;},async mute(){},async sendAudio(){row.frames++;},async commit(){row.committed++;},async close(){row.closed=true;},async interrupt(){row.closed=true;}};}};
 const app=createApp({dataPath:':memory:',env:{},realtimeProvider:provider,...extra});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;const a=request.agent(server);
 t.after(()=>{app.locals.close();server.closeAllConnections();server.close();});
 if(registered)await post(a,'/account/register',{username:'realtime.fictional',password:'12345678',pin,childName:'虚构小月',contactPhone:'+12025550101'}).expect(201);
 const setup=await post(a,'/setup',{nickname:'虚构小月',pin,ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true}).expect(201);const cookie=(setup.headers['set-cookie'] as unknown as string[]).map(v=>v.split(';')[0]).join('; ');
 async function begin(mode:'manual'|'continuous'='manual'){const call=(await post(a,'/calls',{operationId:randomUUID()}).expect(201)).body;const result=(await post(a,`/calls/${call.id}/realtime/start`,{mode}).expect(201)).body;const controller=new AbortController();const response=await fetch(`${base}/api/calls/${call.id}/realtime/events?sessionId=${result.sessionId}`,{headers:{Cookie:cookie},signal:controller.signal});assert.equal(response.status,200);const reader=response.body!.getReader();let text='';const reading=(async()=>{try{while(true){const value=await reader.read();if(value.done)break;text+=new TextDecoder().decode(value.value);}}catch{}})();t.after(()=>controller.abort());await wait(()=>text.includes('"ready"'));const {inputId}=mode==='manual'?(await post(a,`/calls/${call.id}/realtime/listen`,{sessionId:result.sessionId}).expect(200)).body:{};return{call,result,inputId,events:()=>text,abort:()=>controller.abort(),reading};}
 return{app,server,a,sessions,begin,cookie,base};
}
async function send(f:Awaited<ReturnType<typeof fixture>>,b:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['begin']>>,input='今天我画了小猫，特别开心。'){
 await post(f.a,`/calls/${b.call.id}/realtime/audio`,{sessionId:b.result.sessionId,inputId:b.inputId,sequence:0,audioBase64:Buffer.alloc(640).toString('base64')}).expect(200);
 await post(f.a,`/calls/${b.call.id}/realtime/commit`,{sessionId:b.result.sessionId,inputId:b.inputId}).expect(200);
 const event=f.sessions.at(-1)!.input.onEvent;event(transcript(input));event(reply('小猫上场啦。'));event({type:'audio',bytes:Buffer.alloc(640)});event({type:'reply-end'});
}

test('realtime app exposes independent capability; startup does not connect until authenticated SSE',async t=>{
 const f=await fixture(t);assert.equal((await f.a.get('/api/bootstrap')).body.realtime.configured,true);const call=(await post(f.a,'/calls',{operationId:randomUUID()}).expect(201)).body;
 const start=(await post(f.a,`/calls/${call.id}/realtime/start`).expect(201)).body;assert.equal(f.sessions.length,0);assert.equal(start.sceneCalibration,false);assert.equal(start.input.sampleRate,16000);
 await request(f.server).get(`/api/calls/${call.id}/realtime/events?sessionId=${start.sessionId}`).expect(401);
 await post(f.a,`/calls/${call.id}/turn`,{text:'不能混用',operationId:randomUUID()}).expect(409);
 await post(f.a,`/calls/${call.id}/end`).expect(200);assert.equal(f.app.locals.realtimeSessionCount(),0);
});

test('realtime app accepts 500ms HTTP uploads, trusted prompt and normal end records completed daily topics',async t=>{
 const f=await fixture(t),b=await f.begin();assert.match(f.sessions[0].input.systemPrompt,/年龄组：6-8/);assert.match(f.sessions[0].input.systemPrompt,/普通话或英语/);assert.equal(f.sessions[0].input.systemPrompt.includes(pin),false);
 await post(f.a,`/calls/${b.call.id}/realtime/audio`,{sessionId:b.result.sessionId,inputId:b.inputId,sequence:0,audioBase64:Buffer.alloc(16000).toString('base64')}).expect(200);
 await post(f.a,`/calls/${b.call.id}/realtime/commit`,{sessionId:b.result.sessionId,inputId:b.inputId}).expect(200);assert.equal(f.sessions[0].frames,25);
 f.sessions[0].input.onEvent(transcript('今天画了小猫，我很开心。'));f.sessions[0].input.onEvent(reply('小猫上场啦。'));f.sessions[0].input.onEvent({type:'reply-end'});
 await post(f.a,`/calls/${b.call.id}/end`).expect(200);await b.reading;assert.equal(f.sessions[0].closed,true);assert.match(b.events(),/"reason":"ended"/);
 await post(f.a,'/parent/unlock',{pin}).expect(200);const memory=(await f.a.get('/api/parent/memories').expect(200)).body;assert.equal(memory.dailySummaries.records.length,1);assert.ok(memory.dailySummaries.records[0].moods.length>0);
});

test('realtime opt-out, abandoned call, and unfinished reply do not write a daily memory',async t=>{
 for(const kind of ['optout','abandoned','unfinished']){
  const f=await fixture(t),b=await f.begin();
  if(kind==='unfinished'){f.sessions[0].input.onEvent(transcript('今天画小猫特别开心'));f.sessions[0].input.onEvent(reply('小猫上场啦'));}
  else await send(f,b,kind==='optout'?'别记住这次聊天，我今天画小猫很开心':'今天画小猫很开心');
  await post(f.a,`/calls/${b.call.id}/end`,kind==='abandoned'?{reason:'realtime-abandoned'}:{}).expect(200);
  await post(f.a,'/parent/unlock',{pin}).expect(200);assert.equal((await f.a.get('/api/parent/memories')).body.dailySummaries.records.length,0);
 }
});

test('realtime dangerous and private ASR close upstream before any supplier answer reaches SSE',async t=>{
 for(const input of ['我想伤害自己','我的密码是一个秘密']){
  const f=await fixture(t),b=await f.begin();await send(f,b,input);await b.reading;
  assert.equal(f.app.locals.realtimeSessionCount(),0);assert.equal(f.sessions[0].closed,true);assert.match(b.events(),/REALTIME_(SAFETY|PRIVACY)/);assert.equal(b.events().includes('小猫上场'),false);assert.equal(b.events().includes('audioBase64'),false);
  await post(f.a,'/parent/unlock',{pin}).expect(200);assert.equal((await f.a.get('/api/parent/memories')).body.dailySummaries.records.length,0);
 }
});

test('realtime context mutation and lease expiry immediately stop supplier and late output',async t=>{
 let at=Date.now();const f=await fixture(t,{now:()=>at}),b=await f.begin();at+=46000;f.app.locals.sweepExpiredState();await b.reading;assert.equal(f.sessions[0].closed,true);const before=b.events();f.sessions[0].input.onEvent(reply('旧内容'));assert.equal(b.events(),before);
 const g=await fixture(t),c=await g.begin();await post(g.a,'/parent/unlock',{pin}).expect(200);await c.reading;assert.equal(g.sessions[0].closed,true);assert.equal(g.app.locals.realtimeSessionCount(),0);
});

test('same-family secondary device cannot control realtime upload, subscription or normal call end',async t=>{
 const f=await fixture(t);await post(f.a,'/parent/unlock',{pin}).expect(200);const linked=(await post(f.a,'/parent/devices/link').expect(200)).body;
 const other=request.agent(f.server);await post(other,'/devices/link',{code:linked.code,pin}).expect(201);
 await post(f.a,'/parent/lock').expect(200);const b=await f.begin();
 await post(other,`/calls/${b.call.id}/realtime/audio`,{sessionId:b.result.sessionId,inputId:b.inputId,sequence:0,audioBase64:Buffer.alloc(640).toString('base64')}).expect(403);
 await post(other,`/calls/${b.call.id}/end`).expect(403);assert.equal(f.sessions[0].closed,false);
});


test('realtime same-account new-device login immediately revokes old voice session and late callbacks',async t=>{
 const f=await fixture(t,{},true),b=await f.begin();const next=request.agent(f.server);await post(next,'/account/login',{username:'realtime.fictional',password:'12345678'}).expect(200);await b.reading;assert.equal(f.sessions[0].closed,true);assert.equal(f.app.locals.realtimeSessionCount(),0);assert.match(b.events(),/account-replaced/);const before=b.events();f.sessions[0].input.onEvent(transcript('旧身份隐私'));f.sessions[0].input.onEvent(reply('旧答案'));assert.equal(b.events(),before);await post(f.a,`/calls/${b.call.id}/realtime/commit`,{sessionId:b.result.sessionId,inputId:b.inputId}).expect(401);await next.get('/api/account/session').expect(200);
});

test('realtime enabled switch gates only alternate voice; read-only bootstrap cannot consume supplier',async t=>{
 const f=await fixture(t,{realtimeProvider:undefined,env:{VOLC_SPEECH_API_KEY:'synthetic',VOLC_REALTIME_ENABLED:'false'}});assert.equal((await f.a.get('/api/bootstrap')).body.realtime.configured,false);const call=(await post(f.a,'/calls',{operationId:randomUUID()}).expect(201)).body;await post(f.a,`/calls/${call.id}/realtime/start`).expect(503);await post(f.a,`/calls/${call.id}/turn`,{text:'今天画猫',operationId:randomUUID()}).expect(200);assert.equal(f.sessions.length,0);
});


test('realtime private memories override shared ones only for child context; unknown speaker remains isolated',async t=>{
 const f=await fixture(t,{env:{API_BASE_URL:'https://fictional.invalid/v1',API_KEY:'fictional',CHAT_MODEL:'fictional'},fetch:(async()=>Response.json({choices:[{message:{content:'虚构回答。'},finish_reason:'stop'}]})) as typeof fetch},true);
 const original=(await post(f.a,'/calls',{operationId:randomUUID()}).expect(201)).body;
 const candidate=(await post(f.a,`/calls/${original.id}/turn`,{text:'帮我记住小屋叫星星屋',operationId:randomUUID()}).expect(200)).body.candidate;assert.ok(candidate);
 await post(f.a,`/calls/${original.id}/memory/confirm`,{candidateId:candidate.id,operationId:randomUUID()}).expect(200);await post(f.a,`/calls/${original.id}/end`).expect(200);
 const b=await f.begin();assert.match(f.sessions[0].input.systemPrompt,/小屋叫星星屋/);assert.match(f.sessions[0].input.systemPrompt,/当前账号登记的小朋友称呼/);await post(f.a,`/calls/${b.call.id}/end`).expect(200);
 await post(f.a,'/parent/unlock',{pin}).expect(200);await f.a.patch('/api/parent/settings').set('Origin',origin).send({voiceEnabled:true}).expect(200);await post(f.a,'/parent/lock').expect(200);
 const c=await f.begin();assert.match(f.sessions[1].input.systemPrompt,/当前说话者：unknown/);assert.equal(f.sessions[1].input.systemPrompt.includes('小屋叫星星屋'),false);assert.equal(f.sessions[1].input.systemPrompt.includes('当前账号登记的小朋友称呼'),false);await send(f,c);await post(f.a,`/calls/${c.call.id}/end`).expect(200);await post(f.a,'/parent/unlock',{pin}).expect(200);assert.equal((await f.a.get('/api/parent/memories')).body.dailySummaries.records.length,0);
});


test('continuous app accepts session stream across turns without listen or commit; interrupted topic is excluded from memory',async t=>{
 const f=await fixture(t),b=await f.begin('continuous'),session=f.sessions[0],event=session.input.onEvent;assert.equal(b.result.mode,'continuous');assert.equal(session.input.continuous,true);
 const audio=(sequence:number)=>post(f.a,`/calls/${b.call.id}/realtime/audio`,{sessionId:b.result.sessionId,sequence,audioBase64:Buffer.alloc(640).toString('base64')});
 await audio(0).expect(200);event({type:'speech-start',questionId:'q1'});event({...transcript('我今天上学很难过'),questionId:'q1'});event({...reply('你刚才'),final:false,questionId:'q1',responseId:'r1'});
 await audio(1).expect(200);event({type:'speech-start',questionId:'q2'});event({...transcript('今天画小猫特别开心'),questionId:'q2'});event({...reply('旧故事不应出现'),questionId:'q1',responseId:'r1'});event({type:'reply-end',questionId:'q1',responseId:'r1'});event({...reply('小猫上场啦'),questionId:'q2',responseId:'r2'});event({type:'audio',bytes:Buffer.alloc(640),questionId:'q2',responseId:'r2'});event({type:'reply-end',questionId:'q2',responseId:'r2'});
 await audio(2).expect(200);await wait(()=>b.events().includes('reply-end'));const starts=b.events().split('data: ').slice(1).map(part=>JSON.parse(part.split('\n')[0])).filter(value=>value.type==='speech-start');const responseId=starts.at(-1).responseId;await post(f.a,`/calls/${b.call.id}/realtime/heard`,{sessionId:b.result.sessionId,responseId}).expect(200);await post(f.a,`/calls/${b.call.id}/realtime/heard`,{sessionId:b.result.sessionId,responseId}).expect(200);await post(f.a,`/calls/${b.call.id}/realtime/listen`,{sessionId:b.result.sessionId}).expect(409);await post(f.a,`/calls/${b.call.id}/realtime/commit`,{sessionId:b.result.sessionId,inputId:randomUUID()}).expect(409);await post(f.a,`/calls/${b.call.id}/realtime/interrupt`,{sessionId:b.result.sessionId}).expect(409);
 await post(f.a,`/calls/${b.call.id}/end`).expect(200);await b.reading;assert.equal(session.closed,true);assert.equal(session.committed,0);assert.equal(f.sessions.length,1);assert.match(b.events(),/speech-start/);assert.equal(b.events().includes('input-ended'),false);assert.equal(b.events().includes('旧故事不应出现'),false);
 await post(f.a,'/parent/unlock',{pin}).expect(200);const memory=(await f.a.get('/api/parent/memories').expect(200)).body;assert.equal(memory.dailySummaries.records.length,1);assert.equal(JSON.stringify(memory.dailySummaries.records).includes('难过'),false);
});

test('continuous app retains privacy stop and single-device immediate revocation',async t=>{
 const a=await fixture(t),b=await a.begin('continuous'),event=a.sessions[0].input.onEvent;event({type:'speech-start',questionId:'q'});event({...transcript('我的密码是一个秘密'),questionId:'q'});event({...reply('不应该念出来'),questionId:'q',responseId:'r'});event({type:'audio',bytes:Buffer.alloc(640),questionId:'q',responseId:'r'});await b.reading;assert.equal(a.sessions[0].closed,true);assert.match(b.events(),/REALTIME_PRIVACY/);assert.equal(b.events().includes('audioBase64'),false);
 const f=await fixture(t,{},true),c=await f.begin('continuous');const next=request.agent(f.server);await post(next,'/account/login',{username:'realtime.fictional',password:'12345678'}).expect(200);await c.reading;assert.equal(f.sessions[0].closed,true);assert.match(c.events(),/account-replaced/);const before=c.events();f.sessions[0].input.onEvent({type:'speech-start',questionId:'late'});f.sessions[0].input.onEvent({...transcript('退出后旧内容'),questionId:'late'});assert.equal(c.events(),before);await post(f.a,`/calls/${c.call.id}/realtime/audio`,{sessionId:c.result.sessionId,sequence:0,audioBase64:Buffer.alloc(640).toString('base64')}).expect(401);
});


test('continuous heard route requires same authorized device and heard completion before normal end saves memory',async t=>{
 const f=await fixture(t),b=await f.begin('continuous'),event=f.sessions[0].input.onEvent;event({type:'speech-start',questionId:'q'});event({...transcript('今天画画很开心'),questionId:'q'});event({...reply('小猫上场啦'),questionId:'q',responseId:'r'});event({type:'reply-end',questionId:'q',responseId:'r'});await wait(()=>b.events().includes('reply-end'));const responseId=b.events().split('data: ').slice(1).map(part=>JSON.parse(part.split('\n')[0])).find(value=>value.type==='speech-start').responseId;
 await request(f.server).post(`/api/calls/${b.call.id}/realtime/heard`).set('Origin',origin).send({sessionId:b.result.sessionId,responseId}).expect(401);await f.a.post(`/api/calls/${b.call.id}/realtime/heard`).send({sessionId:b.result.sessionId,responseId}).expect(403);
 await post(f.a,`/calls/${b.call.id}/end`).expect(200);await post(f.a,'/parent/unlock',{pin}).expect(200);assert.equal((await f.a.get('/api/parent/memories')).body.dailySummaries.records.length,0);await post(f.a,`/calls/${b.call.id}/realtime/heard`,{sessionId:b.result.sessionId,responseId}).expect(410);
});
