import type { CalibrationDraft } from './lib/calibration';
import './components/ImageTurnInput.css';
import './components/PhoneExperiencePanel.css';
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Info, LockKeyhole, MessageSquareWarning, RefreshCw, FlaskConical, Ellipsis, LogOut } from 'lucide-react';
import { api, messageOf, patch, post } from './lib/api';
import type { Bootstrap, Child, Outfit, Trial } from './lib/types';
import { ACCOUNT_CHECK_INTERVAL, ACCOUNT_RECHECK_EVENT, createAccountSessionCheck, type AccountSession } from './lib/accountSession';
import { trialDeadlineLabel, trialHasEnded, trialTimeOptions } from './lib/trial';
import { useCall } from './hooks/useCall';
import './account.css';
import { AccountOnboarding } from './components/AccountOnboarding';
import { AccountPanel } from './components/AccountPanel';
import { AccountLogin } from './components/AccountLogin';
import { Setup } from './components/Setup';
import { Home } from './components/Home';
import { CharacterMark } from './components/Avatar';
import { ParentUnlock } from './components/ParentUnlock';
import { ParentPanel } from './components/ParentPanel';
import { MemoryOperationsPanel } from './components/MemoryOperationsPanel';
import { Feedback } from './components/Feedback';
import type { FeedbackContext } from './lib/feedback';
import { Modal } from './components/Modal';
import { DebugRoom } from './components/DebugRoom';
const RealtimeExperience = lazy(() => import('./components/RealtimeExperience').then(module => ({ default: module.RealtimeExperience })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then(module => ({default:module.AdminPanel})));
export function App(){return ['/admin','/admin/'].includes(window.location?.pathname ?? '/')?<Suspense fallback={<main className="loading-screen" role="status">正在打开运营管理…</main>}><AdminPanel/></Suspense>:<CompanionApp/>;}
function CompanionApp(){const[data,setData]=useState<Bootstrap|null>(null);const[error,setError]=useState('');const[parent,setParent]=useState(false);const[unlock,setUnlock]=useState(false);const[loading,setLoading]=useState(true);const[parentBusy,setParentBusy]=useState(false);const sessionEpoch=useRef(0);const[accountSessionRevision,setAccountSessionRevision]=useState(0);const sessionChanging=useRef(false);const call=useCall(data,()=>{const token=sessionEpoch.current;if(sessionChanging.current)return;void api<Bootstrap>('/bootstrap').then(value=>{if(token===sessionEpoch.current&&!sessionChanging.current)acceptBootstrap(value);}).catch(()=>{});});
 const authorizationRevoked=useRef(false);const dataRef=useRef(data);dataRef.current=data;const revokeSession=useRef<()=>void>(()=>{});
 const[realtimeOpen,setRealtimeOpen]=useState(false);const[debugOpen,setDebugOpen]=useState(false);const[moreOpen,setMoreOpen]=useState(false);
 const[calibrationDraft,setCalibrationDraft]=useState<CalibrationDraft>();
 useEffect(()=>{setCalibrationDraft(undefined);},[data?.child?.id]);
 const[feedback,setFeedback]=useState<FeedbackContext|null>(null);const[feedbackOpening,setFeedbackOpening]=useState(false);const openingFeedback=useRef(false);const[parentNavigating,setParentNavigating]=useState(false);const parentNavigation=useRef(0);const parentNavigationBusy=useRef(false);
 const[trialNow,setTrialNow]=useState(Date.now);const trial=data?.trial;const trialExpired=trialHasEnded(trial,Math.max(trialNow,Date.now()));
 useEffect(()=>{
  if(!trial?.enabled)return;
  const deadline=Date.parse(trial.expiresAt);let timer:number|undefined;
  const update=()=>{window.clearTimeout(timer);const now=Date.now();setTrialNow(now);if(Number.isFinite(deadline)&&deadline>now)timer=window.setTimeout(update,Math.min(deadline-now+1,2147483647));};
  const onVisible=()=>{if(!document.hidden)update();};update();document.addEventListener('visibilitychange',onVisible);
  return()=>{window.clearTimeout(timer);document.removeEventListener('visibilitychange',onVisible);};
 },[trial?.enabled,trial?.expiresAt]);
 useEffect(()=>{if(trialExpired&&call.active)void call.end('本轮朋友内测已结束，收音和播放已停止。');},[trialExpired,call.active,call.end]);
 const[createFamily,setCreateFamily]=useState(false);const[accountLogin,setAccountLogin]=useState(false);const[registerRequested,setRegisterRequested]=useState(false);const[accountRegister,setAccountRegister]=useState(false);const registerPending=useRef(false);const[accountBusy,setAccountBusy]=useState(false);const[trialHelp,setTrialHelp]=useState(false);const companionView=!!data?.configured&&!parent&&!trialExpired;
 const[viewportHeight,setViewportHeight]=useState(()=>window.visualViewport?.height??window.innerHeight);
 useEffect(()=>{if(!companionView)return;const update=()=>setViewportHeight(Math.round(Math.min(window.innerHeight,window.visualViewport?.height??window.innerHeight)));update();window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update);return()=>{window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update);};},[companionView]);
 const acceptBootstrap=(value:Bootstrap)=>{if(authorizationRevoked.current&&value.account?.signedIn)return;if(dataRef.current?.account?.signedIn&&!value.account?.signedIn&&!sessionChanging.current){revokeSession.current();return;}setData(value);};
 const openTrialHelp=()=>{call.audio.stopCapture();call.setVoiceReady(false);if(call.voiceMode==='auto'&&call.state==='listening')call.setState('paused');setTrialHelp(true);};
 const closeTrialHelp=()=>{if(call.voiceMode==='auto'&&call.state==='listening')call.setState('paused');setTrialHelp(false);};
 const refresh=async()=>{const token=sessionEpoch.current;setCalibrationDraft(undefined);setLoading(true);setError('');try{let value=await api<Bootstrap>('/bootstrap');if(value.configured&&value.parentAuthorized){await post('/parent/lock');value=await api<Bootstrap>('/bootstrap');}if(token===sessionEpoch.current&&!sessionChanging.current){acceptBootstrap(value);setParent(false);}}catch(err){if(token===sessionEpoch.current)setError(messageOf(err));}finally{if(token===sessionEpoch.current)setLoading(false);}};
 useEffect(()=>{void refresh();},[]);
 const sessionChange=async(value:Bootstrap,keepUnlock=false)=>{setRealtimeOpen(false);const token=++sessionEpoch.current;setAccountSessionRevision(value=>value+1);++parentNavigation.current;sessionChanging.current=true;setCalibrationDraft(undefined);parentNavigationBusy.current=true;setParentNavigating(true);setParent(false);setUnlock(keepUnlock);setAccountLogin(false);setCreateFamily(false);setAccountRegister(false);setTrialHelp(false);setMoreOpen(false);setError('');call.memoryOperations.clear();try{if(call.active||['connecting','processing','listening','speaking'].includes(call.state))await call.end('账号授权已变化，通话已结束。');call.setState('idle');call.setError('');if(value.configured)await post('/parent/lock');const fresh=await api<Bootstrap>('/bootstrap');if(token!==sessionEpoch.current)return;authorizationRevoked.current=false;setData(fresh);setParent(false);setUnlock(keepUnlock&&fresh.configured&&fresh.account?.signedIn===true);}catch{if(token===sessionEpoch.current){if(!authorizationRevoked.current)setData({...value,parentAuthorized:false});setError('账号操作已返回，页面状态刷新暂未完成。请刷新页面确认，家长管理保持关闭。');}}finally{if(token===sessionEpoch.current){sessionChanging.current=false;parentNavigationBusy.current=false;setParentBusy(false);setAccountBusy(false);setParentNavigating(false);}}};
 revokeSession.current=()=>{
  if(authorizationRevoked.current||!dataRef.current?.account?.signedIn||sessionChanging.current)return;
  authorizationRevoked.current=true;setRealtimeOpen(false);++sessionEpoch.current;setAccountSessionRevision(value=>value+1);++parentNavigation.current;
  registerPending.current=false;parentNavigationBusy.current=false;sessionChanging.current=false;
  call.memoryOperations.clear();void call.end('账号已在其他设备登录或登录已失效，本设备已退出。');
  setCalibrationDraft(undefined);setParent(false);setUnlock(false);setAccountLogin(false);setAccountRegister(false);setCreateFamily(false);setRegisterRequested(false);setFeedback(null);setFeedbackOpening(false);setTrialHelp(false);setMoreOpen(false);setDebugOpen(false);setAccountBusy(false);setParentBusy(false);setParentNavigating(false);setLoading(false);
  setData(previous=>previous?{...previous,configured:false,child:null,account:{bound:false,signedIn:false},parentAuthorized:false,memoryCount:0,memberCount:0,globalMemories:[],remainingDailySeconds:0,demoSpeakers:undefined}:null);
  setError('账号已在其他设备登录或登录已失效，本设备已退出，请重新登录。');
 };
 useEffect(()=>{
  if(!data?.account?.signedIn)return;
  const epoch=sessionEpoch.current;
  const check=createAccountSessionCheck({read:signal=>api<AccountSession>('/account/session',{signal,cache:'no-store'}),isCurrent:()=>epoch===sessionEpoch.current&&!sessionChanging.current&&dataRef.current?.account?.signedIn===true&&!document.hidden,onInvalidated:()=>revokeSession.current()});
  const recheck=()=>{if(!document.hidden)void check.check();};
  const timer=window.setInterval(recheck,ACCOUNT_CHECK_INTERVAL);document.addEventListener('visibilitychange',recheck);window.addEventListener(ACCOUNT_RECHECK_EVENT,recheck);recheck();
  return()=>{check.stop();window.clearInterval(timer);document.removeEventListener('visibilitychange',recheck);window.removeEventListener(ACCOUNT_RECHECK_EVENT,recheck);};
 },[data?.account?.signedIn,data?.account?.expiresAt,data?.account?.username,accountSessionRevision]);
 const logout=async()=>{setRealtimeOpen(false);
  if(sessionChanging.current||accountBusy||parentNavigationBusy.current)return;
  setAccountBusy(true);setMoreOpen(false);setError('');
  try{void call.end('退出账号，收音和播放已停止。');const value=await post<Bootstrap>('/account/logout');await sessionChange(value);}
  catch(err){setError(messageOf(err));}finally{setAccountBusy(false);}
 };
 const renderSessionEpoch=sessionEpoch.current;
 const updateChild=(child:Child)=>{if(renderSessionEpoch!==sessionEpoch.current||authorizationRevoked.current)return;setData(value=>value?.configured?{...value,child}:value);};
 const preferences=async(value:{outfit?:Outfit;showCaptions?:boolean})=>{try{updateChild(await patch<Child>('/preferences',value));}catch(err){call.setError(messageOf(err));throw err;}};
 const openParent=async()=>{if(parentNavigationBusy.current)return;const token=++parentNavigation.current;parentNavigationBusy.current=true;setParentNavigating(true);setError('');try{await call.end('进入家长管理，通话已结束。');const value=await api<Bootstrap>('/bootstrap');if(token!==parentNavigation.current)return;acceptBootstrap(value);if(!value.configured){setParent(false);return;}if(value.parentAuthorized){setUnlock(false);if(registerPending.current){registerPending.current=false;setAccountRegister(true);}else setParent(true);}else{setUnlock(true);}}catch(err){if(token===parentNavigation.current)setError(messageOf(err));}finally{parentNavigationBusy.current=false;setParentNavigating(false);}};
 const suggestReply=()=>{if(!data?.child||!call.reply||!call.fullReply||call.inputKind==='image'||call.conversationMode.behavior==='translate'||parentNavigationBusy.current)return;const question=call.interpretedText||call.inputText;if(!question)return;setCalibrationDraft({question,actualReply:call.fullReply,ageGroup:data.child.ageGroup,title:'聊天回复调整',category:'接话自然度'});void openParent();};
 const closeParent=async()=>{if(parentNavigationBusy.current)return;setCalibrationDraft(undefined);++parentNavigation.current;parentNavigationBusy.current=true;setParentNavigating(true);try{await post('/parent/lock');setUnlock(false);setParent(false);await refresh();}catch(err){setError(messageOf(err));}finally{parentNavigationBusy.current=false;setParentNavigating(false);}};
 const finishParentUnlock=async()=>{const token=++parentNavigation.current;setUnlock(false);parentNavigationBusy.current=true;setParentNavigating(true);setError('');try{const value=await api<Bootstrap>('/bootstrap');if(token!==parentNavigation.current)return;acceptBootstrap(value);if(value.configured&&value.parentAuthorized&&registerPending.current){registerPending.current=false;setAccountRegister(true);setParent(false);}else setParent(value.configured&&value.parentAuthorized);if(value.configured&&!value.parentAuthorized)setUnlock(true);}catch(err){if(token===parentNavigation.current)setError(messageOf(err));}finally{parentNavigationBusy.current=false;setParentNavigating(false);}};
 const openFeedback=async()=>{
  if(openingFeedback.current||feedback)return;
  openingFeedback.current=true;setFeedbackOpening(true);
  const context:FeedbackContext={page:!data?'connection':trialExpired?'expired':!data.configured?'setup':parent||unlock?'parent':call.active?'call':'home',callState:call.state,appVersion:'0.2.0'};
  try{++parentNavigation.current;void call.end('打开问题反馈，通话已结束。');setUnlock(false);setFeedback(context);}finally{openingFeedback.current=false;setFeedbackOpening(false);}
 };
 const openRegister=()=>{setAccountLogin(false);setRegisterRequested(false);setCreateFamily(false);if(data?.configured){registerPending.current=true;void openParent();}};
 const setupComplete=async(value:Bootstrap)=>{await sessionChange(value);if(registerRequested){registerPending.current=true;setUnlock(true);}};
 const openLogin=async()=>{if(accountBusy||parentNavigationBusy.current)return;if(call.active||['connecting','processing','listening','speaking'].includes(call.state))await call.end('打开账号登录，通话已结束。');setAccountLogin(true);};
 const openDebug=async()=>{if(parentNavigationBusy.current||accountBusy)return;setMoreOpen(false);await call.end('进入内测调试，普通聊天已结束。');setCalibrationDraft(undefined);setParent(false);setUnlock(false);setTrialHelp(false);if(data?.parentAuthorized){try{await post('/parent/lock');}catch{}}setDebugOpen(true);};
 const openRealtime=()=>{if(call.active||call.state==='connecting'||parentNavigating||accountBusy||feedback!==null||unlock||accountRegister)return;setMoreOpen(false);setRealtimeOpen(true);};
 const mode=data?.mode??'demo';
 if(realtimeOpen&&data?.configured&&data.child&&!trialExpired)return <Suspense fallback={<main className="loading-screen" role="status">正在打开实时语音体验…</main>}><RealtimeExperience key={`${data.child.id}:${accountSessionRevision}`} data={data} onClose={()=>{setRealtimeOpen(false);void refresh();}} onFinished={()=>{const token=sessionEpoch.current;void api<Bootstrap>('/bootstrap').then(value=>{if(token===sessionEpoch.current&&!sessionChanging.current)acceptBootstrap(value);}).catch(()=>{});}}/></Suspense>;
 if(debugOpen)return <DebugRoom onClose={()=>{setDebugOpen(false);void refresh();}}/>;
 return <div className={`app-shell ${companionView?`companion-shell ${call.active?'companion-call-shell':''}`:''}`} style={companionView?{'--companion-viewport-height':`${viewportHeight}px`} as CSSProperties:undefined}><header className="app-header"><div className="brand"><CharacterMark/><div><strong>宝妍 <span>bobo</span></strong><small>开心和小烦恼，都能聊</small></div></div><div className="header-actions">{!parent&&!call.active?<button type="button" className="more-entry" aria-label="更多" disabled={parentNavigating||accountBusy||accountRegister||unlock||feedback!==null} onClick={()=>setMoreOpen(true)}><Ellipsis size={20}/><span>更多</span></button>:null}{data&&!parent&&!call.active?<div className="home-account-entry">{data.account?.signedIn?<button disabled={accountBusy||parentNavigating||feedback!==null||unlock||accountRegister} onClick={()=>void logout()} aria-label="退出登录">退出登录</button>:<><button disabled={accountBusy||parentNavigating||feedback!==null||unlock||accountRegister} onClick={()=>void openLogin()}>登录</button>{!data.account?.bound?<button disabled={accountBusy||parentNavigating||feedback!==null||unlock||accountRegister} onClick={openRegister}>注册账号</button>:null}</>}</div>:null}{companionView&&call.active&&trial?.enabled?<TrialNotice compact onOpen={openTrialHelp}/>:null}<button className="feedback-entry" disabled={feedbackOpening||accountBusy||accountRegister||sessionChanging.current} onClick={()=>void openFeedback()}><MessageSquareWarning size={17}/><span>{feedbackOpening?'正在暂停…':'问题反馈'}</span></button>{!trial?.enabled?<span className={`mode-badge ${mode==='live'?'live':''}`}><span/>开发体验</span>:null}{data?.configured?<button className="parent-entry" disabled={parentBusy||parentNavigating||accountBusy||accountRegister} onClick={()=>parent?void closeParent():void openParent()}><LockKeyhole size={17}/><span>{parent?'回到宝妍':'家长管理'}</span></button>:null}</div></header>
 {trial?.enabled&&!(companionView&&call.active)?<TrialNotice expired={trialExpired} companion={companionView} onOpen={openTrialHelp}/>:null}
 {parent&&call.memoryOperations.operations.length?<aside className="parent-operation-results"><MemoryOperationsPanel operations={call.memoryOperations.operations} onQuery={id=>void call.memoryOperations.query(id)}/></aside>:null}
 {loading&&!data?<main className="loading-screen"><CharacterMark/><p>宝妍正在准备，马上见…</p></main>:error&&!data?<main className="connection-error"><h1>宝妍还没准备好</h1><p>{error}</p><button className="button primary" onClick={()=>void refresh()}><RefreshCw size={18}/>重新连接</button></main>:data?parentNavigating?<main className="management-navigation" role="status"><CharacterMark/><p>正在确认最新资料…</p><small>陪伴和收音已暂停。</small></main>:!data.configured&&(!createFamily||!data.account?.pending)?<AccountOnboarding data={data} onLogin={()=>setAccountLogin(true)} onComplete={sessionChange} onCreate={()=>setCreateFamily(true)} onBusyChange={setAccountBusy}/>:!data.configured?<Setup account={data.account} onChooseFamily={()=>setCreateFamily(false)} accountFirst={data.account?.pending} registerRequested={registerRequested} onLogin={()=>setAccountLogin(true)} deviceTestPaused={feedbackOpening||feedback!==null||accountLogin} onComplete={value=>void setupComplete(value)} trial={trial} expired={trialExpired}/>:parent?<ParentPanel initialCalibrationDraft={calibrationDraft} onCalibrationDraftConsumed={()=>setCalibrationDraft(undefined)} onSessionChange={sessionChange} data={data} deviceTestPaused={feedbackOpening||feedback!==null} onBusyChange={setParentBusy} onChild={updateChild} onClose={()=>void closeParent()} onWithdraw={()=>{call.memoryOperations.clear();setParent(false);void refresh();}}/>:trialExpired?<main className="trial-ended-card"><ShieldTrial/><h1>这轮内测先到这里</h1><p>谢谢你和宝妍一起体验。暂时不能开始新的聊天，请联系分享人了解后续安排。</p><button className="button secondary" disabled={parentNavigating} onClick={()=>void openParent()}><LockKeyhole size={18}/>进入家长管理</button><p className="helper">仍可查看、导出资料，或撤回授权并清除资料。</p></main>:<Home onRealtime={openRealtime} onSuggestReply={suggestReply} data={data} call={call} onPreference={preferences} interactionPaused={trialHelp||unlock||accountLogin||accountRegister||feedbackOpening||feedback!==null}/>:null}
 {error&&data?<p className="global-error" role="alert">{error}</p>:null}<footer className="app-footer"><span>bobo · AI 小伙伴</span>{!trial?.enabled?<p>内部开发体验，请由成年人使用虚构资料。</p>:null}</footer>{moreOpen?<Modal title="更多" onClose={()=>setMoreOpen(false)}>{data?.account?.signedIn?<><p className="helper">当前账号：{data.account.username} · {data.account.childName??data.child?.nickname}</p><button type="button" className="button secondary full" disabled={parentNavigating||accountBusy} onClick={()=>void logout()}><LogOut size={18}/>退出登录</button></>:null}<button type="button" className="button secondary full" disabled={parentNavigating||accountBusy} onClick={()=>void openDebug()}><FlaskConical size={18}/>内测调试</button><p className="helper">供内测时调整回答，进入仍需验证调试密码。</p><a className="button secondary full" href="/admin"><LockKeyhole size={18}/>运营管理</a>{trial?<details className="more-about"><summary>关于宝妍与内测</summary><TrialExperienceDetails trial={trial}/></details>:null}</Modal>:null}{trialHelp&&trial?.enabled?<Modal title="体验说明" onClose={closeTrialHelp}><TrialExperienceDetails trial={trial}/><button className="button primary full" onClick={closeTrialHelp}>回到宝妍</button></Modal>:null}{unlock?<ParentUnlock onBusyChange={setAccountBusy} account={data?.account} onSessionChange={value=>sessionChange(value,true)} onClose={()=>{++parentNavigation.current;setUnlock(false);registerPending.current=false;setCalibrationDraft(undefined);}} onUnlock={()=>void finishParentUnlock()}/>:null}{accountRegister&&data?.configured?<Modal title="注册宝妍账号" closeDisabled={accountBusy} onClose={()=>{setAccountRegister(false);setRegisterRequested(false);void post('/parent/lock').then(()=>refresh());}}><AccountPanel initialAction="register" data={data} onBusyChange={setAccountBusy} onSessionChange={sessionChange}/></Modal>:null}{accountLogin?<AccountLogin onRegister={data?.account?.bound?undefined:openRegister} onClose={()=>setAccountLogin(false)} onSessionChange={sessionChange} onBusyChange={setAccountBusy}/>:null}{feedback?<Feedback context={feedback} onClose={()=>setFeedback(null)}/>:null}</div>;
}

