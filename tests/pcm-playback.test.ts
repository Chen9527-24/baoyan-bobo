import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioController } from '../apps/web/src/audio.js';
import { ApiError } from '../apps/web/src/lib/api.js';
import { permitsTextFallback, presentReplySegmentsWithPlayback } from '../apps/web/src/lib/replyPlayback.js';
import { createReplySpeechPrefetch } from '../apps/web/src/lib/replySpeechPrefetch.js';
import type { ReplySegment } from '../apps/web/src/lib/types.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function harness(){
  let monitor:()=>void=()=>{},time=0,closed=0,resumes=0;
  const events = new EventTarget();
  const sources:{buffer?:AudioBuffer;onended:(()=>void)|null;at:number;stops:number;start:(at:number)=>void;stop:()=>void;connect:()=>void;disconnect:()=>void}[]=[];
  const context={state:'running',get currentTime(){return time;},destination:{},resume:async()=>{resumes++;},close:async()=>{closed++;},
    addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),
    createBuffer:(_channels:number,length:number,rate:number)=>{const samples=new Float32Array(length);return {duration:length/rate,getChannelData:()=>samples} as unknown as AudioBuffer;},
    createBufferSource:()=>{const source={buffer:undefined as AudioBuffer|undefined,onended:null as (()=>void)|null,at:0,stops:0,start(at:number){this.at=at;},stop(){this.stops++;},connect(){},disconnect(){}};sources.push(source);return source as unknown as AudioBufferSourceNode;}} as unknown as AudioContext;
  const controller=new AudioController({createAudioContext:()=>context,now:()=>time*1000,setInterval:((callback:()=>void)=>{monitor=callback;return 1;}) as typeof setInterval,clearInterval:()=>{monitor=()=>{};}});
  return {controller,sources,get closed(){return closed;},get resumes(){return resumes;},advance(value:number){time=value;monitor();},end(){for(const source of sources)source.onended?.();monitor();},
    state(value:string,notify=true){Object.assign(context,{state:value});if(notify)events.dispatchEvent(new Event('statechange'));}};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('PCM schedules the first chunk before stream completion and reveals only when running audio clock reaches its start',async()=>{
  const h=harness(),release=deferred<void>();let started=0,finished=false;
  const playback=h.controller.playPcmStream(async function*(){yield new Uint8Array([0,128,0,0,255,127]);await release.promise;yield new Uint8Array([0,0]);},{onStart(){started++;}}).then(result=>{finished=true;return result;});
  await tick();assert.equal(h.sources.length,1);assert.equal(started,0);assert.equal(finished,false);
  assert.deepEqual(Array.from(h.sources[0]!.buffer!.getChannelData(0)),[-1,0,32767/32768]);
  h.advance(.1);assert.equal(started,0);h.advance(.13);assert.equal(started,1);
  release.resolve();await tick();assert.equal(h.sources.length,2);h.end();assert.equal(await playback,'ended');assert.equal(h.closed,1);assert.equal(started,1);
});
test('cancel stops scheduled audio, aborts the transport, and suppresses delayed chunks/onStart',async()=>{
  const h=harness(),release=deferred<void>();let signal:AbortSignal|undefined,started=0;
  const playback=h.controller.playPcmStream(async function*(input){signal=input;yield new Uint8Array([0,0]);await release.promise;yield new Uint8Array([0,0]);},{onStart(){started++;}});
  await tick();h.controller.cancel();assert.equal(await playback,'cancelled');assert.equal(signal?.aborted,true);assert.equal(h.sources[0]!.stops,1);
  release.resolve();await tick();h.advance(1);assert.equal(h.sources.length,1);assert.equal(started,0);
});
test('mid-stream failure stops already scheduled audio and preserves context error for stale-result gate',async()=>{
  const h=harness();const error=new ApiError('内容已失效',409,'CONTEXT_CHANGED');
  await assert.rejects(h.controller.playPcmStream(async function*(){yield new Uint8Array([0,0]);throw error;}),value=>{assert.equal(value,error);assert.equal(permitsTextFallback(value),false);return true;});
  assert.equal(h.sources[0]!.stops,1);assert.equal(h.closed,1);
});
test('odd byte boundaries are joined; odd final byte rejects incomplete audio',async()=>{
  const h=harness();const playback=h.controller.playPcmStream(async function*(){yield new Uint8Array([0]);yield new Uint8Array([128,0,0]);});
  await tick();assert.deepEqual(Array.from(h.sources[0]!.buffer!.getChannelData(0)),[-1,0]);h.advance(1);h.end();assert.equal(await playback,'ended');
  const bad=harness();await assert.rejects(bad.controller.playPcmStream(async function*(){yield new Uint8Array([0]);}),/不完整/);
});
test('explicit gesture preparation reuses the resumed context and dispose closes it',async()=>{
  const h=harness();h.controller.preparePlayback();await tick();assert.equal(h.resumes,1);
  const playback=h.controller.playPcmStream(async function*(){yield new Uint8Array([0,0]);});await tick();h.advance(1);h.end();await playback;
  assert.equal(h.closed,0);h.controller.dispose();assert.equal(h.closed,1);
});

