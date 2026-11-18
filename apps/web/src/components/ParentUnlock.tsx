import { useEffect, useRef, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { ApiError, messageOf, post } from '../lib/api';
import type { Bootstrap } from '../lib/types';
import { AccountLogin } from './AccountLogin';
import { Modal } from './Modal';
export function ParentUnlock({onClose,onUnlock,account,onSessionChange,onBusyChange}:{onClose:()=>void;onUnlock:()=>void;account?:Bootstrap['account'];onSessionChange?:(data:Bootstrap)=>void|Promise<void>;onBusyChange?:(busy:boolean)=>void}) {
 const generation=useRef(0);const requestLocked=useRef(false);
 const [pin,setPin]=useState('');const [password,setPassword]=useState('');const [nextPin,setNextPin]=useState('');const [confirmation,setConfirmation]=useState('');const [recovering,setRecovering]=useState(false);
 const [loginOpen,setLoginOpen]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [uncertain,setUncertain]=useState(false);
 const clearSecrets=()=>{setPin('');setPassword('');setNextPin('');setConfirmation('');};
 useEffect(()=>()=>{++generation.current;},[]);
 useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
 const close=()=>{if(requestLocked.current)return;++generation.current;clearSecrets();onClose();};
 const changeMode=(value:boolean)=>{if(requestLocked.current)return;clearSecrets();setError('');setNotice('');setUncertain(false);setRecovering(value);};
 const submit=async()=>{
  if(requestLocked.current||uncertain)return;
  if(recovering){if(!account?.signedIn||!onSessionChange){setError('请先登录已绑定的账号，再重设家长PIN。');return;}if(Array.from(password).length<8||password.length>128||!/^\d{6}$/.test(nextPin)||nextPin!==confirmation){setError('请填写账号密码，并确认两次新PIN均为相同的6位数字。');return;}}
  else if(!/^\d{6}$/.test(pin))return;
  requestLocked.current=true;const token=++generation.current;setBusy(true);setError('');setNotice('');
  try{
   if(recovering){const value=await post<Bootstrap>('/account/pin',{password,pin:nextPin});if(token!==generation.current)return;clearSecrets();setRecovering(false);await onSessionChange?.(value);if(token===generation.current)setNotice('PIN已更新，请重新输入新PIN进入家长管理。');}
   else{await post('/parent/unlock',{pin});if(token!==generation.current){await post('/parent/lock');return;}setPin('');onUnlock();}
  }catch(err){if(token!==generation.current)return;clearSecrets();const unknown=recovering&&(!(err instanceof ApiError)||err.status>=500);setUncertain(unknown);setError(unknown?'PIN重设结果暂时未确认，请返回PIN验证尝试新PIN；不要重复提交重设。':messageOf(err));}
  finally{requestLocked.current=false;if(token===generation.current)setBusy(false);}
 };
 if(loginOpen&&onSessionChange)return <AccountLogin onBusyChange={onBusyChange} initialUsername={account?.username} onClose={()=>setLoginOpen(false)} onSessionChange={async value=>{clearSecrets();setLoginOpen(false);await onSessionChange(value);}}/>;
 return <Modal closeDisabled={busy} title={recovering?'重设家长PIN':'家长验证'} onClose={close}><div className="lock-circle"><LockKeyhole size={27}/></div><p className="muted">{recovering?'用已登录账号的密码重设自己的账号PIN。账号验证不会自动打开家长管理。':'请输入自己的账号6位PIN。进入管理前，当前通话已结束。'}</p>
  <form className={recovering?'pin-account-recovery account-form':''} onSubmit={event=>{event.preventDefault();void submit();}}>
   {recovering?<><label className="field">账号密码<input type="password" autoComplete="current-password" value={password} maxLength={128} disabled={busy||uncertain} onChange={event=>setPassword(event.target.value)}/></label><label className="field">设置新家长PIN<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={nextPin} disabled={busy||uncertain} onChange={event=>setNextPin(event.target.value.replace(/\D/g,''))}/></label><label className="field">再次输入新PIN<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={confirmation} disabled={busy||uncertain} onChange={event=>setConfirmation(event.target.value.replace(/\D/g,''))}/></label></>:<label className="field">家长PIN<input className="pin-input" type="password" autoFocus inputMode="numeric" autoComplete="current-password" maxLength={6} value={pin} disabled={busy} onChange={event=>setPin(event.target.value.replace(/\D/g,''))} placeholder="••••••"/></label>}
   {error?<p className="error-note" role="alert">{error}</p>:null}{notice?<p className="success-note" role="status">{notice}</p>:null}
   <button className="button primary full" disabled={busy||uncertain||(!recovering&&pin.length!==6)}>{busy?'正在验证…':recovering?'保存新PIN':'进入家长管理'}</button>
  </form>
  {recovering?<button className="account-link" disabled={busy} onClick={()=>changeMode(false)}>返回PIN验证</button>:account?.signedIn?<button className="account-link" disabled={busy} onClick={()=>changeMode(true)}>忘记PIN？用账号密码重设</button>:<details className="pin-account-recovery"><summary>忘记PIN？</summary><p className="helper">{account?.bound?'需先登录已绑定的账号，再用账号密码重设；访客设备不能绕过PIN进入管理。':'当前访客资料尚未绑定账号，无法通过账号密码找回PIN。请使用仍可进入管理的原设备。'}</p>{account?.bound&&onSessionChange?<button className="button secondary full" disabled={busy} onClick={()=>{clearSecrets();setLoginOpen(true);}}>登录账号找回PIN</button>:null}</details>}
 </Modal>;
}
