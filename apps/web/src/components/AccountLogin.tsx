import { useEffect, useRef, useState } from 'react';
import { api, ApiError, isConfiguredBootstrap, messageOf, post } from '../lib/api';
import type { Bootstrap } from '../lib/types';
import { Modal } from './Modal';

export function AccountLogin({onClose,onSessionChange,onBusyChange,initialUsername='',onRegister}:{onRegister?:()=>void;onClose:()=>void;onSessionChange:(data:Bootstrap)=>void|Promise<void>;onBusyChange?:(busy:boolean)=>void;initialUsername?:string}) {
 const [recovering,setRecovering]=useState(false);const [username,setUsername]=useState(initialUsername);const [password,setPassword]=useState('');const [recoveryCode,setRecoveryCode]=useState('');const [confirmation,setConfirmation]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [uncertain,setUncertain]=useState(false);
 const generation=useRef(0);const requestLocked=useRef(false);
 const clearSecrets=()=>{setPassword('');setRecoveryCode('');setConfirmation('');};
 useEffect(()=>()=>{++generation.current;},[]);
 useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
 const changeMode=(value:boolean)=>{if(requestLocked.current)return;clearSecrets();setRecovering(value);setUncertain(false);setError('');setNotice('');};
 const close=()=>{if(requestLocked.current)return;++generation.current;clearSecrets();onClose();};
 const submit=async()=>{
  if(requestLocked.current||uncertain)return;
  if(!/^[A-Za-z0-9_.-]{3,32}$/.test(username.trim())){setError('请输入3–32位字母、数字、下划线、点或短横线用户名。');return;}
  if(Array.from(password).length<8||password.length>128){setError('密码至少8位，最多128个字符。');return;}
  if(recovering&&(!recoveryCode.trim()||password!==confirmation)){setError('请填写恢复码，并确认两次新密码一致。');return;}
  requestLocked.current=true;const token=++generation.current;setBusy(true);setError('');setNotice('');
  try{
   if(recovering){await post('/account/recover',{username:username.trim(),recoveryCode:recoveryCode.trim(),newPassword:password});if(token!==generation.current)return;clearSecrets();setRecovering(false);setNotice('密码已重设。请用新密码登录，再到账号与安全保存新的恢复码。');}
   else{const value=await post<Bootstrap>('/account/login',{username:username.trim(),password});if(token!==generation.current)return;if((!isConfiguredBootstrap(value)&&!value.account?.pending)||!value.account?.signedIn)throw new Error('登录结果尚未确认。');clearSecrets();await onSessionChange(value);}
  }catch(err){if(token!==generation.current)return;clearSecrets();const unknown=!(err instanceof ApiError)||err.status>=500;setUncertain(unknown);setError(unknown?(recovering?'重设结果暂时未确认，请返回登录尝试新密码；不要重复用恢复码提交。':'登录结果暂时未确认，请先刷新确认状态，不要反复提交。'):messageOf(err));}
  finally{requestLocked.current=false;if(token===generation.current)setBusy(false);}
 };
 const verifyState=async()=>{if(requestLocked.current)return;requestLocked.current=true;const token=++generation.current;setBusy(true);setError('');try{const value=await api<Bootstrap>('/bootstrap');if(token!==generation.current)return;if((isConfiguredBootstrap(value)||value.account?.pending)&&value.account?.signedIn)await onSessionChange(value);else{setUncertain(false);setNotice('当前尚未登录，请重新输入账号密码。');}}catch{if(token===generation.current)setError('暂时无法确认登录状态，请稍后刷新页面。');}finally{requestLocked.current=false;if(token===generation.current)setBusy(false);}};
 return <Modal title={recovering?'用恢复码重设密码':'登录宝妍账号'} onClose={close} closeDisabled={busy}><form className="account-form" onSubmit={event=>{event.preventDefault();void submit();}}>
  <p className="account-note">{recovering?'使用注册或更新时保存的恢复码。成功后仍需用新密码登录。':'登录后找回同一家庭的记忆与设置。账号不代表监护身份认证；访客体验仍可使用。'}</p>
  <label className="field">用户名<input autoFocus value={username} maxLength={32} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy||uncertain} onChange={event=>setUsername(event.target.value)}/></label>
  {recovering?<label className="field">恢复码<input type="password" value={recoveryCode} maxLength={128} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy||uncertain} onChange={event=>setRecoveryCode(event.target.value)}/></label>:null}
  <label className="field">{recovering?'设置新密码':'账号密码'}<input type="password" value={password} minLength={8} maxLength={128} autoComplete={recovering?'new-password':'current-password'} disabled={busy||uncertain} onChange={event=>setPassword(event.target.value)}/></label>
  {recovering?<label className="field">再次输入新密码<input type="password" value={confirmation} maxLength={128} autoComplete="new-password" disabled={busy||uncertain} onChange={event=>setConfirmation(event.target.value)}/></label>:null}
  <p className="helper">密码至少8位，无需混合字母、数字或符号。不同家庭不能通过登录自动合并。</p>
  {error?<p className="error-note" role="alert">{error}</p>:null}{notice?<p className="success-note" role="status">{notice}</p>:null}
  <button className="button primary full" disabled={busy||uncertain}>{busy?'正在处理…':recovering?'重设密码':'登录并继续'}</button>
  {uncertain&&!recovering?<button type="button" className="button secondary full" disabled={busy} onClick={()=>void verifyState()}>刷新确认登录状态</button>:null}
  <button type="button" className="account-link" disabled={busy} onClick={()=>changeMode(!recovering)}>{recovering?'返回账号登录':'忘记密码？使用恢复码'}</button>
 {onRegister&&!recovering?<button type="button" className="account-link" disabled={busy} onClick={()=>{clearSecrets();onRegister();}}>没有账号？注册账号</button>:null}
 </form></Modal>;
}
