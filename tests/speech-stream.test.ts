import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReplySpeechStream } from '../apps/web/src/lib/speechStream.js';
import { permitsTextFallback } from '../apps/web/src/lib/replyPlayback.js';

const encode=new TextEncoder();
const format=JSON.stringify({type:'format',format:'pcm_s16le',sampleRate:24000,channels:1})+'\n';
const audio=(bytes=[0,0,255,127])=>JSON.stringify({type:'audio',data:Buffer.from(bytes).toString('base64')})+'\n';
const done='{"type":"done"}\n';
const response=(body:string|ReadableStream<Uint8Array>)=>new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
const mock=(body:string|ReadableStream<Uint8Array>)=>(async()=>response(body)) as typeof fetch;
async function collect(body:string){const chunks=[];for await(const chunk of fetchReplySpeechStream('call','reply',undefined,1000,mock(body)))chunks.push(...chunk);return chunks;}

test('first validated PCM chunk is exposed while terminal/EOF is pending; one request with same-origin reply ID only',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>,calls=0;
  const body=new ReadableStream<Uint8Array>({start(controller){stream=controller;controller.enqueue(encode.encode(format+audio()));}});
  const iterator=fetchReplySpeechStream('call','reply',undefined,1000,(async(url,init)=>{
    calls++;assert.equal(url,'/api/calls/call/speech');assert.equal(init?.credentials,'same-origin');
    assert.equal(new Headers(init?.headers).get('Accept'),'application/x-ndjson');assert.deepEqual(JSON.parse(String(init?.body)),{replyId:'reply'});return response(body);
  }) as typeof fetch);
  assert.deepEqual(Array.from((await iterator.next()).value!),[0,0,255,127]);
  let finished=false;const next=iterator.next().then(value=>{finished=true;return value;});
  await new Promise(r=>setImmediate(r));assert.equal(finished,false);
  stream.enqueue(encode.encode(done));stream.close();assert.equal((await next).done,true);assert.equal(calls,1);
});

test('client parsing is independent of every-byte network boundaries and permits odd chunk boundaries',async()=>{
  const bytes=encode.encode(format+audio([0])+audio([0,255,127])+done);let offset=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){if(offset===bytes.length)controller.close();else controller.enqueue(bytes.slice(offset,++offset));}});
  const result=[];for await(const chunk of fetchReplySpeechStream('call','reply',undefined,1000,mock(body)))result.push(...chunk);
  assert.deepEqual(result,[0,0,255,127]);
});

for(const body of [audio()+done,format+done,format+audio(),format+audio()+done+audio(),format+audio()+done.trimEnd(),format+audio([1])+done,
  format+format+audio()+done,format.replace('24000','16000')+audio()+done,format+'{"type":"audio","data":"AB=="}\n'+done]){
  test(`invalid or truncated protocol is rejected (${body.length} chars)`,async()=>{await assert.rejects(collect(body));});
}
test('mid-stream context rejection retains status/code and never permits stale text fallback',async()=>{
  const body=format+audio()+JSON.stringify({type:'error',status:409,code:'CONTEXT_CHANGED',error:'内容已失效，请重新发起'})+'\n';
  let first=false;await assert.rejects(async()=>{for await(const _ of fetchReplySpeechStream('call','reply',undefined,1000,mock(body)))first=true;},error=>{assert.equal(permitsTextFallback(error),false);return true;});
  assert.equal(first,true);
});
test('caller cancellation interrupts a pending stream read and cancels the response',async()=>{
  let cancelled=0;const controller=new AbortController();
  const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(encode.encode(format+audio()));},cancel(){cancelled++;}});
  const iterator=fetchReplySpeechStream('call','reply',controller.signal,1000,mock(body));await iterator.next();const pending=iterator.next();controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,1);
});
test('bounded wait is ordinary voice fallback and never retries provider',async()=>{
  let calls=0;const body=new ReadableStream<Uint8Array>({});
  await assert.rejects(async()=>{for await(const _ of fetchReplySpeechStream('call','reply',undefined,20,(async()=>{calls++;return response(body);}) as typeof fetch)){}},error=>{assert.equal(permitsTextFallback(error),true);return /超时/.test(String(error));});
  assert.equal(calls,1);
});