for(const [target,scheduled] of [[100,.12],[280,.28],[500,.5],[-200,.12]] as const){
  test(`PCM earliest start ${target}ms shares the existing warmup instead of adding another delay`,async()=>{
    const h=harness();let starts=0;const activities:boolean[]=[];
    const playback=h.controller.playPcmStream(async function*(){yield new Uint8Array([0,0]);},{notBeforeMs:target,onStart(){starts++;},onActivityChange:value=>activities.push(value)});
    await tick();assert.equal(h.sources.length,1);assert.ok(Math.abs(h.sources[0]!.at-scheduled)<1e-9);
    assert.equal(starts,0);assert.deepEqual(activities,[]);
    h.advance(scheduled-.001);assert.equal(starts,0);assert.equal(activities.includes(true),false);
    h.advance(scheduled);assert.equal(starts,1);assert.deepEqual(activities,[true]);
    h.end();assert.equal(await playback,'ended');assert.deepEqual(activities,[true,false]);
  });
}

test('slow PCM delivery consumes the intended pause and keeps only the normal audio warmup',async()=>{
  const h=harness(),release=deferred<void>();let starts=0;
  const playback=h.controller.playPcmStream(async function*(){await release.promise;yield new Uint8Array([0,0]);},{notBeforeMs:220,onStart(){starts++;}});
  await tick();h.advance(.35);assert.equal(h.sources.length,0);assert.equal(starts,0);
  release.resolve();await tick();assert.ok(Math.abs(h.sources[0]!.at-.47)<1e-9,'elapsed network waiting is not followed by another 220ms pause');
  h.advance(.47);assert.equal(starts,1);h.end();assert.equal(await playback,'ended');
});

test('the earliest-start target does not affect following PCM chunks or reannounce their starts',async()=>{
  const h=harness(),release=deferred<void>();let starts=0;
  const playback=h.controller.playPcmStream(async function*(){yield new Uint8Array([0,0]);await release.promise;yield new Uint8Array([0,0]);},{notBeforeMs:280,onStart(){starts++;}});
  await tick();h.advance(.3);assert.equal(starts,1);release.resolve();await tick();
  assert.ok(Math.abs(h.sources[0]!.at-.28)<1e-9);assert.ok(Math.abs(h.sources[1]!.at-.315)<1e-9,'later chunks keep the existing 15ms lead');
  h.advance(.32);assert.equal(starts,1);h.end();assert.equal(await playback,'ended');
});

test('cancelling scheduled earliest-start PCM removes future sound and does not reveal or animate',async()=>{
  const h=harness();let starts=0;const activities:boolean[]=[];
  const playback=h.controller.playPcmStream(async function*(){yield new Uint8Array([0,0]);},{notBeforeMs:280,onStart(){starts++;},onActivityChange:value=>activities.push(value)});
  await tick();h.advance(.1);h.controller.cancel();assert.equal(await playback,'cancelled');
  h.advance(.5);h.end();assert.equal(h.sources[0]!.stops,1);assert.equal(starts,0);assert.equal(activities.includes(true),false);assert.equal(h.closed,1);
});

test('invalid or unbounded PCM earliest-start targets fail before creating output or requesting bytes',async()=>{
  for(const notBeforeMs of [NaN,Infinity,-Infinity,501]){
    const h=harness();let requests=0;
    await assert.rejects(h.controller.playPcmStream(async function*(){requests++;yield new Uint8Array([0,0]);},{notBeforeMs}),{code:'invalid_playback_timing'});
    assert.equal(requests,0);assert.equal(h.sources.length,0);assert.equal(h.resumes,0);h.controller.dispose();
  }
});

