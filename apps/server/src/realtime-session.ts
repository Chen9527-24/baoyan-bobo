import { randomUUID, createHash } from 'node:crypto';
import type { Response } from 'express';
import { ApiError } from './provider-errors.js';
import type { VolcRealtimeProvider, VolcRealtimeSession, VolcRealtimeEvent } from './volc-realtime.js';

const FRAME_BYTES=640, FRAME_MS=20, MAX_QUEUE_BYTES=64_000, MAX_CHUNK_BYTES=16_000;
type Mode='manual'|'continuous';
type Scope={
  callId:string; deviceHash:string; assertCurrent:()=>void; instructions:()=>string;
  onTranscript:(text:string)=>void; onReply:(text:string)=>void;
  onTurn:(input:string,reply:string,id:string)=>void; onEnded:(reason:string)=>void;
};
type Entry=Scope&{
  id:string; mode:Mode; created:number; generation:number; closed:boolean; ready:boolean; connecting:boolean;
  speechStartedAt?:number; speechTimer?:ReturnType<typeof setTimeout>;
  pendingHeard?:{input:string;reply:string;id:string}; lastHeard?:string; heardAttempts:number[];
  response?:Response; provider?:VolcRealtimeSession; controller:AbortController; release?:()=>void;
  inputId?:string; nativeQuestion?:string; nativeResponse?:string; retiredQuestions:Set<string>; retiredResponses:Set<string>; muting?:Promise<void>;
  queue:Buffer[]; queuedBytes:number; partial:Buffer; sending?:Promise<void>; wake?:()=>void; timer?:ReturnType<typeof setTimeout>;
  sequence:number; previousDigest?:string; receivedBytes:number; turnBytes:number; unmuted:boolean; receiving:boolean; committing:boolean;
  input:string; reply:string; responseId:string; utteranceId:string; inputFinal:boolean; replyFinal:boolean; replyComplete:boolean;
  turns:number; connects:number; keepalive?:ReturnType<typeof setInterval>; expires?:ReturnType<typeof setTimeout>;
};
const unavailable=()=>new ApiError(503,'实时语音还没有准备好，请使用普通聊天。','REALTIME_UNAVAILABLE');
const invalid=()=>new ApiError(400,'语音片段格式不正确，请重新开始。','REALTIME_AUDIO_INVALID');
const stopped=()=>new ApiError(409,'这次实时语音已结束，请重新开始。','REALTIME_ENDED');
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');

