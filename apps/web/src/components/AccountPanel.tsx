import { useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { api, ApiError, isConfiguredBootstrap, messageOf, post } from '../lib/api';
import type { Bootstrap } from '../lib/types';
import { GuardianPanel } from './GuardianPanel';
import { AccountLogin } from './AccountLogin';
import { RegistrationFields, registrationIdentityError } from './RegistrationFields';

type Action = 'register'|'password'|'recovery'|'logout'|null;
type AccountResult = {bootstrap:Bootstrap;recoveryCode:string};
const validUsername = (value:string) => /^[A-Za-z0-9_.-]{3,32}$/.test(value);
const validPassword = (value:string) => Array.from(value).length>=8&&value.length<=128;

export function AccountPanel({data,onSessionChange,onBusyChange,initialAction=null}:{initialAction?:Action;data:Bootstrap;onSessionChange:(data:Bootstrap)=>void|Promise<void>;onBusyChange:(busy:boolean)=>void}) {
 const [action,setAction]=useState<Action>(initialAction);
 const [username,setUsername]=useState('');const [registrationPhone,setRegistrationPhone]=useState('');const [registrationName,setRegistrationName]=useState(data.child?.nickname??'');const [registrationPin,setRegistrationPin]=useState('');const [registrationPinAgain,setRegistrationPinAgain]=useState('');const [password,setPassword]=useState('');const [nextPassword,setNextPassword]=useState('');const [confirmation,setConfirmation]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [uncertain,setUncertain]=useState(false);
 const [recoveryCode,setRecoveryCode]=useState('');const [saved,setSaved]=useState(false);const [pendingBootstrap,setPendingBootstrap]=useState<Bootstrap>();
 const [contactBusy,setContactBusy]=useState(false);
 const [loginOpen,setLoginOpen]=useState(false);const [loginBusy,setLoginBusy]=useState(false);
 const requestLocked=useRef(false);const generation=useRef(0);
 const clearSecrets=()=>{setPassword('');setNextPassword('');setConfirmation('');setRegistrationPin('');setRegistrationPinAgain('');};
 useEffect(()=>()=>{++generation.current;},[]);
 useEffect(()=>{onBusyChange(busy||!!recoveryCode||loginBusy||contactBusy);return()=>onBusyChange(false);},[busy,recoveryCode,loginBusy,contactBusy,onBusyChange]);
 const choose=(next:Action)=>{if(requestLocked.current||recoveryCode||contactBusy)return;clearSecrets();setRegistrationPhone('');setAction(next);setError('');setNotice('');setUncertain(false);};
 const finishCode=async()=>{if(!saved||requestLocked.current)return;requestLocked.current=true;setBusy(true);const value=pendingBootstrap;setRecoveryCode('');setSaved(false);setPendingBootstrap(undefined);setAction(null);clearSecrets();try{if(value)await onSessionChange(value);else setNotice('恢复码已更新，旧恢复码已失效。');}finally{requestLocked.current=false;setBusy(false);}};
 const submit=async()=>{
  if(requestLocked.current||uncertain||!action)return;
  if(action==='register'&&!validUsername(username.trim())){setError('用户名需为3–32位字母、数字、下划线、点或短横线。');return;}
  if(action==='register'){const identityError=registrationIdentityError(registrationName,registrationPhone,registrationPin,registrationPinAgain);if(identityError){setError(identityError);return;}}
  if(action!=='logout'&&!validPassword(password)){setError('密码至少8位，最多128个字符。');return;}
  if((action==='register'&&password!==confirmation)||(action==='password'&&(nextPassword!==confirmation||!validPassword(nextPassword)))){setError('请确认新密码至少8位、最多128个字符，且两次输入一致。');return;}
  requestLocked.current=true;const token=++generation.current;setBusy(true);setError('');setNotice('');
  try{
   if(action==='logout'){const value=await post<Bootstrap>('/account/logout');if(token!==generation.current)return;clearSecrets();await onSessionChange(value);return;}
   const result=action==='register'?await post<AccountResult>('/parent/account/register',{username:username.trim(),password,contactPhone:registrationPhone.trim(),childName:registrationName.trim(),pin:registrationPin}):action==='password'?await post<AccountResult>('/parent/account/password',{password,newPassword:nextPassword}):await post<{recoveryCode:string}>('/parent/account/recovery',{password});
   if(token!==generation.current)return;
   if(!result.recoveryCode||typeof result.recoveryCode!=='string')throw new Error('结果尚未确认。');
   if((action==='register'||action==='password')&&!isConfiguredBootstrap((result as AccountResult).bootstrap))throw new Error('账号状态尚未确认。');
   clearSecrets();setRegistrationPhone('');setRecoveryCode(result.recoveryCode);setSaved(false);if(action==='register'||action==='password')setPendingBootstrap((result as AccountResult).bootstrap);
  }catch(err){if(token!==generation.current)return;clearSecrets();const unknown=!(err instanceof ApiError)||err.status>=500;setUncertain(unknown);setError(unknown?'结果暂时无法确认，操作可能已生效。请先刷新确认，不要重复提交；若未取得恢复码，可验证密码后重新生成。':messageOf(err));}
  finally{requestLocked.current=false;if(token===generation.current)setBusy(false);}
 };
 const verifyState=async()=>{if(requestLocked.current)return;requestLocked.current=true;const token=++generation.current;setBusy(true);setError('');try{const value=await api<Bootstrap>('/bootstrap');if(token===generation.current)await onSessionChange(value);}catch{if(token===generation.current)setError('暂时无法确认状态，请稍后刷新页面。不要重复提交原操作。');}finally{requestLocked.current=false;if(token===generation.current)setBusy(false);}};
 const copyCode=async()=>{try{await navigator.clipboard.writeText(recoveryCode);setNotice('恢复码已复制，请存到你能找回的安全位置。');}catch{setNotice('浏览器未允许复制，请手动保存这次显示的恢复码。');}};
 const account=data.account;
 return <section className="account-panel"><div className="panel-title"><div><span className="eyebrow">在不同设备继续陪伴</span><h2>账号与安全</h2></div><ShieldCheck size={25}/></div>
  <div className="account-status-card"><UserRound size={22}/><div><strong>{account?.bound?`已绑定账号 ${account.username??''}`:'当前是访客体验'}</strong><p>{account?.bound?'账号默认只在一台设备登录；其他设备登录后，这里会退出。家长管理使用自己的账号PIN。':'注册后将绑定当前家庭资料，再用同一账号在其他设备登录。'}</p></div></div>
  <p className="account-note">账号不是监护身份认证。不同家庭不会自动合并；退出仅清除本设备授权，家庭资料仍保留。当前内测期限不因注册改变。</p>
  {recoveryCode?<div className="account-recovery-result" role="status"><h3>请保存这次恢复码</h3><p>仅这次显示，用于忘记密码时重设。请勿发给他人；旧恢复码已失效。</p><code>{recoveryCode}</code><button className="button secondary" onClick={()=>void copyCode()}><Copy size={16}/>复制恢复码</button><label className="check-row"><input type="checkbox" checked={saved} onChange={event=>setSaved(event.target.checked)}/><span>我已妥善保存恢复码。</span></label><button className="button primary full" disabled={!saved||busy} onClick={()=>void finishCode()}>{pendingBootstrap?'完成，回到宝妍':'完成'}</button></div>:
   action?<form className="account-form subform" onSubmit={event=>{event.preventDefault();void submit();}}><h3>{action==='register'?'注册并绑定当前家庭':action==='password'?'修改账号密码':action==='recovery'?'更新恢复码':'退出当前设备'}</h3>
    {action==='logout'?<p>退出后，本设备需重新登录才能使用这份家庭资料。记忆和设置会保留。</p>:<>
     {action==='register'?<label className="field">用户名<input value={username} maxLength={32} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy||uncertain} onChange={event=>setUsername(event.target.value)}/><small>3–32位字母、数字、下划线、点或短横线。</small></label>:null}
     <label className="field">{action==='register'?'设置账号密码':'当前账号密码'}<input type="password" value={password} minLength={8} maxLength={128} autoComplete={action==='register'?'new-password':'current-password'} disabled={busy||uncertain} onChange={event=>setPassword(event.target.value)}/></label>
     {action==='password'?<label className="field">新密码<input type="password" value={nextPassword} minLength={8} maxLength={128} autoComplete="new-password" disabled={busy||uncertain} onChange={event=>setNextPassword(event.target.value)}/></label>:null}
     {action==='register'||action==='password'?<label className="field">再次输入{action==='register'?'密码':'新密码'}<input type="password" value={confirmation} maxLength={128} autoComplete="new-password" disabled={busy||uncertain} onChange={event=>setConfirmation(event.target.value)}/></label>:null}
     {action==='register'?<RegistrationFields childName={registrationName} onChildName={setRegistrationName} phone={registrationPhone} onPhone={setRegistrationPhone} pin={registrationPin} onPin={setRegistrationPin} pinAgain={registrationPinAgain} onPinAgain={setRegistrationPinAgain} disabled={busy||uncertain}/>:null}
     <p className="helper">{action==='password'?'改密后，所有旧设备登录会失效，当前设备仍登录；家长管理需重新验证PIN。':action==='recovery'?'更新后旧恢复码立即失效。新恢复码仅显示一次。':'密码至少8位，请选择其他网站没有使用过的密码。绑定后请保存一次性恢复码。'}</p>
    </>}
    <div className="inline-actions"><button className={`button ${action==='logout'?'danger-outline':'primary'}`} disabled={busy||uncertain}>{busy?'正在处理…':action==='register'?'注册并绑定':action==='password'?'保存新密码':action==='recovery'?'生成新恢复码':'确认退出'}</button><button type="button" className="button ghost" disabled={busy} onClick={()=>choose(null)}>取消</button></div>
   </form>:<div className="account-actions">{!account?.bound?<button className="button primary" onClick={()=>choose('register')}><UserRound size={17}/>注册并绑定当前家庭</button>:!account.signedIn?<button className="button primary" onClick={()=>setLoginOpen(true)}>登录已绑定账号</button>:<><button className="button secondary" disabled={!account.signedIn||contactBusy} onClick={()=>choose('password')}><KeyRound size={17}/>修改密码</button><button className="button secondary" disabled={!account.signedIn||contactBusy} onClick={()=>choose('recovery')}>更新恢复码</button><button className="button ghost" disabled={contactBusy} onClick={()=>choose('logout')}><LogOut size={17}/>退出当前设备</button></>}</div>}
  {!action&&!recoveryCode&&!loginOpen&&data.parentAuthorized&&account?.signedIn?<AccountContact
   key={`${account.username??''}:${account.expiresAt??''}`}
   username={account.username??'当前账号'}
   onBusyChange={setContactBusy}
  />:null}
  {uncertain?<button className="button secondary" disabled={busy} onClick={()=>void verifyState()}>刷新确认账号状态</button>:null}
  {error?<p className="error-note" role="alert">{error}</p>:null}{notice?<p className="success-note" role="status">{notice}</p>:null}
  {data.parentAuthorized&&account?.signedIn&&!account.guardian?<GuardianPanel onBusyChange={onBusyChange}/>:null}
  {loginOpen?<AccountLogin initialUsername={account?.username} onClose={()=>setLoginOpen(false)} onSessionChange={onSessionChange} onBusyChange={setLoginBusy}/>:null}
 </section>;
}

