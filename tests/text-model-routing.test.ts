import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createProviders} from '../apps/server/src/providers.js';
import {createApp} from '../apps/server/src/app.js';
const lite='doubao-seed-2-1-lite-260915',pro='doubao-seed-2-1-pro-260915';
const env={CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://synthetic.invalid/api/v3',CHAT_API_KEY:'synthetic-only',CHAT_MODEL:lite,VOLC_TEXT_CHAT_MODEL:pro};
const origin='http://localhost:5173';
const answer=(content:string)=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
function wav(){const b=Buffer.alloc(44+32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(1000,i);return b;}
test('text override preserves audio/vision and summary model; non-Byte supplier ignores Byte override',async()=>{
 const calls:any[]=[];const p=createProviders({env,fetch:async(_url,init)=>{const b=JSON.parse(String(init?.body));calls.push(b);return answer(b.response_format?JSON.stringify({meaning:'虚构原音意思',reply:'虚构原音接话'}):'虚构文字');}});
 assert.equal(p.textChatModel,pro);assert.equal(p.recomposeAudioReply,true);assert.equal(p.capabilities.audioUnderstanding,true);assert.equal(p.capabilities.vision,true);
 await p.chat([{role:'user',content:'虚构问题'}]);await p.summarizeMemories([{role:'user',content:'虚构摘要'}],new AbortController().signal);
 await p.understandAudio(wav(),'audio/wav',{dialect:'chaoshan',behavior:'understand',messages:[]});
 assert.deepEqual(calls.map(c=>c.model),[pro,lite,lite]);assert.deepEqual(calls[0].thinking,{type:'disabled'});
 const fallback=createProviders({env:{...env,VOLC_TEXT_CHAT_MODEL:''}});assert.equal(fallback.textChatModel,lite);assert.equal(fallback.recomposeAudioReply,false);
 const other=createProviders({env:{CHAT_PROVIDER:'openai',API_BASE_URL:'https://synthetic.invalid/v1',API_KEY:'synthetic-only',CHAT_MODEL:'ordinary',VOLC_TEXT_CHAT_MODEL:pro}});assert.equal(other.textChatModel,'ordinary');assert.equal(other.recomposeAudioReply,false);
});
for(const behavior of ['understand','translate'] as const){
 test(`dialect ${behavior} respects selected text route and never uses an old precomputed reply`,async t=>{
  const meaning=behavior==='translate'?'只留你，我会一直陪你。':'我做了一只纸船送给你，能放你桌上吗？';
  const calls:any[]=[];const app=createApp({dataPath:':memory:',env,fetch:async(_url,init)=>{const b=JSON.parse(String(init?.body));calls.push(b);return answer(b.model===lite?JSON.stringify({meaning,reply:'这段旧原音回答不得复用'}):'谢谢这份心意，我没有实物桌子。');}});t.after(()=>app.locals.close());const a=request.agent(app),post=(url:string,body:object={})=>a.post(url).set('Origin',origin).send(body);
  await post('/api/setup',{pin:'123456',nickname:'虚构资料',ageGroup:'9-12',sessionMinutes:10,dailyMinutes:30,consent:true}).expect(201);
  const c=(await post('/api/calls',{operationId:randomUUID()}).expect(201)).body;
  await post(`/api/calls/${c.id}/mode`,{mode:'dialect',dialect:'chaoshan',behavior}).expect(200);
  const r=await a.post(`/api/calls/${c.id}/audio`).set('Origin',origin).field('operationId',randomUUID()).attach('audio',wav(),{filename:'synthetic.wav',contentType:'audio/wav'}).expect(200);
  assert.equal(r.body.transcript,meaning);
  if(behavior==='understand'){assert.deepEqual(calls.map(c=>c.model),[lite,pro]);assert.equal(r.body.reply,'谢谢这份心意，我没有实物桌子。');assert.equal(calls[1].messages.at(-1).content,r.body.transcript);assert.match(calls[1].messages[0].content,/本轮没有提供图片/);assert.ok(calls[1].messages.some((m:any)=>/说收到的是心意/.test(m.content)));}
  else {assert.equal(calls.length,1);assert.equal(r.body.reply,r.body.transcript);}
 });
}
test('a canceled dialect text stage cannot leak its reply or execute memory',async t=>{
 let enter!:()=>void;const started=new Promise<void>(r=>enter=r);let aborted=false;
 const app=createApp({dataPath:':memory:',env,fetch:async(_url,init)=>{const b=JSON.parse(String(init?.body));if(b.model===lite)return answer(JSON.stringify({meaning:'我做了纸船',reply:'不得复用'}));enter();return new Promise<Response>((resolve,reject)=>{init?.signal?.addEventListener('abort',()=>{aborted=true;reject(Error('synthetic cancellation'));},{once:true});});}});t.after(()=>app.locals.close());const a=request.agent(app),post=(url:string,body:object={})=>a.post(url).set('Origin',origin).send(body);
 await post('/api/setup',{pin:'123456',nickname:'虚构资料',ageGroup:'9-12',sessionMinutes:10,dailyMinutes:30,consent:true}).expect(201);
 const c=(await post('/api/calls',{operationId:randomUUID()}).expect(201)).body;await post(`/api/calls/${c.id}/mode`,{mode:'dialect',dialect:'chaoshan',behavior:'understand'}).expect(200);
 const pending=a.post(`/api/calls/${c.id}/audio`).set('Origin',origin).field('operationId',randomUUID()).attach('audio',wav(),{filename:'synthetic.wav',contentType:'audio/wav'}).then(r=>r);await started;await post(`/api/calls/${c.id}/cancel`).expect(200);const r=await pending;assert.equal(aborted,true);assert.equal(r.status,409);assert.equal(r.body.reply,undefined);
});


test('unlimited presence is corrected before a generated reply is registered for speech',async t=>{
 const app=createApp({dataPath:':memory:',env,fetch:async()=>answer('我不能保证永远在线，但你想说话的时候我都在。')});t.after(()=>app.locals.close());const a=request.agent(app),post=(url:string,body:object={})=>a.post(url).set('Origin',origin).send(body);
 await post('/api/setup',{pin:'123456',nickname:'虚构资料',ageGroup:'13-14',sessionMinutes:10,dailyMinutes:30,consent:true}).expect(201);const c=(await post('/api/calls',{operationId:randomUUID()}).expect(201)).body;
 const r=await post('/api/calls/'+c.id+'/turn',{text:'只留你，你保证不会离开我？',operationId:randomUUID()}).expect(200);assert.match(r.body.reply,/不能保证永远在线/);assert.doesNotMatch(r.body.reply,/想说话的时候我都在/);assert.ok(r.body.replyId);
});


test('text override does not silently accept an absent required base model',()=>{
 const p=createProviders({env:{...env,CHAT_MODEL:''}});assert.equal(p.capabilities.chat,false);assert.equal(p.capabilities.vision,false);assert.equal(p.capabilities.audioUnderstanding,false);
});