for (const state of ['interrupted', 'suspended', 'closed']) {
  for (const notify of [true, false]) {
    test(`PCM ${state} after running stops queued speech through ${notify ? 'statechange' : 'the activity monitor'} without later resumption`, async () => {
      const h = harness(), release = deferred<void>(); let starts = 0, signal: AbortSignal | undefined;
      const activities: boolean[] = [], failures: unknown[] = [];
      const playback = h.controller.playPcmStream(async function* (value) {
        signal = value; yield new Uint8Array(48_000); await release.promise; yield new Uint8Array(48_000);
      }, { onStart() { starts++; }, onActivityChange: value => activities.push(value) }).catch(error => { failures.push(error); });
      try {
        await tick(); h.advance(.13); assert.equal(starts, 1); assert.equal(activities.at(-1), true);
        h.state(state, notify); if (!notify) h.advance(.14); await tick();
        assert.equal(failures.length, 1, 'audio must settle promptly instead of waiting for the 120-second duration limit');
        assert.equal((failures[0] as { code: string }).code, 'playback_interrupted');
        assert.equal(permitsTextFallback(failures[0]), true);
        assert.equal(signal?.aborted, true); assert.equal(h.sources[0]!.stops, 1); assert.equal(activities.at(-1), false);
        h.state('running'); release.resolve(); await tick(); h.advance(2);
        assert.equal(h.sources.length, 1, 'returning from the interruption cannot schedule old buffered chunks');
        assert.equal(starts, 1); assert.equal(failures.length, 1);
      } finally { h.controller.cancel(); release.resolve(); await playback; h.controller.dispose(); }
    });
  }
}

test('PCM interruption before the scheduled first sound does not announce speech or reveal a late start', async () => {
  const h = harness(); let starts = 0, failure: unknown;
  const playback = h.controller.playPcmStream(async function* () { yield new Uint8Array(48_000); }, {
    notBeforeMs: 280, onStart() { starts++; },
  }).catch(error => { failure = error; });
  try {
    await tick(); h.state('interrupted'); await tick();
    assert.equal((failure as { code?: string } | undefined)?.code, 'playback_interrupted');
    assert.equal(starts, 0); assert.equal(h.sources[0]!.stops, 1);
    h.state('running'); h.advance(1); assert.equal(starts, 0);
  } finally { h.controller.cancel(); await playback; h.controller.dispose(); }
});

test('system interruption stops a segmented reply, clears its prefetched future audio and exposes the remaining text once', async () => {
  const h = harness(), release = deferred<void>(), requests: number[] = [], signals: AbortSignal[] = [];
  const segments: ReplySegment[] = [{ text: '你很在意这件事呀。', expression: 'gentle' }, { text: '我在听。', expression: 'gentle' }, { text: '慢慢说就好。', expression: 'natural' }];
  const reply = segments.map(segment => segment.text).join('\n\n');
  const revealed: string[] = [], failures: unknown[] = []; let ready = false;
  const prefetch = createReplySpeechPrefetch({ segmentCount: segments.length, segments, streaming: true, audio: h.controller, isCurrent: () => true,
    fetchBlob: async () => { throw new Error('unexpected Blob request'); },
    fetchPcm: (index, signal) => (async function* () {
      requests.push(index); signals.push(signal); yield new Uint8Array(48_000);
      if (index > 0) { await release.promise; yield new Uint8Array(48_000); }
    })(),
  });
  const pending = presentReplySegmentsWithPlayback({ reply, segments, isCurrent: () => true,
    playback: (_segment, index, onStart) => prefetch.play(index, onStart),
    preparing() {}, reveal: text => revealed.push(text), speaking() {}, ready() { ready = true; }, failed: error => failures.push(error),
  }).finally(() => prefetch.dispose());
  try {
    await tick(); h.advance(.13); await tick(); assert.deepEqual(requests, [0, 1]);
    h.state('interrupted'); await pending;
    assert.deepEqual(revealed, [segments[0]!.text, reply]); assert.equal(ready, false);
    assert.equal((failures[0] as { code: string }).code, 'playback_interrupted');
    assert.equal(signals.every(signal => signal.aborted), true);
    h.state('running'); release.resolve(); await tick(); h.advance(2);
    assert.deepEqual(requests, [0, 1]); assert.equal(h.sources.length, 1); assert.equal(failures.length, 1);
  } finally { h.controller.cancel(); release.resolve(); await pending; h.controller.dispose(); }
});

test('explicit cancellation before a queued context state change remains silent cancellation', async () => {
  const h = harness(), release = deferred<void>(); let failures = 0;
  const playback = h.controller.playPcmStream(async function* () {
    yield new Uint8Array(48_000); await release.promise;
  }, { onError() { failures++; } });
  await tick(); h.advance(.13); h.controller.cancel();
  h.state('interrupted'); h.state('closed'); h.state('running'); h.advance(2);
  assert.equal(await playback, 'cancelled'); assert.equal(failures, 0);
  release.resolve(); await tick(); h.controller.dispose();
});
