import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRealtimeSessions} from '../apps/server/src/realtime-session.js';
import type {VolcRealtimeProvider,VolcRealtimeConnectInput,VolcRealtimeSession,VolcRealtimeEvent} from '../apps/server/src/volc-realtime.js';

class Sink extends EventEmitter {
 destroyed=false;writableEnded=false;writableLength=0;returns=false;frames:Record<string,any>[]=[];
 set(){return this;}flushHeaders(){}write(value:string){if(value.startsWith('event:'))this.frames.push(JSON.parse(value.split('data: ')[1]));return this.returns;}
 end(){this.writableEnded=true;this.emit('close');}
}
function fixture(mode:'manual'|'continuous'='manual',sendDelayMs=0){
 const sessions:{input:VolcRealtimeConnectInput;frames:Buffer[];times:number[];muted:boolean[];commits:number;closed:number;interrupted:number;abortedAtClose?:boolean}[]=[];
 let acquired=0,released=0,consumed=0,valid=true;const ended:string[]=[],turns:any[]=[];
 const provider:VolcRealtimeProvider={configured:true,voice:'test',async connect(input){const row={input,frames:[] as Buffer[],times:[] as number[],muted:[] as boolean[],commits:0,closed:0,interrupted:0,abortedAtClose:undefined as boolean|undefined};sessions.push(row);return {closed:false,async sendAudio(bytes){row.frames.push(Buffer.from(bytes));row.times.push(performance.now());if(sendDelayMs)await new Promise(resolve=>setTimeout(resolve,sendDelayMs));},async mute(v){row.muted.push(v);},async commit(){row.commits++;},async interrupt(){row.interrupted++;row.abortedAtClose=input.signal?.aborted;},async close(){row.closed++;row.abortedAtClose=input.signal?.aborted;}};}};
 const manager=createRealtimeSessions({provider,acquire:()=>{acquired++;return()=>{released++;};},consume:()=>{consumed++;}});
 const scope={callId:'call',deviceHash:'device',assertCurrent:()=>{if(!valid)throw Error('secret authorization details');},instructions:()=>JSON.stringify(turns),onTranscript:()=>{},onReply:()=>{},onTurn:(...args:any[])=>turns.push(args),onEnded:(reason:string)=>ended.push(reason)};
 const result=manager.start(scope,{mode}),entry=manager.get('call',result.sessionId,'device'),sink=new Sink();manager.events(entry,sink as any);
 return {manager,entry,sink,sessions,ended,turns,scope,result,setValid:(v:boolean)=>{valid=v;},counts:()=>({acquired,released,consumed})};
}
const tick=()=>new Promise(r=>setTimeout(r,0));
const pcm=(bytes=3200,n=1)=>Buffer.alloc(bytes,n).toString('base64');
const transcript=(text:string,final=true):VolcRealtimeEvent=>({type:'transcript',text,delta:text,replace:true,final});
const reply=(text:string):VolcRealtimeEvent=>({type:'reply-text',text,delta:text,replace:false,final:true});

test('realtime keeps normal Node write=false backpressure, starts muted and only sends ordered paced PCM',async t=>{
 const f=fixture();t.after(()=>f.manager.close());await tick();await f.manager.listen(f.entry);assert.equal(f.sink.frames[0].type,'ready');assert.deepEqual(f.sessions[0].muted,[true]);
 f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:0,audioBase64:pcm()});assert.equal(f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:0,audioBase64:pcm()}).duplicate,true);
 assert.throws(()=>f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:2,audioBase64:pcm()}),{code:'REALTIME_SEQUENCE'});
 await f.manager.commit(f.entry,f.entry.inputId!);const s=f.sessions[0];assert.equal(s.frames.length,5);assert.ok(s.times.at(-1)!-s.times[0]>=65);assert.ok(s.frames.every(b=>b.length===640&&b[0]===1));assert.deepEqual(s.muted,[true,false,true]);assert.equal(s.commits,1);assert.equal(f.counts().consumed,2);
 s.input.onEvent(transcript('今天我画了一只猫'));s.input.onEvent(reply('猫咪上场啦。'));s.input.onEvent({type:'audio',bytes:Buffer.alloc(96000)});s.input.onEvent({type:'reply-end'});
 assert.equal(f.turns.length,1);assert.equal(f.sink.frames.find(v=>v.type==='audio')?.sampleRate,24000);assert.equal(f.manager.count(),1);
});