function ShieldTrial(){return <CharacterMark/>;}


export function TrialNotice({expired=false,compact=false,companion=false,onOpen}:{expired?:boolean;compact?:boolean;companion?:boolean;onOpen:()=>void}){
 if(compact)return <button type="button" className="companion-info-entry" aria-label="体验说明：成年人使用虚构资料" title="体验说明" onClick={onOpen}><Info size={18} aria-hidden="true"/></button>;
 return <aside className={companion?'companion-trial-summary':'trial-banner trial-notice consolidated-trial-notice'}><button type="button" className="trial-summary-button" onClick={onOpen}><span><strong>{expired?'本轮内测已结束':'朋友内测'}</strong><small>{expired?'聊天已暂停，资料仍可管理。':'请由成年人使用虚构资料体验。'}</small></span><span>体验说明 ›</span></button></aside>;
}
export function TrialExperienceDetails({trial}:{trial:Trial}){
 const timing=trialTimeOptions(trial);
 return <><p>请由成年人使用虚构资料体验，不填写真实儿童信息。</p><p className="helper">内测截止：{trialDeadlineLabel(trial)}。{timing.valid?`单次最多 ${timing.sessionLimit} 分钟，每日最多 ${timing.dailyLimit} 分钟。`:''}</p><p className="helper">暂离页面会结束通话。新建资料的专属记忆默认开启，可在家长管理关闭。开启时，聊天结束会自动整理摘要，可查看、修改和删除。</p><p className="helper">我是宝妍，你的 AI 小姐姐。当前仍在内测，人物形象和语音能力继续打磨中。</p></>;
}
