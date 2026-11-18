import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bootstrap } from '../apps/web/src/lib/types.js';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream.js';
import { speechLanguages } from '../apps/web/src/lib/languageClarification.js';
import { PHONE_OBSERVATION_LANGUAGES, PHONE_OBSERVATION_LANGUAGE_LABELS } from '../apps/web/src/lib/phoneExperience.js';
register('data:text/javascript,'+encodeURIComponent(`export async function load(url,context,nextLoad){if(url.endsWith('.css'))return{format:'module',source:'export default {}',shortCircuit:true};return nextLoad(url,context);}`),import.meta.url);
const {AccountOnboarding}=await import('../apps/web/src/components/AccountOnboarding.js');
const {AccountPanel}=await import('../apps/web/src/components/AccountPanel.js');
const {Setup}=await import('../apps/web/src/components/Setup.js');
const {ParentUnlock}=await import('../apps/web/src/components/ParentUnlock.js');
const {registrationIdentityError}=await import('../apps/web/src/components/RegistrationFields.js');
const noop=()=>{};
const data:Bootstrap={configured:false,child:null,parentAuthorized:false,mode:'demo',capabilities:{chat:false,asr:false,tts:false,voiceprint:false},memoryCount:0,memberCount:0,globalMemories:[],remainingDailySeconds:0};
function render(element:React.ReactElement){const runtime=globalThis as unknown as{React?:typeof React};const previous=runtime.React;try{runtime.React=React;return renderToStaticMarkup(element);}finally{if(previous)runtime.React=previous;else delete runtime.React;}}

test('both registrations require phone, child name and confirmed six-digit account PIN',()=>{
 const pages=[render(React.createElement(AccountOnboarding,{data,onLogin:noop,onComplete:noop,onCreate:noop,onBusyChange:noop})),render(React.createElement(AccountPanel,{data,initialAction:'register',onSessionChange:noop,onBusyChange:noop}))];
 for(const page of pages){assert.match(page,/小朋友姓名<input required=/);assert.match(page,/联系手机号<input required="" type="tel"/);assert.match(page,/设置账号 PIN<input required="" type="password" inputMode="numeric" pattern="\[0-9\]\{6\}"/);assert.match(page,/再次输入 PIN/);assert.doesNotMatch(page,/联系手机号（选填）|发送验证码|必须包含/);}
});
test('registration identity validation accepts simple PIN and reserved international test number',()=>{
 assert.equal(registrationIdentityError('虚构小星','+1 202-555-0101','482619','482619'),'');
 for(const input of [['','+12025550101','482619','482619'],['虚构小星','','482619','482619'],['虚构小星','+12025550101','123','123'],['虚构小星','+12025550101','482619','221133']])assert.notEqual(registrationIdentityError(...input as [string,string,string,string]),'');
});
test('pending account offers a blank optional family code and direct independent-family continuation',()=>{
 const page=render(React.createElement(AccountOnboarding,{data:{...data,account:{bound:false,signedIn:true,pending:true,username:'fixture_v47',childName:'虚构小星',hasPin:true}},onLogin:noop,onComplete:noop,onCreate:noop,onBusyChange:noop}));
 assert.match(page,/家庭关联码 <span>选填<\/span><input[^>]*value=""/);assert.match(page,/继续，创建自己的家庭/);assert.doesNotMatch(page,/<input required/);
});
test('registered setup carries the name and does not ask to set PIN or child nickname again',()=>{
 const page=render(React.createElement(Setup,{onComplete:noop,onLogin:noop,accountFirst:true,account:{bound:false,signedIn:true,pending:true,childName:'虚构小星',hasPin:true}}));
 assert.match(page,/你好，虚构小星/);assert.match(page,/账号PIN已设置/);assert.doesNotMatch(page,/设置家长 PIN|再次输入 PIN|体验昵称/);
});
test('linked guardian has the same own-PIN form and reset support, without one-click bypass',()=>{
 const page=render(React.createElement(ParentUnlock,{onClose:noop,onUnlock:noop,onSessionChange:noop,account:{bound:true,signedIn:true,guardian:true,hasPin:true,username:'fixture_guardian'}}));
 assert.match(page,/自己的账号6位PIN/);assert.match(page,/class="pin-input"/);assert.match(page,/忘记PIN？用账号密码重设/);assert.doesNotMatch(page,/无需输入|用关联家长账号进入/);
});
test('Cantonese is available in correction and real-phone observation controls',()=>{
 assert.ok(speechLanguages.some(option=>option.value==='cantonese'&&option.label==='粤语'));assert.ok(PHONE_OBSERVATION_LANGUAGES.includes('cantonese'));assert.equal(PHONE_OBSERVATION_LANGUAGE_LABELS.cantonese,'粤语');
});


test('streamed Cantonese metadata is accepted and retained for correction without changing the reply language',async()=>{
 const transcript='今天想画花。';const metadata={inputSource:'interpretation',detectedLanguage:'cantonese'};
 const turn={transcript,reply:'好呀，你想画什么颜色的花？',replyId:'a33435b7-1c60-4c48-94d1-2e78b6a9b873',mode:'live',memoryRevision:1,globalRevision:1,speakerRevision:0,...metadata};
 const body=[{type:'transcript',text:transcript,...metadata},{type:'turn',turn}].map(value=>JSON.stringify(value)+'\n').join('');
 const seen:string[]=[];const decoded=await readAudioTurnStream(new Response(body,{headers:{'Content-Type':'application/x-ndjson'}}),text=>seen.push(text));
 assert.equal(decoded.detectedLanguage,'cantonese');assert.equal(decoded.reply,turn.reply);assert.deepEqual(seen,[transcript]);
});
