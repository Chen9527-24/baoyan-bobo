import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioController } from '../apps/web/src/audio';
import { matchesStoryAudio,StoryAudioSession,type StoryAudioCache } from '../apps/web/src/lib/softwareActivities';
import type { Turn } from '../apps/web/src/lib/types';

class StoryElement{
 currentTime=0;duration=12;readyState=0;src='';pauses=0;plays=0;seekAtPlay:number[]=[];
 onplaying:(()=>void)|null=null;onended:(()=>void)|null=null;onerror:(()=>void)|null=null;onloadedmetadata:(()=>void)|null=null;
 load(){if(this.src)queueMicrotask(()=>{this.readyState=1;this.onloadedmetadata?.();});}
 play(){this.plays++;this.seekAtPlay.push(this.currentTime);this.onplaying?.();return Promise.resolve();}
 pause(){this.pauses++;}
 removeAttribute(){this.src='';}
}
function harness(){const elements:StoryElement[]=[];const urls:Blob[]=[];const revoked:string[]=[];let micRequests=0;const audio=new AudioController({secureContext:true,createAudioElement:()=>{const value=new StoryElement();elements.push(value);return value as unknown as HTMLAudioElement;},createObjectURL:blob=>{urls.push(blob);return 'blob:story-'+urls.length;},revokeObjectURL:url=>{revoked.push(url);},getUserMedia:async()=>{micRequests++;throw new Error('story playback must not capture');}});return{audio,elements,urls,revoked,get micRequests(){return micRequests;}};}
const microtasks=async()=>{await Promise.resolve();await Promise.resolve();};

test('story pause reads the actual media clock and resumes identical bytes at that clock',async()=>{
 const h=harness(),bytes=new Blob(['identical MP3 bytes'],{type:'audio/mpeg'});let starts=0;
 const initial=h.audio.playStoryBlob(bytes,0,{onStart:()=>starts++});await microtasks();
 h.elements[0]!.currentTime=3.25;
 const offset=h.audio.pauseStoryPlayback();assert.equal(offset,3.25);assert.equal(await initial,'cancelled');
 assert.equal(h.elements[0]!.src,'');assert.deepEqual(h.revoked,['blob:story-1']);
 const resumed=h.audio.playStoryBlob(bytes,offset!,{onStart:()=>starts++});await microtasks();
 assert.deepEqual(h.elements[1]!.seekAtPlay,[3.25]);assert.equal(h.urls[0],h.urls[1]);assert.equal(starts,2);
 assert.equal(h.micRequests,0);h.elements[1]!.onended?.();assert.equal(await resumed,'ended');h.audio.dispose();
});
test('story seek waits for metadata and a cancelled metadata event cannot restart playback',async()=>{
 const h=harness();const playback=h.audio.playStoryBlob(new Blob(['mp3']),5);
 h.audio.cancel();await microtasks();assert.equal(await playback,'cancelled');assert.equal(h.elements[0]!.plays,0);assert.equal(h.audio.pauseStoryPlayback(),undefined);h.audio.dispose();
});
test('an impossible resume position fails and releases the object URL',async()=>{
 const h=harness();const playback=h.audio.playStoryBlob(new Blob(['mp3']),30);await assert.rejects(playback,{code:'invalid_audio'});assert.equal(h.elements[0]!.plays,0);assert.deepEqual(h.revoked,['blob:story-1']);h.audio.dispose();
});
test('cached story audio requires exact reply identity, segment and all three authorized stamps',()=>{
 const turn:Turn={reply:'测试故事',replyId:'reply-a',mode:'demo',memoryRevision:2,globalRevision:3,speakerRevision:4,story:{id:'story-a',title:'测试故事',segment:1,total:3,status:'playing',endsAt:new Date(Date.now()+10000).toISOString()}};
 const cache:StoryAudioCache={blob:new Blob(['mp3']),replyId:turn.replyId,storyId:'story-a',segment:1,offsetSeconds:3.25,memoryRevision:2,globalRevision:3,speakerRevision:4};
 assert.equal(matchesStoryAudio(cache,turn),true);
 for(const field of ['memoryRevision','globalRevision','speakerRevision'] as const)assert.equal(matchesStoryAudio(cache,{...turn,[field]:turn[field]+1}),false);
 assert.equal(matchesStoryAudio(cache,{...turn,replyId:'other-reply'}),false);
 assert.equal(matchesStoryAudio(cache,{...turn,story:{...turn.story!,segment:2}}),false);
 assert.equal(matchesStoryAudio(undefined,turn),false);
});
function storyTurn(replyId='reply-a'):Turn{return {reply:'测试故事',replyId,mode:'demo',memoryRevision:2,globalRevision:3,speakerRevision:4,story:{id:'story-a',title:'测试故事',segment:1,total:3,status:'playing',endsAt:new Date(Date.now()+10000).toISOString()}};}
test('rapid pause and resume reuse the same in-flight paragraph download instead of synthesizing twice',async()=>{
 const session=new StoryAudioSession();let requests=0;let resolve!:(blob:Blob)=>void;let signal!:AbortSignal;
 const producer=(value:AbortSignal)=>{requests++;signal=value;return new Promise<Blob>(yes=>{resolve=yes;});};
 const initial=session.load(storyTurn(),producer);await microtasks();
 const resumed=session.load({...storyTurn(),story:{...storyTurn().story!,status:'paused'}},producer);
 assert.equal(initial,resumed);assert.equal(requests,1);assert.equal(signal.aborted,false);
 const bytes=new Blob(['one download']);resolve(bytes);const first=await initial;assert.equal(await resumed,first);assert.equal(first?.blob,bytes);
 first!.offsetSeconds=3.25;const cached=await session.load(storyTurn(),producer);assert.equal(cached?.offsetSeconds,3.25);assert.equal(requests,1);
 session.clear();assert.equal(session.cache,undefined);
});
test('leaving a task aborts the in-flight request and rejects even a late successful cache population',async()=>{
 const session=new StoryAudioSession();let resolve!:(blob:Blob)=>void;let signal!:AbortSignal;
 const result=session.load(storyTurn(),value=>{signal=value;return new Promise<Blob>(yes=>{resolve=yes;});});await microtasks();session.clear();
 assert.equal(signal.aborted,true);resolve(new Blob(['late old audio']));assert.equal(await result,undefined);assert.equal(session.cache,undefined);
});
test('a changed identity or stamp aborts the old download and only caches its replacement',async()=>{
 const session=new StoryAudioSession();let firstResolve!:(blob:Blob)=>void;let oldSignal!:AbortSignal;
 const initial=session.load(storyTurn(),value=>{oldSignal=value;return new Promise<Blob>(yes=>{firstResolve=yes;});});await microtasks();
 const replacementBytes=new Blob(['valid replacement']);const replacement=session.load({...storyTurn('reply-b'),speakerRevision:5},async()=>replacementBytes);
 assert.equal(oldSignal.aborted,true);firstResolve(new Blob(['invalid old audio']));assert.equal(await initial,undefined);
 assert.equal((await replacement)?.blob,replacementBytes);assert.equal(session.cache?.replyId,'reply-b');assert.equal(session.cache?.speakerRevision,5);
});
