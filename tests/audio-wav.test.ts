import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertRecordingToWav, encodePcm16Wav, MAX_RECORDING_BYTES, MAX_WAV_BYTES,
  type WavConversionDependencies,
} from '../apps/web/src/audioWav.ts';

function deferred<T>() {
  let resolve!: (value:T)=>void;
  let reject!: (reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const flush = async () => { for(let i=0;i<10;i++)await Promise.resolve(); };
function buffer(duration=1,channels=2,rate=48_000):AudioBuffer {
  const length=Math.round(duration*rate);
  return {duration,numberOfChannels:channels,sampleRate:rate,length,getChannelData:()=>new Float32Array(length).fill(.5)} as unknown as AudioBuffer;
}
function harness(options:{decoded?:AudioBuffer;decode?:Promise<AudioBuffer>;render?:Promise<AudioBuffer>}={}) {
  let created=0,closed=0,renders=0,stops=0,disconnects=0,cleared=0;
  let timeout:()=>void=()=>{};
  let frames=0,rate=0;
  const source={buffer:null as AudioBuffer|null,channelCount:2,channelCountMode:'max',channelInterpretation:'speakers',connect(destination:unknown){assert.equal(destination,offlineDestination);},start(){},stop(){stops++;},disconnect(){disconnects++;}};
  const offlineDestination={offline:true};
  const dependencies:Partial<WavConversionDependencies>={
    createDecoder:()=>{created++;return {state:'running',decodeAudioData:async(encoded:ArrayBuffer)=>{assert.ok(encoded.byteLength>0);return options.decode??options.decoded??buffer();},close:async()=>{closed++;}} as unknown as AudioContext;},
    createRenderer:(length,sampleRate)=>{frames=length;rate=sampleRate;return {destination:offlineDestination,createBufferSource:()=>source,startRendering:()=>{renders++;return options.render??Promise.resolve(buffer(length/sampleRate,1,sampleRate));}} as unknown as OfflineAudioContext;},
    setTimeout:((callback:()=>void,ms:number)=>{assert.equal(ms,12_000);timeout=callback;return 1;}) as unknown as typeof setTimeout,
    clearTimeout:(()=>{cleared++;}) as unknown as typeof clearTimeout,
  };
  return {dependencies,source,fireTimeout:()=>timeout(),get created(){return created;},get closed(){return closed;},get renders(){return renders;},get stops(){return stops;},get disconnects(){return disconnects;},get cleared(){return cleared;},get frames(){return frames;},get rate(){return rate;}};
}

async function wavInfo(blob:Blob){
  const bytes=await blob.arrayBuffer();const view=new DataView(bytes);const text=(start:number,length:number)=>String.fromCharCode(...new Uint8Array(bytes,start,length));
  return {view,text,bytes};
}

test('PCM16 WAV has an exact mono 16kHz header, clipping, little-endian samples and bounded size',async()=>{
  const blob=encodePcm16Wav(new Float32Array([-2,-1,-.5,0,.5,1,2,NaN,Infinity]));
  const {view,text,bytes}=await wavInfo(blob);
  assert.equal(blob.type,'audio/wav');assert.equal(text(0,4),'RIFF');assert.equal(text(8,4),'WAVE');assert.equal(text(12,4),'fmt ');assert.equal(text(36,4),'data');
  assert.equal(view.getUint16(20,true),1);assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),16_000);assert.equal(view.getUint32(28,true),32_000);assert.equal(view.getUint16(32,true),2);assert.equal(view.getUint16(34,true),16);
  assert.equal(view.getUint32(4,true),bytes.byteLength-8);assert.equal(view.getUint32(40,true),18);
  assert.deepEqual(Array.from({length:9},(_,i)=>view.getInt16(44+i*2,true)),[-32768,-32768,-16384,0,16384,32767,32767,0,0]);
  assert.throws(()=>encodePcm16Wav(new Float32Array()),{code:'wav_bounds'});
  assert.throws(()=>encodePcm16Wav(new Float32Array(480001)),{code:'wav_bounds'});
});

test('WebM and MP4 recordings follow the decoder and mono offline-renderer path without playback',async()=>{
  for(const type of ['audio/webm;codecs=opus','audio/mp4']){
    const h=harness();const blob=await convertRecordingToWav(new Blob(['recording'],{type}),{},h.dependencies);
    const {view}=await wavInfo(blob);
    assert.equal(h.frames,16_000);assert.equal(h.rate,16_000);assert.equal(h.renders,1);assert.equal(h.source.channelCount,1);assert.equal(h.source.channelCountMode,'explicit');
    assert.equal(blob.type,'audio/wav');assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),16_000);assert.equal(blob.size,32_044);
    assert.equal(h.closed,1);assert.equal(h.stops,1);assert.equal(h.disconnects,1);assert.equal(h.source.buffer,null);assert.equal(h.cleared,1);
  }
});

