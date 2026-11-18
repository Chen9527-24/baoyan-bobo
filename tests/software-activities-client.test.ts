import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { shouldAdvanceStory,storyPlaybackAction,storyCompletionDeadline,deliverStoryCompletion,stateAfterReply,validDeviceLink } from '../apps/web/src/lib/softwareActivities';
import { FamilyPanel } from '../apps/web/src/components/FamilyPanel';
import { Home } from '../apps/web/src/components/Home';
import type { CallController } from '../apps/web/src/hooks/useCall';
import type { Bootstrap,StoryProgress,Turn,CallState } from '../apps/web/src/lib/types';

const now=10000;
const story:StoryProgress={id:'story',title:'小故事',segment:1,total:3,status:'playing',endsAt:new Date(now+5000).toISOString()};
test('a valid audible story may advance only while its deadline is still ahead',()=>{
 assert.equal(shouldAdvanceStory(story,now,true,true),true);
 assert.equal(shouldAdvanceStory(story,now+5000,true,true),false);
 assert.equal(shouldAdvanceStory({...story,endsAt:'invalid'},now,true,true),false);
});
test('cancelled or text-only playback cannot start another paid story speech request',()=>{
 assert.equal(shouldAdvanceStory(story,now,false,true),false);
 assert.equal(shouldAdvanceStory(story,now,true,false),false);
});
test('paused, finished and last-segment stories cannot loop automatically',()=>{
 assert.equal(shouldAdvanceStory({...story,status:'paused'},now,true,true),false);
 assert.equal(shouldAdvanceStory({...story,status:'completed'},now,true,true),false);
 assert.equal(shouldAdvanceStory({...story,segment:3},now,true,true),false);
 assert.equal(shouldAdvanceStory(undefined,now,true,true),false);
});
test('an interactive story waits for an explicit choice rather than repeating the prompt',()=>{
 assert.equal(shouldAdvanceStory({...story,choices:[{id:'help',label:'先找家人'}]},now,true,true),false);
});
test('the last audible segment alone may request the once-only completion question',()=>{
 assert.equal(storyPlaybackAction({...story,segment:3},now,true,true),'complete');
 assert.equal(storyPlaybackAction({...story,segment:3},now,true,false),undefined);
 assert.equal(storyPlaybackAction({...story,segment:3},now,false,true),undefined);
 assert.equal(storyPlaybackAction({...story,segment:3,choices:[{id:'choice',label:'先问家人'}]},now,true,true),undefined);
 assert.equal(storyPlaybackAction({...story,segment:3},now+5000,true,true),undefined);
 assert.equal(storyPlaybackAction({...story,segment:2},now,true,true),'next');
});
test('joining another device requires both a bounded one-use code and a complete parent PIN',()=>{
 assert.equal(validDeviceLink('ABCD1234','123456'),true);
 assert.equal(validDeviceLink('ABCD1234','12345'),false);
 assert.equal(validDeviceLink('','123456'),false);
 assert.equal(validDeviceLink('x'.repeat(65),'123456'),false);
});
test('when voiceprint is unavailable the family screen cannot claim simulated enrollment as a real enrollment',()=>{
 const data:Bootstrap={configured:true,mode:'live',capabilities:{chat:true,asr:true,tts:true,voiceprint:false},child:{id:'fake',nickname:'虚构用户',ageGroup:'6-8',outfit:'mint',showCaptions:true,memoryEnabled:false,voiceEnabled:false,sessionMinutes:10,dailyMinutes:20},parentAuthorized:true,memoryCount:0,memberCount:0,globalMemories:[],remainingDailySeconds:1200};
 // The Node test loader uses classic JSX; the browser build uses Vite's automatic runtime.
 const runtime=globalThis as unknown as {React?:typeof React};const before=runtime.React;let markup='';
 try{runtime.React=React;markup=renderToStaticMarkup(React.createElement(FamilyPanel,{data,onChild:()=>{},onBusyChange:()=>{}}));}finally{if(before)runtime.React=before;else delete runtime.React;}
 assert.match(markup,/声音识人暂未启用/);
 assert.match(markup,/暂时不会采集声音或进行真实识人/);
 assert.doesNotMatch(markup,/确认模拟登记|模拟声音登记|role="switch"/);
});
function renderHome(needsRejoin:boolean,active:boolean,options:{speaker?:Turn['speaker'];voiceprint?:boolean;asr?:boolean;state?:CallState;memoryPending?:boolean;cancelling?:boolean}={}){
 const data:Bootstrap={configured:true,mode:'live',capabilities:{chat:true,asr:options.asr??true,tts:true,voiceprint:options.voiceprint??true},child:{id:'fake',nickname:'虚构用户',ageGroup:'6-8',outfit:'mint',showCaptions:true,memoryEnabled:false,voiceEnabled:true,sessionMinutes:10,dailyMinutes:20},parentAuthorized:false,memoryCount:0,memberCount:0,globalMemories:[],remainingDailySeconds:1200};
 const noop=()=>{};const call={state:options.state??(active?'paused':'idle'),active,call:active?{id:'test'}:null,remaining:300,voiceMode:'hold',syncReady:true,conversationMode:{mode:'chat'},speaker:options.speaker??(needsRejoin?{status:'unknown'}:undefined),speakerNeedsRejoin:needsRejoin,memoryPending:options.memoryPending,cancelling:options.cancelling,memoryOperations:{operations:[],unresolved:false},audio:{},setVoiceMode:noop,setVoiceHolding:noop,setAudioPreparing:noop,setVoiceReady:noop,setError:noop,setState:noop} as unknown as CallController;
 const runtime=globalThis as unknown as {React?:typeof React};const before=runtime.React;
 try{runtime.React=React;return renderToStaticMarkup(React.createElement(Home,{data,call,onPreference:async()=>{}}));}finally{if(before)runtime.React=before;else delete runtime.React;}
}
test('actual unknown speaker has an explicit rejoin action while microphone and ordinary input remain paused',()=>{
 const markup=renderHome(true,true);
 assert.match(markup,/已登记的本人重新加入/);
 assert.match(markup,/hold-to-talk-button[^>]*disabled=""/);
 assert.doesNotMatch(markup,/id="chat-message"/); // Voice view does not render ordinary text input.
 const textMarkup=renderHome(true,true,{asr:false});
 assert.match(textMarkup,/id="chat-message"[^>]*disabled=""/);
 assert.doesNotMatch(textMarkup,/>继续聊天<|>重试识人（模拟）</);
 assert.doesNotMatch(markup,/>继续聊天<|>重试识人（模拟）</);
});
test('voiceprint participation is an unchecked declaration for each new call',()=>{
 const markup=renderHome(false,false);
 assert.match(markup,/本次说话的人已登记，并同意识人/);
 assert.match(markup,/<input type="checkbox"\/>/);
 assert.doesNotMatch(markup,/<input type="checkbox"[^>]*checked/);
});
test('an actual matched identity can be corrected even while its mistaken reply is speaking',()=>{
 const markup=renderHome(false,true,{state:'speaking',speaker:{status:'known',name:'虚构爸爸'}});
 assert.match(markup,/这次听到的是虚构爸爸/);
 assert.match(markup,/<button class="text-button">认错人了<\/button>/);
 assert.doesNotMatch(renderHome(false,true,{voiceprint:false,speaker:{status:'known',name:'虚构爸爸'}}),/认错人了/);
 assert.doesNotMatch(renderHome(false,true,{speaker:{status:'demo',name:'虚构爸爸'}}),/认错人了/);
});
test('a pending cancellation or memory write cannot submit another speaker correction',()=>{
 for(const options of [{cancelling:true},{memoryPending:true}]){
  const markup=renderHome(false,true,{...options,speaker:{status:'known',name:'虚构爸爸'}});
  assert.match(markup,/<button class="text-button" disabled="">认错人了<\/button>/);
 }
});