type AccountContactValue = { contactPhone: string; revision: number; verified: false };
type ContactPhase = 'loading' | 'ready' | 'error' | 'forbidden' | 'uncertain';

/** This panel fetches only the authenticated account's contact, never bootstrap or another account. */
export function AccountContact({ username, onBusyChange }: { username: string; onBusyChange: (busy: boolean) => void }) {
 const [contact, setContact] = useState<AccountContactValue | null>(null);
 const [draft, setDraft] = useState('');
 const [phase, setPhase] = useState<ContactPhase>('loading');
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const generation = useRef(0);
 const request = useRef<AbortController | null>(null);
 const writing = useRef(false);
 const busy = saving || phase === 'loading';

 useEffect(() => {
  onBusyChange(busy);
  return () => onBusyChange(false);
 }, [busy, onBusyChange]);

 const clearContact = () => { setContact(null); setDraft(''); setNotice(''); };
 const load = async () => {
  if (writing.current) return;
  request.current?.abort();
  const controller = new AbortController(); request.current = controller;
  const token = ++generation.current;
  clearContact(); setPhase('loading'); setError('');
  try {
   const value = await api<AccountContactValue>('/parent/account/contact', { signal: controller.signal, cache: 'no-store' });
   if (controller.signal.aborted || token !== generation.current) return;
   setContact(value); setDraft(value.contactPhone); setPhase('ready');
  } catch (cause) {
   if (controller.signal.aborted || token !== generation.current) return;
   const forbidden = cause instanceof ApiError && [401, 403].includes(cause.status);
   clearContact(); setPhase(forbidden ? 'forbidden' : 'error');
   setError(forbidden ? '账号或家长授权已失效，请重新登录并进入家长管理。' : '暂时没有读到联系方式，请重新读取。');
  } finally {
   if (request.current === controller) request.current = null;
  }
 };
 useEffect(() => {
  void load();
  return () => { ++generation.current; request.current?.abort(); request.current = null; };
 }, []);

 const save = async () => {
  if (writing.current || !contact || phase !== 'ready') return;
  writing.current = true; setSaving(true); setError(''); setNotice('');
  request.current?.abort();
  const controller = new AbortController(); request.current = controller;
  const token = ++generation.current;
  try {
   const value = await api<AccountContactValue>('/parent/account/contact', {
    method: 'POST', signal: controller.signal,
    body: JSON.stringify({ contactPhone: draft.trim(), revision: contact.revision }),
   });
   if (controller.signal.aborted || token !== generation.current) return;
   setContact(value); setDraft(value.contactPhone);
   setNotice(value.contactPhone ? '联系电话已保存。' : '联系电话已清除。');
  } catch (cause) {
   if (controller.signal.aborted || token !== generation.current) return;
   if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
    clearContact(); setPhase('forbidden'); setError('账号或家长授权已失效，请重新登录并进入家长管理。');
   } else if (cause instanceof ApiError && cause.status === 409) {
    clearContact(); setPhase('error'); setError('联系方式已在另一处更新，请重新读取后再修改。');
   } else if (!(cause instanceof ApiError) || cause.status >= 500) {
    clearContact(); setPhase('uncertain'); setError('暂时无法确认是否保存成功，请重新读取后核对，不要重复提交。');
   } else setError(messageOf(cause));
  } finally {
   writing.current = false;
   if (request.current === controller) request.current = null;
   if (token === generation.current) setSaving(false);
  }
 };
 const changed = contact !== null && draft.trim() !== contact.contactPhone;
 return <section className="account-form subform" aria-label="本人联系电话">
  <h3>我的联系电话</h3>
  <p className="helper">只修改账号 {username} 的联系方式。选填，仅用于运营联系；不做短信验证，也不用于登录或找回密码。</p>
  {phase === 'loading' ? <p className="helper" role="status">正在读取本人联系方式…</p> : null}
  {phase === 'ready' && contact ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
   <label className="field">联系手机号（选填）
    <input type="tel" inputMode="tel" autoComplete="tel" maxLength={40} value={draft} disabled={saving} onChange={event => { setDraft(event.target.value); setNotice(''); setError(''); }}/>
    <small>可填写国内 11 位手机号，或以 + 和国家区号开头的国际号码。留空并保存即可清除。</small>
   </label>
   {contact.contactPhone ? <p className="helper">当前号码为本人自填，未经短信验证。</p> : <p className="helper">还没有填写联系电话，不影响使用。</p>}
   <div className="inline-actions">
    <button className="button primary" type="submit" disabled={saving || !changed}>{saving ? '正在保存…' : !draft.trim() && contact.contactPhone ? '保存清除' : '保存联系电话'}</button>
    {draft ? <button className="button ghost" type="button" disabled={saving} onClick={() => { setDraft(''); setNotice(''); }}>清空输入</button> : null}
    {changed ? <button className="button ghost" type="button" disabled={saving} onClick={() => { setDraft(contact.contactPhone); setNotice(''); setError(''); }}>取消修改</button> : null}
   </div>
  </form> : null}
  {error ? <p className="error-note" role="alert">{error}</p> : null}
  {notice ? <p className="success-note" role="status">{notice}</p> : null}
  {phase === 'error' || phase === 'uncertain' ? <button className="button secondary" disabled={busy} onClick={() => void load()}>重新读取联系方式</button> : null}
 </section>;
}
