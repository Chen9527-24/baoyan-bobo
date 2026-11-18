import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirstAudioObserver } from '../apps/web/src/lib/clientLatency.ts';
import { presentReplyWithPlayback } from '../apps/web/src/lib/replyPlayback.ts';
import type { PlaybackResult } from '../apps/web/src/audio.ts';

const replyId='9c94b5c9-6041-4d37-b26d-2543f52f942f';
function fixture() {
  let current=true;
  let now=100;
  const observations:{replyId:string;milliseconds:number}[]=[];
  const isCurrent=()=>current;
  const observe=createFirstAudioObserver({startedAt:100,replyId,isCurrent,now:()=>now,report:async observation=>{observations.push(observation);}});
  const options={isCurrent,preparing:()=>{},reveal:()=>{},speaking:observe,ready:()=>{},failed:()=>{}};
  return {observations,options,observe,cancel:()=>{current=false;},clock:(value:number)=>{now=value;}};
}
function deferred<T>() {
  let resolve!:(value:T)=>void;
  let reject!:(error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test('measures from input submission through recognition/generation/download to actual playback, exactly once',async()=>{
  const f=fixture();const audio=deferred<PlaybackResult>();let onStart!:()=>void;
  const playback=presentReplyWithPlayback({...f.options,playback:start=>{onStart=start;return audio.promise;}});
  f.clock(2500);assert.deepEqual(f.observations,[]); // Downloading/processing is not first sound.
  f.clock(3200.6);onStart();onStart();
  assert.deepEqual(f.observations,[{replyId,milliseconds:3101}]);
  audio.resolve('ended');await playback;
  onStart();assert.equal(f.observations.length,1);
});

test('no audio and safe text fallback never report first sound, including a late native start callback',async()=>{
  const textOnly=fixture();textOnly.clock(2000);await presentReplyWithPlayback(textOnly.options);assert.deepEqual(textOnly.observations,[]);
  const failed=fixture();let late!:()=>void;failed.clock(3000);
  await presentReplyWithPlayback({...failed.options,playback:async start=>{late=start;throw new Error('Audio unavailable');}});
  late();assert.deepEqual(failed.observations,[]);
  const silent=fixture();await presentReplyWithPlayback({...silent.options,playback:async()=>'ended'});assert.deepEqual(silent.observations,[]);
});

test('cancelled or superseded replies never report a late playback callback',async()=>{
  const f=fixture();const audio=deferred<PlaybackResult>();let late!:()=>void;
  const playback=presentReplyWithPlayback({...f.options,playback:start=>{late=start;return audio.promise;}});
  f.clock(6000);f.cancel();late();audio.resolve('ended');await playback;
  assert.deepEqual(f.observations,[]);
});

test('zero to 90 seconds are accepted as integer milliseconds; invalid clock readings are omitted',()=>{
  for(const elapsed of [0,0.4,89_999.7,90_000]){
    const f=fixture();f.clock(100+elapsed);f.observe();assert.deepEqual(f.observations,[{replyId,milliseconds:Math.round(elapsed)}]);
  }
  for(const elapsed of [-1,90_000.1,Infinity,NaN]){
    const f=fixture();f.clock(100+elapsed);f.observe();assert.deepEqual(f.observations,[]);
  }
});

test('observation transport failures are silent and cannot repeat or fail successful playback',async()=>{
  for(const synchronous of [false,true]){
    let attempts=0;let ready=false;
    const observer=createFirstAudioObserver({startedAt:0,replyId,isCurrent:()=>true,now:()=>1000,report:()=>{attempts++;if(synchronous)throw new Error('offline');return Promise.reject(new Error('offline'));}});
    await presentReplyWithPlayback({isCurrent:()=>true,preparing:()=>{},reveal:()=>{},speaking:observer,ready:()=>{ready=true;},failed:()=>assert.fail('Observation errors must not fail playback'),playback:async start=>{start();start();return 'ended';}});
    assert.equal(ready,true);assert.equal(attempts,1);
  }
});