test('realtime accepts aggregated 500ms packets, rejects malformed, oversized, and bounded queue overflow',async t=>{
 const f=fixture();t.after(()=>f.manager.close());await tick();await f.manager.listen(f.entry);
 for(const audioBase64 of [pcm(16002),'not audio',Buffer.alloc(3).toString('base64'),'AA==='])assert.throws(()=>f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:0,audioBase64}),{code:'REALTIME_AUDIO_INVALID'});
 for(let sequence=0;sequence<4;sequence++)f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence,audioBase64:pcm(16000)});
 assert.throws(()=>f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:4,audioBase64:pcm(16000)}),{code:'REALTIME_AUDIO_RATE'});
});

test('realtime interrupt closes previous upstream before abort and ignores every late generation',async t=>{
 const f=fixture();t.after(()=>f.manager.close());await tick();await f.manager.listen(f.entry);
 f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:0,audioBase64:pcm(640)});await f.manager.commit(f.entry,f.entry.inputId!);
 const old=f.sessions[0];old.input.onEvent(transcript('今天画了猫'));old.input.onEvent(reply('小猫上场啦'));old.input.onEvent({type:'reply-end'});
 await f.manager.interrupt(f.entry);assert.equal(old.interrupted,1);assert.equal(old.abortedAtClose,false);assert.equal(old.input.signal?.aborted,true);assert.equal(f.sessions.length,2);assert.match(f.sessions[1].input.systemPrompt,/今天画了猫/);
 const before=f.sink.frames.length;for(const event of [transcript('旧句'),reply('旧答'),{type:'audio',bytes:Buffer.alloc(640)},{type:'closed'}] as VolcRealtimeEvent[])old.input.onEvent(event);assert.equal(f.sink.frames.length,before);assert.equal(f.manager.count(),1);
 await f.manager.listen(f.entry);f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:0,audioBase64:pcm(640)});await f.manager.commit(f.entry,f.entry.inputId!);f.manager.stopCall('call','ended');await tick();assert.equal(f.sessions[1].abortedAtClose,false);assert.equal(f.sessions[1].input.signal?.aborted,true);assert.equal(f.counts().released,2);
});

test('realtime transcript corrections replace snapshots, stable reply IDs, and completed turns record only once',async t=>{
 const f=fixture();t.after(()=>f.manager.close());await tick();await f.manager.listen(f.entry);f.manager.audio(f.entry,{inputId:f.entry.inputId!,sequence:0,audioBase64:pcm(640)});await f.manager.commit(f.entry,f.entry.inputId!);const send=f.sessions[0].input.onEvent;
 send(transcript('保研',false));send(transcript('宝妍'));send(reply('我在呢。'));send({type:'reply-end'});send({type:'reply-end'});
 assert.deepEqual(f.sink.frames.filter(v=>v.type==='transcript').map(v=>v.text),['保研','宝妍']);assert.equal(f.turns[0][0],'宝妍');assert.equal(f.turns.length,1);
 assert.equal(f.sink.frames.find(v=>v.type==='reply-text')?.responseId,f.sink.frames.find(v=>v.type==='reply-end')?.responseId);
});

