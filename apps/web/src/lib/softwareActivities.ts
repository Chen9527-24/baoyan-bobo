import type { CallState, ConversationMode, StoryProgress, Turn } from './types';
export interface StoryAudioCache {blob:Blob;replyId:string;storyId:string;segment:number;offsetSeconds:number;memoryRevision:number;globalRevision:number;speakerRevision:number}
type StoryAudioIdentity=Omit<StoryAudioCache,'blob'|'offsetSeconds'>;
export function matchesStoryAudio(cache:StoryAudioIdentity|undefined,turn:Turn){
 return !!cache&&!!turn.story&&cache.replyId===turn.replyId&&cache.storyId===turn.story.id&&cache.segment===turn.story.segment&&cache.memoryRevision===turn.memoryRevision&&cache.globalRevision===turn.globalRevision&&cache.speakerRevision===turn.speakerRevision;
}
/** Keep one controlled audio download per valid paragraph, even while it is paused. */
export class StoryAudioSession {
 cache?:StoryAudioCache;
 private generation=0;
 private pending?:{identity:StoryAudioIdentity;controller:AbortController;promise:Promise<StoryAudioCache|undefined>};
 clear(){++this.generation;this.pending?.controller.abort();this.pending=undefined;this.cache=undefined;}
 load(turn:Turn,produce:(signal:AbortSignal)=>Promise<Blob>):Promise<StoryAudioCache|undefined>{
  if(!turn.story)return Promise.reject(new Error('没有正在讲的故事。'));
  if(matchesStoryAudio(this.cache,turn))return Promise.resolve(this.cache);
  if(matchesStoryAudio(this.pending?.identity,turn))return this.pending!.promise;
  this.clear();const generation=this.generation;const controller=new AbortController();
  const identity:StoryAudioIdentity={replyId:turn.replyId,storyId:turn.story.id,segment:turn.story.segment,memoryRevision:turn.memoryRevision,globalRevision:turn.globalRevision,speakerRevision:turn.speakerRevision};
  const promise=Promise.resolve().then(()=>{if(controller.signal.aborted)return undefined;return produce(controller.signal);}).then(blob=>{
   if(!blob||controller.signal.aborted||generation!==this.generation)return undefined;
   if(blob.size>4_320_000)throw new Error('这段故事声音太长，请选择更短的故事。');
   const cached={...identity,blob,offsetSeconds:0};this.cache=cached;return cached;
  }).finally(()=>{if(this.pending?.promise===promise)this.pending=undefined;});
  this.pending={identity,controller,promise};return promise;
 }
}

/** A paused, completed, expired or cancelled story never advances itself. */
export function shouldAdvanceStory(story:StoryProgress|undefined,now:number,valid:boolean,hasPlayback:boolean) {
  return valid&&hasPlayback&&story?.status==='playing'&&story.segment<story.total&&!(story.choices?.length)&&Number.isFinite(Date.parse(story.endsAt))&&Date.parse(story.endsAt)>now;
}
export function storyPlaybackAction(story:StoryProgress|undefined,now:number,valid:boolean,hasPlayback:boolean):'next'|'complete'|undefined{
 if(!valid||!hasPlayback||story?.status!=='playing'||story.choices?.length||!Number.isFinite(Date.parse(story.endsAt))||Date.parse(story.endsAt)<=now)return undefined;
 return story.segment===story.total?'complete':story.segment<story.total?'next':undefined;
}
/** A finished story question leaves normal chat usable without starting the microphone. */
export function stateAfterReply(story:StoryProgress|undefined,speakerNeedsRejoin:boolean):CallState {
 return speakerNeedsRejoin||(story&&story.status!=='completed')?'paused':'listening';
}
/** Completion speech shares both original deadlines; it cannot buy more listening time. */
export function storyCompletionDeadline(story:StoryProgress|undefined,now:number,callEndsAt:number,valid:boolean):number|undefined {
 if(!Number.isFinite(now)||!Number.isFinite(callEndsAt)||callEndsAt<=now||storyPlaybackAction(story,now,valid,true)!=='complete')return undefined;
 return Math.min(Date.parse(story!.endsAt),callEndsAt);
}
/** Keep the completion request and its speech inside the same original time window. */
export async function deliverStoryCompletion(options:{
 deadline:number;deliver:(deadline:number)=>Promise<void>;isCurrent:()=>boolean;expire:()=>void;
 now?:()=>number;setTimer?:(callback:()=>void,delay:number)=>unknown;clearTimer?:(timer:unknown)=>void;
}):Promise<void> {
 const now=options.now??Date.now;
 if(!Number.isFinite(options.deadline)||options.deadline<=now())return;
 let expired=false,settled=false;
 const expire=()=>{if(!settled&&!expired&&options.isCurrent()){expired=true;options.expire();}};
 // deliver synchronously establishes the new turn before its first async wait.
 const delivery=options.deliver(options.deadline);
 const timer=(options.setTimer??((callback,delay)=>setTimeout(callback,delay)))(expire,Math.max(0,options.deadline-now()));
 try{await delivery;}
 finally{
  (options.clearTimer??(value=>clearTimeout(value as ReturnType<typeof setTimeout>)))(timer);
  if(now()>=options.deadline)expire();
  settled=true;
 }
}
export function modeLabel(mode:ConversationMode) {
  if(mode.mode==='auto')return '自动判断';
  if(mode.mode!=='dialect')return '陪伴聊天';
  return `${mode.dialect==='hakka'?'客家话':'潮汕话'} · ${mode.behavior==='translate'?'只翻译':'听懂后聊天'}`;
}
export function validDeviceLink(code:string,pin:string){return /^[A-Za-z0-9-]{6,64}$/.test(code.trim())&&/^\d{6}$/.test(pin);}