test('completion speech uses the earlier call/story deadline and cannot start on pause, cancellation, expiry or a non-final segment', () => {
 const last={...story,segment:3};
 assert.equal(storyCompletionDeadline(last,now,now+2000,true),now+2000);
 assert.equal(storyCompletionDeadline(last,now,now+20000,true),now+5000);
 for(const candidate of [story,{...last,status:'paused' as const},{...last,status:'completed' as const},{...last,endsAt:'invalid'}])assert.equal(storyCompletionDeadline(candidate,now,now+20000,true),undefined);
 assert.equal(storyCompletionDeadline(last,now,now+20000,false),undefined);
 for(const deadline of [now,now-1,NaN,Infinity])assert.equal(storyCompletionDeadline(last,now,deadline,true),undefined);
});

function completionHarness() {
 let time=1000,current=true,expired=0,cleared=0,requests=0;
 let fire!:()=>void,finish!:()=>void,reject!:(error:Error)=>void;
 const pending=new Promise<void>((yes,no)=>{finish=yes;reject=no;});
 return {finish,reject,cancel:()=>{current=false;},setTime:(value:number)=>{time=value;},fire:()=>fire(),
  get expired(){return expired;},get cleared(){return cleared;},get requests(){return requests;},
  run:()=>deliverStoryCompletion({deadline:2000,now:()=>time,isCurrent:()=>current,
   deliver:async deadline=>{requests++;assert.equal(deadline,2000);await pending;},
   expire:()=>{expired++;},setTimer:(callback,delay)=>{fire=callback;assert.equal(delay,1000);return 'timer';},
   clearTimer:timer=>{assert.equal(timer,'timer');cleared++;}})};
}
test('completion deadline covers the pending request and audio, expires exactly once and clears its timer', async()=>{
 const h=completionHarness(),running=h.run();
 assert.equal(h.requests,1); assert.equal(h.expired,0);
 h.setTime(2000);h.fire();h.fire();assert.equal(h.expired,1);
 h.finish();await running;assert.equal(h.expired,1);assert.equal(h.cleared,1);
});
test('a late request cannot bypass a delayed native timeout callback',async()=>{
 const h=completionHarness(),running=h.run();
 h.setTime(2001);h.finish();await running;
 assert.equal(h.expired,1);assert.equal(h.cleared,1);
 h.fire();assert.equal(h.expired,1);
});
test('new input, hangup or invalid permission prevents an old completion timer from affecting the new turn',async()=>{
 const h=completionHarness(),running=h.run();
 h.cancel();h.setTime(2001);h.fire();h.finish();await running;
 assert.equal(h.expired,0);assert.equal(h.cleared,1);
});
test('normal completion or failure clears the completion timer and never schedules another question',async()=>{
 const success=completionHarness(),running=success.run();success.finish();await running;
 assert.equal(success.expired,0);assert.equal(success.cleared,1);assert.equal(success.requests,1);
 success.setTime(2001);success.fire();assert.equal(success.expired,0);
 const failure=completionHarness(),failed=failure.run();failure.reject(new Error('synthetic request failure'));
 await assert.rejects(failed,/synthetic request failure/);
 assert.equal(failure.expired,0);assert.equal(failure.cleared,1);assert.equal(failure.requests,1);
});
test('an already-expired completion does not create a request, timer, reply or speech',async()=>{
 let effects=0;
 for(const deadline of [1000,NaN,Infinity])await deliverStoryCompletion({deadline,now:()=>1000,isCurrent:()=>true,deliver:async()=>{effects++;},expire:()=>{effects++;},setTimer:()=>{effects++;return 0;},clearTimer:()=>{effects++;}});
 assert.equal(effects,0);
});


test('a completed spoken invitation returns to usable chat while active stories and unknown speakers stay paused',()=>{
 assert.equal(stateAfterReply({...story,status:'completed'},false),'listening');
 assert.equal(stateAfterReply(undefined,false),'listening');
 assert.equal(stateAfterReply(story,false),'paused');
 assert.equal(stateAfterReply({...story,status:'paused'},false),'paused');
 assert.equal(stateAfterReply({...story,status:'completed'},true),'paused');
});