test('realtime fails closed on stale authorization, private unknown errors, incomplete ASR and slow consumer',async()=>{
 const a=fixture();await tick();await a.manager.listen(a.entry);a.setValid(false);a.sessions[0].input.onEvent(transcript('不要泄露'));assert.equal(a.manager.count(),0);assert.equal(JSON.stringify(a.sink.frames).includes('secret authorization'),false);
 const b=fixture();await tick();await b.manager.listen(b.entry);b.sessions[0].input.onEvent({type:'audio',bytes:Buffer.alloc(640)});assert.equal(b.sink.frames.find(v=>v.type==='error')?.code,'REALTIME_TRANSCRIPT_REQUIRED');assert.equal(b.sink.frames.some(v=>v.type==='audio'),false);
 const c=fixture();await tick();await c.manager.listen(c.entry);c.sink.writableLength=128001;c.sessions[0].input.onEvent(transcript('今日虚构'));assert.equal(c.manager.count(),0);
});

test('realtime enforces device, singleton subscription, disconnected shutdown and no usage fabrication',async()=>{
 const f=fixture();await tick();assert.throws(()=>f.manager.get('call',f.result.sessionId,'another'),{code:'REALTIME_ENDED'});assert.throws(()=>f.manager.start(f.scope),{code:'REALTIME_EXISTS'});assert.throws(()=>f.manager.events(f.entry,new Sink() as any),{code:'REALTIME_STREAM_EXISTS'});
 assert.equal(f.sink.frames.some(v=>v.type==='usage'),false);f.sink.emit('close');await tick();assert.equal(f.manager.count(),0);assert.deepEqual(f.ended,['realtime-disconnected']);assert.equal(f.sessions[0].closed,1);
});

test('native VAD ends capture immediately, drops tail PCM, and isolates old HTTP/native IDs from next listen',async t=>{
 const f=fixture();t.after(()=>f.manager.close());await tick();const first=await f.manager.listen(f.entry);const session=f.sessions[0];
 f.manager.audio(f.entry,{inputId:first.inputId,sequence:0,audioBase64:pcm(16000)});
 session.input.onEvent({...transcript('第一句画小猫'),questionId:'question-1'});
 assert.equal(f.entry.receiving,false);assert.equal(f.entry.queuedBytes,0);assert.deepEqual(f.sink.frames.find(v=>v.type==='input-ended'),{type:'input-ended',reason:'vad',inputId:first.inputId});
 assert.equal(f.manager.audio(f.entry,{inputId:first.inputId,sequence:999,audioBase64:pcm()}).discarded,true);assert.equal((await f.manager.commit(f.entry,first.inputId)).discarded,true);assert.equal(session.commits,0);
 await assert.rejects(f.manager.listen(f.entry),{code:'REALTIME_NOT_READY'});
 session.input.onEvent({...reply('小猫上场啦'),responseId:'response-1'});session.input.onEvent({type:'reply-end',responseId:'response-1'});
 const second=await f.manager.listen(f.entry);assert.notEqual(first.inputId,second.inputId);assert.equal(f.entry.sequence,0);
 const before=f.sink.frames.length;session.input.onEvent({...transcript('旧句不覆盖'),questionId:'question-1'});session.input.onEvent({...reply('旧回复不覆盖'),responseId:'response-1'});session.input.onEvent({type:'audio',bytes:Buffer.alloc(640),responseId:'response-1'});assert.equal(f.sink.frames.length,before);
 assert.equal(f.manager.audio(f.entry,{inputId:first.inputId,sequence:1000,audioBase64:pcm()}).discarded,true);assert.equal((await f.manager.commit(f.entry,first.inputId)).discarded,true);assert.equal(f.entry.receiving,true);assert.equal(f.entry.sequence,0);
 f.manager.audio(f.entry,{inputId:second.inputId,sequence:0,audioBase64:pcm(640)});await f.manager.commit(f.entry,second.inputId);assert.equal(session.commits,1);
 session.input.onEvent({...transcript('第二句搭积木'),questionId:'question-2'});session.input.onEvent({...reply('积木搭起来啦'),responseId:'response-2'});session.input.onEvent({type:'reply-end',responseId:'response-2'});
 assert.deepEqual(f.turns.map(v=>v[0]),['第一句画小猫','第二句搭积木']);assert.notEqual(f.turns[0][2],f.turns[1][2]);
 assert.equal(f.sink.frames.filter(v=>v.type==='input-ended').at(-1)?.reason,'manual');
});