test('a short encoder tail is trimmed to thirty seconds; longer input is rejected',async()=>{
  const h=harness({decoded:buffer(30.2)});const wav=await convertRecordingToWav(new Blob(['encoded']),{},h.dependencies);
  assert.equal(h.frames,480_000);assert.equal(wav.size,MAX_WAV_BYTES);
  const tooLong=harness({decoded:buffer(30.251)});
  await assert.rejects(convertRecordingToWav(new Blob(['encoded']),{},tooLong.dependencies),{code:'decoded_bounds'});
  assert.equal(tooLong.renders,0);assert.equal(tooLong.closed,1);
});

test('a shorter approved turn is respected during conversion, and unsupported channel counts fail closed',async()=>{
  const h=harness({decoded:buffer(5.1)});const wav=await convertRecordingToWav(new Blob(['encoded']),{maxDurationMs:5000},h.dependencies);
  assert.equal(wav.size,160_044);
  const surround=harness({decoded:buffer(1,6)});
  await assert.rejects(convertRecordingToWav(new Blob(['encoded']),{},surround.dependencies),{code:'decoded_bounds'});
  assert.equal(surround.renders,0);
});

test('empty and oversized input are rejected before opening an AudioContext',async()=>{
  const h=harness();
  await assert.rejects(convertRecordingToWav(new Blob(),{},h.dependencies),{code:'empty_recording'});
  await assert.rejects(convertRecordingToWav(new Blob([new Uint8Array(MAX_RECORDING_BYTES+1)]),{},h.dependencies),{code:'recording_too_large'});
  assert.equal(h.created,0);
});

test('cancelling while bytes are pending never opens a decoder and discards late bytes',async()=>{
  const pending=deferred<ArrayBuffer>();const h=harness();const cancellation=new AbortController();
  const blob=new Blob(['encoded']);blob.arrayBuffer=()=>pending.promise;
  const result=convertRecordingToWav(blob,{signal:cancellation.signal},h.dependencies);
  cancellation.abort();await assert.rejects(result,{name:'AbortError'});
  pending.resolve(new ArrayBuffer(5));await flush();
  assert.equal(h.created,0);assert.equal(h.renders,0);assert.equal(h.cleared,1);
});

test('cancelling during decode closes the context immediately and never consumes the late decoded audio',async()=>{
  const pending=deferred<AudioBuffer>();const h=harness({decode:pending.promise});const cancellation=new AbortController();
  const result=convertRecordingToWav(new Blob(['encoded']),{signal:cancellation.signal},h.dependencies);
  await flush();assert.equal(h.created,1);cancellation.abort();assert.equal(h.closed,1);
  await assert.rejects(result,{name:'AbortError'});
  pending.resolve(buffer());await flush();
  assert.equal(h.renders,0);assert.equal(h.closed,1);assert.equal(h.cleared,1);
});

test('cancelling during offline rendering disconnects its source and ignores the late waveform',async()=>{
  const pending=deferred<AudioBuffer>();const h=harness({render:pending.promise});const cancellation=new AbortController();
  const result=convertRecordingToWav(new Blob(['encoded']),{signal:cancellation.signal},h.dependencies);
  await flush();assert.equal(h.renders,1);cancellation.abort();await assert.rejects(result,{name:'AbortError'});
  pending.resolve(buffer(1,1,16_000));await flush();
  assert.equal(h.stops,1);assert.equal(h.disconnects,1);assert.equal(h.source.buffer,null);assert.equal(h.closed,1);
});

test('conversion times out after twelve seconds and releases contexts without consuming a late decode',async()=>{
  const pending=deferred<AudioBuffer>();const h=harness({decode:pending.promise});
  const result=convertRecordingToWav(new Blob(['encoded']),{},h.dependencies);
  await flush();h.fireTimeout();await assert.rejects(result,{code:'conversion_timeout'});
  pending.resolve(buffer());await flush();assert.equal(h.closed,1);assert.equal(h.renders,0);assert.equal(h.cleared,1);
});

test('decode failures and unexpected renderer output produce a user-readable error with no wrong-format fallback',async()=>{
  const pending=deferred<AudioBuffer>();const h=harness({decode:pending.promise});
  const result=convertRecordingToWav(new Blob(['encoded']),{},h.dependencies);
  await flush();pending.reject(new Error('decoder internals'));
  await assert.rejects(result,error=>{assert.equal((error as {code:string}).code,'decode_failed');assert.match((error as Error).message,/文字聊天/);assert.doesNotMatch((error as Error).message,/internals/);return true;});
  assert.equal(h.closed,1);
  const wrong=harness({render:Promise.resolve(buffer(1,2,48_000))});
  await assert.rejects(convertRecordingToWav(new Blob(['encoded']),{},wrong.dependencies),{code:'render_format'});
  assert.equal(wrong.closed,1);assert.equal(wrong.disconnects,1);
});
