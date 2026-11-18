import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream';
import { ApiError } from '../apps/web/src/lib/api';

const transcript='我想继续这个故事';
const base={reply:'我们接着听。',replyId:crypto.randomUUID(),mode:'live',memoryRevision:1,globalRevision:2,speakerRevision:3,transcript};
const read=(turn:unknown)=>readAudioTurnStream(new Response(`${JSON.stringify({type:'transcript',text:transcript})}\n${JSON.stringify({type:'turn',turn})}\n`,{headers:{'content-type':'application/x-ndjson'}}),()=>{});
test('software metadata keeps a goodbye or safety Turn compatible with the strict audio protocol',async()=>{
 const turn={...base,endCall:true,conversationMode:{mode:'chat',dialect:'chaoshan',behavior:'understand'},emotion:'calm'};
 assert.deepEqual(await read(turn),turn);
});
test('validated dialect meaning and bounded interactive story state are retained',async()=>{
 const turn={...base,conversationMode:{mode:'dialect',dialect:'hakka',behavior:'translate'},interpretedText:'我现在准备吃饭',emotion:'warm',story:{id:'a-story',title:'一个小故事',segment:2,total:3,status:'paused',endsAt:new Date(Date.now()+30000).toISOString(),choices:[{id:'help',label:'先找家人'}]}};
 assert.deepEqual(await read(turn),turn);
});
test('validated learning confirmation metadata preserves the question and step',async()=>{
 const turn={...base,learning:{topic:'arithmetic',stage:'confirm',question:'3加4等于多少？',step:0,totalSteps:2,endsAt:Date.now()+30000}};
 assert.deepEqual(await read(turn),turn);
});
for(const metadata of [
 {emotion:['calm']},
 {interpretedText:'字'.repeat(1001)},
 {conversationMode:{mode:'dialect',dialect:'chaoshan',behavior:'unknown'}},
 {conversationMode:{mode:'chat',admin:true}},
 {story:{id:'s',title:'故事',segment:5,total:3,status:'playing',endsAt:new Date().toISOString()}},
 {story:{id:'s',title:'故事',segment:1,total:3,status:'playing',endsAt:'invalid'}},
 {learning:{topic:'arithmetic',stage:'confirm',question:'题目',step:4,totalSteps:2,endsAt:Date.now()}},
 {learning:{topic:'arithmetic',stage:'confirm',question:'题目',step:0,totalSteps:2,endsAt:Date.now(),publish:true}},
])test(`reject malformed software metadata ${JSON.stringify(metadata).slice(0,55)}`,async()=>{
 await assert.rejects(read({...base,...metadata}),error=>error instanceof ApiError&&error.code==='AUDIO_STREAM_INVALID');
});