test('native overlap stops rather than overwrites; missing final reply cannot enter memory; server enforces 30 seconds',async t=>{
 const a=fixture();t.after(()=>a.manager.close());await tick();await a.manager.listen(a.entry);a.sessions[0].input.onEvent({...transcript('第一句话'),questionId:'one'});a.sessions[0].input.onEvent({...transcript('重叠的另一句话'),questionId:'two'});assert.equal(a.manager.count(),0);assert.equal(a.sink.frames.find(v=>v.type==='error')?.code,'REALTIME_TURN_OVERLAP');
 const b=fixture();t.after(()=>b.manager.close());await tick();const second=await b.manager.listen(b.entry);b.manager.audio(b.entry,{inputId:second.inputId,sequence:0,audioBase64:pcm(640)});await b.manager.commit(b.entry,second.inputId);b.sessions[0].input.onEvent(transcript('今天画画'));b.sessions[0].input.onEvent({...reply('还没有生成完'),final:false});b.sessions[0].input.onEvent({type:'reply-end'});assert.equal(b.turns.length,0);
 const c=fixture();t.after(()=>c.manager.close());await tick();const third=await c.manager.listen(c.entry);c.entry.turnBytes=959360;c.manager.audio(c.entry,{inputId:third.inputId,sequence:0,audioBase64:pcm(640)});assert.equal(c.entry.turnBytes,960000);assert.throws(()=>c.manager.audio(c.entry,{inputId:third.inputId,sequence:1,audioBase64:pcm(640)}),{code:'REALTIME_RECORDING_LIMIT'});
});


test('continuous capture stays open across native turns with session sequence and no manual actions',async t=>{
 const f=fixture('continuous');t.after(()=>f.manager.close());await tick();const s=f.sessions[0],event=s.input.onEvent;
 assert.equal(f.result.mode,'continuous');assert.equal(s.input.continuous,true);assert.equal(f.entry.receiving,true);assert.deepEqual(s.muted,f.entry.sequence?[true,false]:[true]);
 await assert.rejects(f.manager.listen(f.entry),{code:'REALTIME_CONTINUOUS'});await assert.rejects(f.manager.commit(f.entry,'anything'),{code:'REALTIME_CONTINUOUS'});await assert.rejects(f.manager.interrupt(f.entry),{code:'REALTIME_CONTINUOUS'});
 f.manager.audio(f.entry,{sequence:0,audioBase64:pcm(640)});
 event({type:'speech-start'});event({...transcript('今天画了小猫'),questionId:'q1'});const one=f.sink.frames.find(v=>v.type==='speech-start');assert.ok(one?.utteranceId&&one?.responseId);
 event({...reply('小猫上场啦'),questionId:'q1',responseId:'r1'});event({type:'audio',bytes:Buffer.alloc(640),questionId:'q1',responseId:'r1'});event({type:'reply-end',questionId:'q1',responseId:'r1'});
 assert.equal(f.turns.length,0);f.manager.heard(f.entry,one!.responseId);assert.equal(f.entry.receiving,true);assert.equal(f.entry.sequence,1);assert.equal(f.sink.frames.some(v=>v.type==='input-ended'),false);assert.deepEqual(s.muted,f.entry.sequence?[true,false]:[true]);
 f.manager.audio(f.entry,{sequence:1,audioBase64:pcm(640)});event({type:'speech-start',questionId:'q2'});event({...transcript('我又搭了积木'),questionId:'q2'});event({...reply('这回搭了什么呀'),questionId:'q2',responseId:'r2'});event({type:'reply-end',questionId:'q2',responseId:'r2'});
 f.manager.heard(f.entry,f.sink.frames.filter(v=>v.type==='speech-start').at(-1)!.responseId);await f.entry.sending;assert.equal(s.frames.length,2);assert.equal(s.commits,0);assert.equal(s.interrupted,0);assert.equal(f.sessions.length,1);assert.equal(f.entry.sequence,2);assert.equal(f.turns.length,2);assert.notEqual(f.turns[0][2],f.turns[1][2]);assert.deepEqual(f.counts(),{acquired:1,released:0,consumed:3});
});

