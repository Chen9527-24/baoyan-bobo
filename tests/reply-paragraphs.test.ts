import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {replyParagraphs} from '../apps/web/src/lib/replyParagraphs.js';
import {createApp} from '../apps/server/src/app.js';

test('model-chosen paragraph boundaries preserve content without splitting every sentence or counting words',()=>{
 assert.deepEqual(replyParagraphs('整理好啦。这下找东西顺手多了！'),['整理好啦。这下找东西顺手多了！']);
 assert.deepEqual(replyParagraphs('又倒了，真扫兴。\r\n\r\n今天先歇一会儿也行。'),['又倒了，真扫兴。','今天先歇一会儿也行。']);
 assert.deepEqual(replyParagraphs('要试的话，先放稳底座。\n上面的积木轻轻放。'),['要试的话，先放稳底座。\n上面的积木轻轻放。']);
});
test('paragraph reply is the exact text registered for voice, without extra model or speech requests',async t=>{
 const spoken:string[]=[],reply='又倒了，真扫兴。\n\n今天先歇一会儿也行。';let chats=0;
 const app=createApp({dataPath:':memory:',env:{CHAT_PROVIDER:'volc',CHAT_API_BASE_URL:'https://mock.invalid/v3',CHAT_API_KEY:'synthetic-only',CHAT_MODEL:'test',TTS_PROVIDER:'volc',VOLC_SPEECH_API_KEY:'synthetic-only',VOLC_TTS_URL:'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',VOLC_TTS_VOICE_ID:'zh_female_vv_uranus_bigtts'},fetch:async(url,init)=>{
  const body=JSON.parse(String(init?.body));if(String(url).includes('tts/')){spoken.push(body.req_params.text);return new Response('event: 352\ndata: {"code":0,"data":"AQI="}\n\nevent: 152\ndata: {"code":20000000,"data":null}\n\n',{headers:{'Content-Type':'text/event-stream'}});}chats++;return Response.json({choices:[{finish_reason:'stop',message:{content:reply}}]});
 }});t.after(()=>app.locals.close());const a=request.agent(app),post=(p:string,b:unknown)=>a.post('/api'+p).set('Origin','http://localhost:5173').send(b);
 await post('/setup',{pin:'123456',nickname:'虚构分段',ageGroup:'6-8',sessionMinutes:10,dailyMinutes:20,consent:true,memoryEnabled:false}).expect(201);
 const call=(await post('/calls',{operationId:crypto.randomUUID()}).expect(201)).body;
 const turn=(await post('/calls/'+call.id+'/turn',{operationId:crypto.randomUUID(),text:'积木又倒了，我不想搭了'}).expect(200)).body;assert.equal(turn.reply,reply);
 await post('/calls/'+call.id+'/speech',{replyId:turn.replyId}).expect(200);assert.deepEqual(spoken,[reply]);assert.equal(chats,1);
});
