import { useEffect, useRef, useState } from 'react';
import { post, messageOf, ApiError } from '../lib/api';
import type { Bootstrap } from '../lib/types';
import { Avatar } from './Avatar';
import { RegistrationFields, registrationIdentityError } from './RegistrationFields';

export function AccountOnboarding({ data, onLogin, onComplete, onCreate, onBusyChange }: { data: Bootstrap; onLogin: () => void; onComplete: (data: Bootstrap) => void | Promise<void>; onCreate: () => void; onBusyChange: (busy: boolean) => void }) {
 const [username, setUsername] = useState(''); const [contactPhone, setContactPhone] = useState('');
 const [childName, setChildName] = useState(''); const [pin, setPin] = useState(''); const [pinAgain, setPinAgain] = useState('');
 const [password, setPassword] = useState(''); const [again, setAgain] = useState(''); const [code, setCode] = useState('');
 const [recovery, setRecovery] = useState(''); const [saved, setSaved] = useState(false); const [pending, setPending] = useState<Bootstrap>();
 const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [uncertain, setUncertain] = useState(false);
 const locked = useRef(false); const mounted = useRef(true);
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
 useEffect(() => { onBusyChange(busy || !!recovery); return () => onBusyChange(false); }, [busy, recovery, onBusyChange]);
 const clearSecrets = () => { setPassword(''); setAgain(''); setPin(''); setPinAgain(''); };
 const run = async (kind: 'register' | 'join' | 'logout') => {
  if (locked.current || uncertain) return;
  if (kind === 'register') {
   if (password !== again || Array.from(password).length < 8) { setError('请设置至少8位的密码，并确认两次输入一致。'); return; }
   const identityError = registrationIdentityError(childName, contactPhone, pin, pinAgain); if (identityError) { setError(identityError); return; }
  }
  if (kind === 'join' && !code.trim()) { onCreate(); return; }
  locked.current = true; setBusy(true); setError('');
  try {
   if (kind === 'register') {
    const value = await post<{ bootstrap: Bootstrap; recoveryCode: string }>('/account/register', { username: username.trim(), password, contactPhone: contactPhone.trim(), childName: childName.trim(), pin });
    if (!value.bootstrap.account?.pending || !value.recoveryCode) throw new Error('注册结果暂未确认，请刷新查看。');
    if (mounted.current) { clearSecrets(); setContactPhone(''); setChildName(''); setRecovery(value.recoveryCode); setPending(value.bootstrap); }
   } else {
    const value = await post<Bootstrap>(kind === 'join' ? '/account/guardian/join' : '/account/logout', kind === 'join' ? { code: code.trim() } : {});
    if (mounted.current) { setCode(''); await onComplete(value); }
   }
  } catch (err) { if (mounted.current) { clearSecrets(); setError(messageOf(err)); if (kind === 'register' && (!(err instanceof ApiError) || err.status >= 500)) setUncertain(true); } }
  finally { locked.current = false; if (mounted.current) setBusy(false); }
 };
 return <main className="account-onboarding"><section className="setup-card">
  {!recovery ? <div className="account-welcome"><Avatar view="portrait"/><div><span>宝妍在这里</span><p>先请家长帮忙准备一下，我们就能聊啦。</p></div></div> : null}
  <span className="eyebrow">宝妍 · 陪伴从这里开始</span><h1>{recovery ? '保存账号恢复码' : data.account?.signedIn ? '准备自己的家庭' : '先注册宝妍账号'}</h1>
  {recovery ? <><p>恢复码只显示这一次，用于忘记密码时找回账号。</p><div className="account-recovery-result"><code>{recovery}</code><label className="check-row"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}/><span>我已妥善保存恢复码</span></label><button className="button primary full" disabled={!saved || busy} onClick={() => { if (pending) { setRecovery(''); void onComplete(pending); } }}>继续设置</button></div></> : data.account?.signedIn ? <>
   <p className="helper">已登录 {data.account.username}。小朋友姓名：{data.account.childName ?? '已登记'}。账号PIN已经设置。</p>
   <form className="account-form" onSubmit={e => { e.preventDefault(); void run('join'); }}><label className="field">家庭关联码 <span>选填</span><input value={code} maxLength={43} placeholder="没有关联码，直接继续" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} onChange={e => setCode(e.target.value)}/></label><p className="helper">留空会创建自己的家庭。有现有家庭的关联码，才填写并加入；关联后可管理该家庭资料。</p><button className="button primary full" disabled={busy || (!!code.trim() && !/^[A-Za-z0-9_-]{43}$/.test(code.trim()))}>{busy ? '正在关联…' : code.trim() ? '关联成为家长' : '继续，创建自己的家庭'}</button></form><button className="account-link" disabled={busy} onClick={() => void run('logout')}>退出这个账号</button>
  </> : <form className="account-form" onSubmit={e => { e.preventDefault(); void run('register'); }}>
   <p className="helper">填写账号、电话、小朋友姓名与PIN；注册后再设置年龄和陪伴时间。</p>
   <label className="field">用户名<input required value={username} maxLength={32} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy || uncertain} onChange={e => setUsername(e.target.value)}/><small>3–32位字母、数字、下划线、点或短横线。</small></label>
   <label className="field">设置账号密码<input required type="password" value={password} minLength={8} maxLength={128} autoComplete="new-password" disabled={busy || uncertain} onChange={e => setPassword(e.target.value)}/><small>至少8位，无需混合字母、数字或符号。</small></label>
   <label className="field">再次输入密码<input required type="password" value={again} maxLength={128} autoComplete="new-password" disabled={busy || uncertain} onChange={e => setAgain(e.target.value)}/></label>
   <RegistrationFields childName={childName} onChildName={setChildName} phone={contactPhone} onPhone={setContactPhone} pin={pin} onPin={setPin} pinAgain={pinAgain} onPinAgain={setPinAgain} disabled={busy || uncertain}/>
   <button className="button primary full" disabled={busy || uncertain}>{busy ? '正在注册…' : '注册账号'}</button><button type="button" className="account-link" disabled={busy} onClick={onLogin}>{uncertain ? '注册结果待确认，尝试登录或刷新' : '已有账号？登录'}</button>
  </form>}{error ? <p className="error-note" role="alert">{error}</p> : null}
 </section></main>;
}