test('continuous opening speech retires interrupted output without resetting upload and records only completed new turn',async t=>{
 const f=fixture('continuous');t.after(()=>f.manager.close());await tick();const s=f.sessions[0],event=s.input.onEvent;
 f.manager.audio(f.entry,{sequence:0,audioBase64:pcm(640)});event({type:'speech-start',questionId:'old-q'});event({...transcript('第一句'),questionId:'old-q'});event({...reply('还没说完'),final:false,questionId:'old-q',responseId:'old-r'});event({type:'audio',bytes:Buffer.alloc(640),questionId:'old-q',responseId:'old-r'});
 event({type:'speech-start'});assert.equal(f.sink.frames.filter(v=>v.type==='speech-start').at(-1)?.interrupted,true);const before=f.sink.frames.length;
 for(const value of [{...transcript('旧转写迟到'),questionId:'old-q'},{...reply('旧回复迟到'),questionId:'old-q',responseId:'old-r'},{type:'audio',bytes:Buffer.alloc(640),questionId:'old-q',responseId:'old-r'},{type:'reply-end',questionId:'old-q',responseId:'old-r'},{type:'audio',bytes:Buffer.alloc(640)},{...reply('缺失绑定')} ] as VolcRealtimeEvent[])event(value);
 assert.equal(f.sink.frames.length,before);assert.equal(f.manager.count(),1);assert.equal(f.turns.length,0);assert.equal(f.entry.sequence,1);
 f.manager.audio(f.entry,{sequence:1,audioBase64:pcm(640)});event({...transcript('换个话题吧'),questionId:'new-q'});event({...reply('好呀，换一个'),questionId:'new-q',responseId:'new-r'});event({type:'audio',bytes:Buffer.alloc(640),questionId:'new-q',responseId:'new-r'});event({type:'reply-end',questionId:'new-q',responseId:'new-r'});event({type:'reply-end',questionId:'new-q',responseId:'new-r'});
 assert.equal(f.turns.length,0);f.manager.heard(f.entry,f.sink.frames.filter(v=>v.type==='speech-start').at(-1)!.responseId);assert.equal(f.turns.length,1);assert.equal(f.turns[0][0],'换个话题吧');assert.equal(f.entry.sequence,2);assert.deepEqual(s.muted,f.entry.sequence?[true,false]:[true]);assert.equal(s.closed,0);
});

test('continuous input-final safety boundary, bounded turns and unchanged upload pacing remain enforced',async t=>{
 const a=fixture('continuous');t.after(()=>a.manager.close());await tick();a.sessions[0].input.onEvent({type:'speech-start',questionId:'q'});a.sessions[0].input.onEvent({...transcript('还在说',false),questionId:'q'});a.sessions[0].input.onEvent({type:'audio',bytes:Buffer.alloc(640),questionId:'q',responseId:'r'});assert.equal(a.manager.count(),0);assert.equal(a.sink.frames.find(v=>v.type==='error')?.code,'REALTIME_TRANSCRIPT_REQUIRED');assert.equal(a.sink.frames.some(v=>v.type==='audio'),false);
 const b=fixture('continuous');t.after(()=>b.manager.close());await tick();for(let n=0;n<100;n++)b.sessions[0].input.onEvent({type:'speech-start',questionId:`q${n}`});assert.equal(b.manager.count(),1);b.sessions[0].input.onEvent({type:'speech-start',questionId:'q101'});assert.equal(b.manager.count(),0);assert.equal(b.sink.frames.find(v=>v.type==='error')?.code,'REALTIME_TURN_LIMIT');assert.ok(b.entry.retiredQuestions.size<=100);
 const c=fixture('continuous');t.after(()=>c.manager.close());await tick();assert.throws(()=>c.manager.audio(c.entry,{inputId:'old-client-turn',sequence:0,audioBase64:pcm(640)}),{code:'REALTIME_AUDIO_INVALID'});for(let sequence=0;sequence<4;sequence++)c.manager.audio(c.entry,{sequence,audioBase64:pcm(16000)});assert.throws(()=>c.manager.audio(c.entry,{sequence:4,audioBase64:pcm(16000)}),{code:'REALTIME_AUDIO_RATE'});
});