/** RAM-only transport. A disconnect closes its supplier; audio and captions are never persisted here. */
export function createRealtimeSessions(options:{provider:VolcRealtimeProvider;now?:()=>number;acquire:()=>()=>void;consume:()=>void}){
  const now=options.now??Date.now,entries=new Map<string,Entry>();
  function assertEntry(entry:Entry){if(entry.closed||entries.get(entry.callId)!==entry)throw stopped();entry.assertCurrent();}
  function clearAudio(entry:Entry){for(const frame of entry.queue)frame.fill(0);entry.queue=[];entry.queuedBytes=0;entry.partial.fill(0);entry.partial=Buffer.alloc(0);if(entry.timer)clearTimeout(entry.timer);entry.timer=undefined;entry.wake?.();entry.wake=undefined;}
  function write(entry:Entry,payload:Record<string,unknown>){
    const response=entry.response;if(!response||response.destroyed||response.writableEnded)return false;
    if(response.writableLength>128_000)return false;
    response.write(`event: realtime\ndata: ${JSON.stringify(payload)}\n\n`);return true;
  }
  function stop(entry:Entry,reason:string,notify=true){
    if(entry.closed)return;entry.closed=true;entry.ready=false;entries.delete(entry.callId);entry.generation++;
    clearAudio(entry);clearTimeout(entry.expires);clearTimeout(entry.speechTimer);clearInterval(entry.keepalive);
    const controller=entry.controller,supplier=entry.provider,release=entry.release;entry.provider=undefined;entry.release=undefined;
    if(supplier)void supplier.close().catch(()=>{}).finally(()=>{controller.abort();release?.();});else{controller.abort();release?.();}
    write(entry,{type:'ended',reason});entry.response?.end();entry.input='';entry.reply='';entry.pendingHeard=undefined;entry.lastHeard=undefined;entry.heardAttempts=[];
    if(notify)entry.onEnded(reason);
  }
  function fail(entry:Entry,error:unknown){
    if(entry.closed)return;const safe=error instanceof ApiError?error:unavailable();
    write(entry,{type:'error',error:safe.message,code:safe.code});stop(entry,'realtime-error');
  }
  function deliver(entry:Entry,payload:Record<string,unknown>){assertEntry(entry);if(!write(entry,payload))throw new ApiError(409,'网络跟不上语音播放，请重新开始。','REALTIME_SLOW_CLIENT');}
  function finishInput(entry:Entry,reason:'vad'|'manual'){
    if(!entry.receiving)return;entry.receiving=false;clearAudio(entry);
    deliver(entry,{type:'input-ended',reason,inputId:entry.inputId});
    const generation=entry.generation;
    const task=entry.provider!.mute(true).then(()=>{if(generation===entry.generation)entry.unmuted=false;});entry.muting=task;
    void task.catch(error=>{if(generation===entry.generation)fail(entry,error);});
  }
  function beginContinuousTurn(entry:Entry,questionId?:string){
    if(questionId&&(entry.retiredQuestions.has(questionId)||entry.nativeQuestion===questionId))return false;
    if(++entry.turns>100)throw new ApiError(429,'这次聊天已说了很多句，我们先休息一下。','REALTIME_TURN_LIMIT');
    options.consume();
    const interrupted=Boolean(entry.inputId&&(!entry.replyComplete||entry.pendingHeard));entry.pendingHeard=undefined;
    if(entry.nativeQuestion)entry.retiredQuestions.add(entry.nativeQuestion);if(entry.nativeResponse)entry.retiredResponses.add(entry.nativeResponse);
    entry.nativeQuestion=questionId;entry.nativeResponse=undefined;entry.inputId=randomUUID();entry.utteranceId=entry.inputId;entry.responseId=randomUUID();entry.input='';entry.reply='';entry.inputFinal=false;entry.replyFinal=false;entry.replyComplete=false;entry.turnBytes=0;
    entry.speechStartedAt=now();clearTimeout(entry.speechTimer);
    const inputId=entry.inputId;entry.speechTimer=setTimeout(()=>{if(!entry.closed&&entry.inputId===inputId&&!entry.inputFinal)fail(entry,new ApiError(413,'这一句说得有点长，我们重新开始聊吧。','REALTIME_RECORDING_LIMIT'));},30_000);entry.speechTimer.unref();
    deliver(entry,{type:'speech-start',utteranceId:entry.utteranceId,responseId:entry.responseId,interrupted});return true;
  }
  function onEvent(entry:Entry,generation:number,event:VolcRealtimeEvent){
    if(entry.closed||generation!==entry.generation)return;
    try{
      assertEntry(entry);
      if(event.type==='ready')return; // Own ready follows successful connection plus initial microphone mute.
      if(event.type==='error'){fail(entry,event.error);return;}
      if(event.type==='closed'){stop(entry,'realtime-disconnected');return;}
      if(event.type==='speech-start'){if(entry.mode==='continuous')beginContinuousTurn(entry,event.questionId);return;}
      if(event.type==='transcript'){
        if(event.questionId&&entry.retiredQuestions.has(event.questionId))return;
        // Missing native started is tolerated only for a fresh identified utterance.
        if(entry.mode==='continuous'&&(!entry.inputId||event.questionId&&entry.nativeQuestion&&event.questionId!==entry.nativeQuestion)){if(!beginContinuousTurn(entry,event.questionId))return;}
        if(!entry.inputId)return;
        if(event.questionId&&entry.nativeQuestion&&event.questionId!==entry.nativeQuestion)throw new ApiError(409,'刚才有两句话重叠了，请重新开始这一句。','REALTIME_TURN_OVERLAP');
        entry.nativeQuestion??=event.questionId;
        if(event.text.length>1000)throw new ApiError(413,'这句话有点长，请分成短一点的几句。','REALTIME_TEXT_LIMIT');
        entry.input=event.text;entry.inputFinal=event.final;
        if(event.final){
          entry.onTranscript(event.text);
          if(entry.mode==='continuous'){clearTimeout(entry.speechTimer);entry.speechTimer=undefined;entry.speechStartedAt=undefined;}
          else finishInput(entry,'vad');
        }
        deliver(entry,{type:'transcript',text:event.text,final:event.final,utteranceId:entry.utteranceId});return;
      }
      if(event.type==='reply-text'||event.type==='audio'||event.type==='reply-end'){
        if(!entry.inputId||event.responseId&&entry.retiredResponses.has(event.responseId)||event.questionId&&entry.retiredQuestions.has(event.questionId))return;
        // Continuous output must belong to the current provider-assigned question.
        // The adapter adds this identity even to otherwise anonymous audio deltas.
        if(entry.mode==='continuous'&&(!event.questionId||!entry.nativeQuestion||event.questionId!==entry.nativeQuestion||!event.responseId))return;
        if(event.responseId&&entry.nativeResponse&&event.responseId!==entry.nativeResponse)throw new ApiError(409,'宝妍的两段回复重叠了，请重新开始。','REALTIME_TURN_OVERLAP');
        entry.nativeResponse??=event.responseId;
      }
      if(event.type==='reply-text'){
        if(event.text.length>4000)throw new ApiError(413,'这次回复太长，已停止播放。','REALTIME_TEXT_LIMIT');
        if(!entry.inputFinal)throw new ApiError(409,'这句还没有听清，请重新说一次。','REALTIME_TRANSCRIPT_REQUIRED');
        entry.onReply(event.text);entry.reply=event.text;entry.replyFinal=event.final;
        deliver(entry,{type:'reply-text',text:event.text,final:event.final,responseId:entry.responseId});return;
      }
      if(event.type==='audio'){
        if(!event.bytes.byteLength||event.bytes.byteLength>192_000||event.bytes.byteLength%2)throw unavailable();
        // Completed ASR is the input safety boundary; never play audio before it arrives.
        if(!entry.inputFinal)throw new ApiError(409,'这句还没有听清，请重新说一次。','REALTIME_TRANSCRIPT_REQUIRED');
        deliver(entry,{type:'audio',audioBase64:Buffer.from(event.bytes).toString('base64'),sampleRate:24000,responseId:entry.responseId});return;
      }
      if(event.type==='reply-end'){
        if(!entry.replyComplete&&entry.inputFinal&&entry.replyFinal&&entry.input.trim()&&entry.reply.trim()){
          if(entry.mode==='continuous')entry.pendingHeard={input:entry.input,reply:entry.reply,id:entry.responseId};
          else entry.onTurn(entry.input,entry.reply,entry.responseId);
        }
        entry.replyComplete=true;deliver(entry,{type:'reply-end',responseId:entry.responseId});return;
      }
      if(event.type==='usage')deliver(entry,{type:'usage',usage:event.usage});
    }catch(error){fail(entry,error);}
  }
  async function connect(entry:Entry){
    assertEntry(entry);if(++entry.connects>8)throw new ApiError(429,'这次切换次数较多，请结束后重新开始。','REALTIME_CONNECT_LIMIT');
    entry.connecting=true;const generation=entry.generation;
    entry.release=options.acquire();options.consume();
    const supplier=await options.provider.connect({systemPrompt:entry.instructions(),continuous:entry.mode==='continuous',signal:entry.controller.signal,onEvent:event=>onEvent(entry,generation,event)});
    if(entry.closed||generation!==entry.generation){void supplier.close().catch(()=>{});throw stopped();}
    entry.provider=supplier;await supplier.mute(true);assertEntry(entry);
    entry.connecting=false;entry.ready=true;entry.receiving=entry.mode==='continuous';entry.unmuted=false;deliver(entry,{type:'ready',mode:entry.mode});
  }
  function start(scope:Scope,settings:{mode?:Mode}={}){
    if(!options.provider.configured)throw unavailable();scope.assertCurrent();
    if(entries.has(scope.callId))throw new ApiError(409,'这次实时语音已经打开，请回到当前页面。','REALTIME_EXISTS');
    const entry:Entry={...scope,id:randomUUID(),mode:settings.mode??'manual',heardAttempts:[],created:now(),generation:1,closed:false,ready:false,connecting:false,controller:new AbortController(),retiredQuestions:new Set(),retiredResponses:new Set(),queue:[],queuedBytes:0,partial:Buffer.alloc(0),sequence:0,receivedBytes:0,turnBytes:0,unmuted:false,receiving:false,committing:false,input:'',reply:'',responseId:randomUUID(),utteranceId:randomUUID(),inputFinal:false,replyFinal:false,replyComplete:true,turns:0,connects:0};
    entries.set(scope.callId,entry);entry.expires=setTimeout(()=>stop(entry,'realtime-not-connected'),15_000);entry.expires.unref();
    return{sessionId:entry.id,mode:entry.mode,sceneCalibration:false,input:{sampleRate:16000,channels:1,encoding:'pcm_s16le'},output:{sampleRate:24000,channels:1,encoding:'pcm_s16le'}};
  }
  function get(callId:string,id:string,deviceHash:string){const entry=entries.get(callId);if(!entry||entry.id!==id||entry.deviceHash!==deviceHash)throw stopped();assertEntry(entry);return entry;}
  function events(entry:Entry,response:Response){
    assertEntry(entry);if(entry.response)throw new ApiError(409,'实时语音只支持一个连接，请重新开始。','REALTIME_STREAM_EXISTS');
    entry.response=response;clearTimeout(entry.expires);
    response.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','Connection':'keep-alive'});response.flushHeaders();
    response.once('close',()=>stop(entry,'realtime-disconnected'));
    entry.keepalive=setInterval(()=>{try{assertEntry(entry);if(response.writableLength>128_000)throw unavailable();response.write(': keepalive\n\n');}catch(error){fail(entry,error);}},10_000);entry.keepalive.unref();
    void connect(entry).catch(error=>fail(entry,error));
  }
  async function pace(entry:Entry){
    if(entry.sending)return entry.sending;
    const generation=entry.generation,inputId=entry.inputId;
    const job=(async()=>{
      let nextFrameAt=performance.now();
      while(entry.queue.length){
        if(!entry.receiving||entry.mode==='manual'&&inputId!==entry.inputId)return;
        assertEntry(entry);if(generation!==entry.generation)throw stopped();
        const frame=entry.queue.shift()!;entry.queuedBytes-=frame.length;
        try{if(!entry.unmuted){await entry.provider!.mute(false);assertEntry(entry);if(generation!==entry.generation)throw stopped();entry.unmuted=true;}if(!entry.receiving||entry.mode==='manual'&&inputId!==entry.inputId)return;await entry.provider!.sendAudio(frame);}finally{frame.fill(0);}
        if(generation!==entry.generation||entry.closed)throw stopped();
        // Keep one absolute audio clock: do not add socket-send latency to every 20 ms frame.
        // After a long transport stall, restart the clock instead of bursting to catch up.
        nextFrameAt+=FRAME_MS;const current=performance.now();if(current-nextFrameAt>=FRAME_MS)nextFrameAt=current+FRAME_MS;
        await new Promise<void>(resolve=>{entry.wake=resolve;entry.timer=setTimeout(()=>{entry.timer=undefined;entry.wake=undefined;resolve();},Math.max(0,nextFrameAt-current));});
        if(generation!==entry.generation||entry.closed)throw stopped();
      }
    })();entry.sending=job;
    try{await job;}finally{if(entry.sending===job)entry.sending=undefined;}
  }
  function enqueue(entry:Entry,bytes:Buffer){
    const all=Buffer.concat([entry.partial,bytes]);entry.partial.fill(0);
    const complete=all.length-all.length%FRAME_BYTES;
    for(let offset=0;offset<complete;offset+=FRAME_BYTES){entry.queue.push(Buffer.from(all.subarray(offset,offset+FRAME_BYTES)));entry.queuedBytes+=FRAME_BYTES;}
    entry.partial=Buffer.from(all.subarray(complete));all.fill(0);
  }
  function audio(entry:Entry,input:{inputId?:string;sequence:number;audioBase64:string}){
    assertEntry(entry);if(entry.mode==='manual'&&!input.inputId)throw invalid();if(entry.mode==='manual'&&(input.inputId!==entry.inputId||!entry.receiving))return{ok:true,discarded:true,sequence:input.sequence};
    if(entry.mode==='continuous'&&input.inputId!==undefined)throw invalid();
    if(!entry.ready||entry.connecting||entry.committing)throw new ApiError(409,'请等宝妍准备好再说话。','REALTIME_NOT_READY');
    if(!Number.isSafeInteger(input.sequence)||input.sequence<0||typeof input.audioBase64!=='string'||input.audioBase64.length>21_336||!input.audioBase64||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64))throw invalid();
    const bytes=Buffer.from(input.audioBase64,'base64');
    try{
      if(!bytes.length||bytes.length>MAX_CHUNK_BYTES||bytes.length%2||bytes.toString('base64')!==input.audioBase64)throw invalid();
      const currentDigest=digest(bytes);
      if(input.sequence===entry.sequence-1&&currentDigest===entry.previousDigest)return{ok:true,sequence:input.sequence,duplicate:true};
      if(input.sequence!==entry.sequence)throw new ApiError(409,'语音上传顺序已变化，请重新开始。','REALTIME_SEQUENCE');
      if(entry.queuedBytes+entry.partial.length+bytes.length>MAX_QUEUE_BYTES||entry.receivedBytes+bytes.length>32_000*(Math.max(0,now()-entry.created)/1000+2))throw new ApiError(429,'语音上传太快，请重新开始。','REALTIME_AUDIO_RATE');
      if(entry.mode==='manual'&&entry.turnBytes+bytes.length>960_000)throw new ApiError(413,'一次请说三十秒以内，发送后再继续。','REALTIME_RECORDING_LIMIT');
      if(entry.mode==='manual')entry.turnBytes+=bytes.length;entry.sequence++;entry.previousDigest=currentDigest;entry.receivedBytes+=bytes.length;enqueue(entry,bytes);
      const generation=entry.generation;void pace(entry).catch(error=>{if(!entry.closed&&generation===entry.generation)fail(entry,error);});return{ok:true,sequence:input.sequence};
    }finally{bytes.fill(0);}
  }
  function heard(entry:Entry,responseId:string){
    assertEntry(entry);if(entry.mode!=='continuous')throw new ApiError(409,'这个确认只适用于自由说话体验。','REALTIME_MODE');
    const at=now();entry.heardAttempts=entry.heardAttempts.filter(time=>at-time<10_000);
    if(entry.heardAttempts.length>=20)throw new ApiError(429,'声音确认太频繁，请稍等。','REALTIME_ACK_RATE');entry.heardAttempts.push(at);
    if(entry.lastHeard===responseId)return{ok:true,duplicate:true};
    const pending=entry.pendingHeard;
    if(!pending||pending.id!==responseId||entry.responseId!==responseId||!entry.replyComplete)return{ok:true,discarded:true};
    entry.onTurn(pending.input,pending.reply,pending.id);entry.lastHeard=pending.id;entry.pendingHeard=undefined;return{ok:true};
  }
  function assertManual(entry:Entry){if(entry.mode==='continuous')throw new ApiError(409,'自由说话会自动接话，请直接说或结束聊天。','REALTIME_CONTINUOUS');}
  async function listen(entry:Entry){
    assertEntry(entry);assertManual(entry);if(!entry.ready||entry.connecting||entry.committing||entry.receiving||!entry.replyComplete)throw new ApiError(409,'请等这一句说完，或先打断再说。','REALTIME_NOT_READY');
    await entry.muting;await entry.sending;assertEntry(entry);
    if(entry.receiving||entry.committing||!entry.ready||!entry.replyComplete)throw new ApiError(409,'这次输入已经开始，请稍等。','REALTIME_NOT_READY');
    if(++entry.turns>100)throw new ApiError(429,'这次聊天已说了很多句，我们先休息一下。','REALTIME_TURN_LIMIT');
    options.consume();
    if(entry.nativeQuestion)entry.retiredQuestions.add(entry.nativeQuestion);if(entry.nativeResponse)entry.retiredResponses.add(entry.nativeResponse);
    entry.nativeQuestion=undefined;entry.nativeResponse=undefined;entry.inputId=randomUUID();entry.utteranceId=entry.inputId;entry.responseId=randomUUID();entry.input='';entry.reply='';entry.inputFinal=false;entry.replyFinal=false;entry.replyComplete=false;entry.turnBytes=0;entry.sequence=0;entry.previousDigest=undefined;entry.receiving=true;
    return{inputId:entry.inputId};
  }
  async function commit(entry:Entry,inputId:string){
    assertEntry(entry);assertManual(entry);if(inputId!==entry.inputId||!entry.receiving)return{ok:true,discarded:true};
    if(!entry.ready||entry.connecting||entry.committing)throw new ApiError(409,'这句话正在发送，请稍等。','REALTIME_NOT_READY');
    if(!entry.turnBytes)throw new ApiError(400,'这次还没有收到声音，请点一下说话。','REALTIME_AUDIO_REQUIRED');
    const generation=entry.generation;entry.committing=true;
    try{
      if(entry.partial.length){const frame=Buffer.alloc(FRAME_BYTES);entry.partial.copy(frame);entry.partial.fill(0);entry.partial=Buffer.alloc(0);entry.queue.push(frame);entry.queuedBytes+=FRAME_BYTES;}
      await pace(entry);assertEntry(entry);if(generation!==entry.generation)throw stopped();
      if(inputId!==entry.inputId||!entry.receiving)return{ok:true,discarded:true};
      // Mark before sending EndASR so native completed events cannot trigger a second commit.
      finishInput(entry,'manual');await entry.provider!.commit();await entry.muting;assertEntry(entry);if(generation!==entry.generation)throw stopped();return{ok:true};
    }catch(error){if(generation===entry.generation)fail(entry,error);throw error;}finally{if(generation===entry.generation)entry.committing=false;}
  }
  async function interrupt(entry:Entry){
    assertEntry(entry);assertManual(entry);if(entry.connecting||!entry.ready)throw new ApiError(409,'宝妍正在重新准备，请稍等。','REALTIME_NOT_READY');
    entry.ready=false;entry.generation++;entry.inputId=undefined;entry.muting=undefined;const previousController=entry.controller;clearAudio(entry);entry.sending=undefined;entry.input='';entry.reply='';entry.inputFinal=false;entry.replyFinal=false;entry.replyComplete=true;entry.committing=false;entry.unmuted=false;entry.receiving=false;
    const supplier=entry.provider;entry.provider=undefined;entry.release?.();entry.release=undefined;
    deliver(entry,{type:'interrupted'});
    try{try{await supplier?.interrupt();}finally{previousController.abort();}assertEntry(entry);entry.controller=new AbortController();await connect(entry);return{ok:true};}catch(error){fail(entry,error);throw error;}
  }
  return{start,get,events,listen,audio,commit,interrupt,heard,has:(callId:string)=>entries.has(callId),stopCall:(callId:string,reason:string)=>{const entry=entries.get(callId);if(entry)stop(entry,reason,false);},close:()=>{for(const entry of entries.values())stop(entry,'server-shutdown',false);},count:()=>entries.size};
}