test('continuous utterance deadline excludes idle silence and clears after native final',async t=>{
 const f=fixture('continuous');t.after(()=>f.manager.close());await tick();t.mock.timers.enable({apis:['setTimeout']});
 t.mock.timers.tick(31_000);assert.equal(f.manager.count(),1);
 const event=f.sessions[0].input.onEvent;event({type:'speech-start',questionId:'q1'});t.mock.timers.tick(29_000);assert.equal(f.manager.count(),1);event({...transcript('一句话说完'),questionId:'q1'});t.mock.timers.tick(31_000);assert.equal(f.manager.count(),1);
 event({type:'speech-start',questionId:'q2'});t.mock.timers.tick(30_000);assert.equal(f.manager.count(),0);assert.equal(f.sink.frames.find(v=>v.type==='error')?.code,'REALTIME_RECORDING_LIMIT');
});


test('continuous memory waits for playback acknowledgement and discards a completed but unheard reply on interruption',async t=>{
 const f=fixture('continuous');t.after(()=>f.manager.close());await tick();const event=f.sessions[0].input.onEvent;
 const complete=(q:string,r:string)=>{event({type:'speech-start',questionId:q});const id=f.sink.frames.filter(v=>v.type==='speech-start').at(-1)!.responseId;event({...transcript('今天画画很开心'),questionId:q});event({...reply('小猫画好啦'),questionId:q,responseId:r});return id;};
 const first=complete('q1','r1');assert.equal(f.manager.heard(f.entry,first).discarded,true);event({type:'reply-end',questionId:'q1',responseId:'r1'});assert.equal(f.turns.length,0);
 const second=complete('q2','r2');assert.equal(f.sink.frames.filter(v=>v.type==='speech-start').at(-1)?.interrupted,true);assert.equal(f.manager.heard(f.entry,first).discarded,true);assert.equal(f.turns.length,0);event({type:'reply-end',questionId:'q2',responseId:'r2'});assert.deepEqual(f.manager.heard(f.entry,second),{ok:true});assert.equal(f.turns.length,1);assert.equal(f.manager.heard(f.entry,second).duplicate,true);assert.equal(f.turns.length,1);
 for(let n=0;n<16;n++)f.manager.heard(f.entry,'stale');assert.throws(()=>f.manager.heard(f.entry,'overflow'),{code:'REALTIME_ACK_RATE'});assert.equal(f.turns.length,1);
});


test('continuous 20 ms pacing subtracts supplier send cost rather than accumulating it every frame',async t=>{
 const f=fixture('continuous',10);t.after(()=>f.manager.close());await tick();f.manager.audio(f.entry,{sequence:0,audioBase64:pcm(16000)});f.manager.audio(f.entry,{sequence:1,audioBase64:pcm(16000)});await f.entry.sending;
 const times=f.sessions[0].times;assert.equal(times.length,50);const elapsed=times.at(-1)!-times[0];assert.ok(elapsed>=900,`not burst paced: ${elapsed}`);assert.ok(elapsed<1300,`send delay should not compound: ${elapsed}`);assert.ok(times.slice(1).every((value,index)=>value-times[index]>=8),'no bulk catch-up');
});
