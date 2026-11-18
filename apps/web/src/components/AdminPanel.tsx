import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Check, Clipboard, FlaskConical, History, LayoutDashboard, LockKeyhole, LogOut, MessageSquareWarning, RefreshCw, Search, ShieldCheck, Users, House, X } from 'lucide-react';
import { ApiError, messageOf, responseApiError } from '../lib/api';
import { accountRecoveryUrl, adminGet, adminListQuery, adminPost, adminTime, parseAdminLaunch, type AdminAccount, type AdminAudit, type AdminFamily, type AdminFeedback, type AdminFeedbackDetail, type AdminOverview, type AdminPage, type AdminSession, type FeedbackStatus } from '../lib/admin';
import { DebugRoom } from './DebugRoom';
import './AdminPanel.css';

type Tab = 'overview' | 'accounts' | 'families' | 'feedback' | 'audit';
const titles: Record<Tab, string> = { overview: '运行概况', accounts: '账号管理', families: '家庭管理', feedback: '问题反馈', audit: '操作记录' };
const statusNames: Record<string, string> = { active: '正常', disabled: '已停用', paused: '已暂停', open: '待处理', in_progress: '处理中', resolved: '已处理' };
const actionNames: Record<string, string> = { 'bootstrap-issued':'生成开通链接', 'administrator-created':'开通管理员', login:'管理员登录', logout:'管理员退出', 'password-changed':'修改管理密码', 'account-disabled':'停用账号', 'account-restored':'恢复账号', 'family-paused':'暂停家庭服务', 'family-restored':'恢复家庭服务', 'recovery-issued':'生成账号恢复链接', 'recovery-completed':'账号完成密码重设', 'feedback.view':'查看反馈', 'feedback.audio':'读取反馈语音', 'feedback.triage':'更新反馈处理状态', 'admin.bootstrap': '开通管理员', 'admin.login': '管理员登录', 'admin.logout': '管理员退出', 'admin.password': '修改管理密码', 'account.status': '调整账号状态', 'family.status': '调整家庭状态', 'account.recovery': '生成账号恢复链接', 'account.recover': '完成账号密码重设', 'feedback.status': '更新反馈处理状态', 'feedback.read': '查看反馈', 'feedback.play': '收听反馈语音' };
const icons = { overview: LayoutDashboard, accounts: Users, families: House, feedback: MessageSquareWarning, audit: History };
const pageSize = 20;

export function AdminPanel() {
  const [launch, setLaunch] = useState(() => parseAdminLaunch(window.location.hash));
  const [invalidLaunch] = useState(() => !!window.location.hash && !parseAdminLaunch(window.location.hash));
  const [session, setSession] = useState<AdminSession | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  const [debug, setDebug] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  // Clear setup/recovery fragments before any network requests or other surfaces mount.
  useLayoutEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); }, []);
  useEffect(() => {
    if (launch?.kind === 'recover') return;
    const controller = new AbortController(); setError('');
    adminGet<AdminSession>('/session', controller.signal).then(value => { if (!controller.signal.aborted) { setSession(value); if (value.initialized && launch?.kind === 'setup') { setLaunch(null); setError('后台已开通，请使用管理员账号登录。'); } } }).catch(cause => { if (!controller.signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [loadKey, launch?.kind]);
  const expired = useCallback((text = '管理登录已过期，请重新登录。') => { setSession(value => value ? { ...value, authenticated: false, admin: undefined, expiresAt: undefined } : null); setDebug(false); setChangePassword(false); setNotice(''); setError(text); }, []);
  useEffect(() => {
    if (!session?.authenticated || !session.expiresAt) return;
    const expiry = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiry)) { expired(); return; }
    const check = () => { if (Date.now() >= expiry) expired(); };
    const timer = window.setTimeout(check, Math.max(0, Math.min(expiry - Date.now(), 2147483647)));
    document.addEventListener('visibilitychange', check);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', check); };
  }, [session?.authenticated, session?.expiresAt, expired]);
  const fail = useCallback((cause: unknown) => { if (cause instanceof ApiError && cause.status === 401) expired(); else setError(messageOf(cause)); }, [expired]);
  const logout = async () => { setBusy(true); setError(''); try { await adminPost('/logout'); expired(''); } catch (cause) { fail(cause); } finally { setBusy(false); } };
  const authenticate = async (username: string, password: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await adminPost(launch?.kind === 'setup' && !session?.initialized ? '/bootstrap' : '/login', launch?.kind === 'setup' && !session?.initialized ? { token: launch.token, username, password } : { username, password });
      setLaunch(null); const value = await adminGet<AdminSession>('/session'); setSession(value);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  const recover = async (_username: string, password: string) => {
    if (launch?.kind !== 'recover') return; setBusy(true); setError('');
    try { await adminPost('/recover', { token: launch.token, newPassword: password }); setLaunch(null); setNotice('账号密码已更新。请回到宝妍，用你的账号和新密码登录。'); setSession({ initialized: true, authenticated: false }); }
    catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  if (debug && session?.authenticated) return <DebugRoom onClose={() => { setDebug(false); setLoadKey(value => value + 1); }}/>;
  const recovery = launch?.kind === 'recover';
  return <div className="admin-shell"><header className="admin-top"><div className="admin-brand"><ShieldCheck size={26}/><div><h1>宝妍运营管理</h1><p>账号、家庭和问题处理，集中在这里</p></div></div><div className="admin-top-actions">{session?.authenticated ? <><span>{session.admin?.username}</span><button className="admin-button" disabled={busy} onClick={() => setChangePassword(true)}><LockKeyhole size={16}/>改密码</button><button className="admin-button" disabled={busy} onClick={() => void logout()}><LogOut size={16}/>退出</button></> : null}<a className="admin-button" href="/"><ArrowLeft size={16}/>回到宝妍</a></div></header>
    {session?.authenticated && !recovery ? <><div className="admin-main" style={{ maxWidth: 1240, margin: 'auto' }}>{error ? <div role="alert" className="admin-alert">{error}</div> : null}{notice ? <div role="status" className="admin-notice">{notice}</div> : null}</div><AdminWorkspace onExpire={expired} onDebug={() => setDebug(true)}/></> : <main className="admin-auth"><section className="admin-card">{recovery ? <><h2>重新设置账号密码</h2><p className="admin-help">这是宝妍账号的专属恢复入口，设置后使用新密码登录。链接只能使用一次。</p><AccessForm kind="recover" busy={busy} onSubmit={recover}/></> : !session ? <>{error ? <button className="admin-button" onClick={() => setLoadKey(value => value + 1)}><RefreshCw size={17}/>重新连接</button> : <div role="status" className="admin-loading">正在连接管理入口…</div>}</> : launch?.kind === 'setup' && !session.initialized ? <><h2>开通运营管理员</h2><p className="admin-help">设置独立的管理员账号。它与家长账号、内测调试密码分开使用。</p><AccessForm kind="setup" busy={busy} onSubmit={authenticate}/></> : !session.initialized ? <><h2>等待管理员开通</h2><p className="admin-help">请使用管理员专属开通链接进入，再设置管理账号。普通宝妍账号不能开通后台。</p></> : notice ? <><h2>密码已更新</h2><a className="admin-button primary" href="/">回到宝妍登录</a></> : <><h2>管理员登录</h2><p className="admin-help">使用运营管理员账号。家长账号和内测密码不适用于这里。</p><AccessForm kind="login" busy={busy} onSubmit={authenticate}/></>}{invalidLaunch ? <p className="admin-alert" role="alert">专属链接格式不完整，请重新打开完整链接。</p> : null}{error ? <p className="admin-alert" role="alert">{error}</p> : null}{notice ? <p className="admin-notice" role="status">{notice}</p> : null}</section></main>}
    <footer className="admin-bottom">此处只用于运营管理。家庭聊天与记忆正文不在后台展示。</footer>
    {changePassword && session?.authenticated ? <PasswordDialog onClose={() => setChangePassword(false)} onExpired={expired}/> : null}
  </div>;
}

function AccessForm({ kind, busy, onSubmit }: { kind: 'login' | 'setup' | 'recover'; busy: boolean; onSubmit: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [again, setAgain] = useState(''), [error, setError] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); if (busy) return; setError(''); if (kind !== 'login' && password !== again) { setError('两次密码不一样，请再确认一下。'); return; } await onSubmit(username.trim(), password); setPassword(''); setAgain(''); };
  return <form className="admin-form" onSubmit={event => void submit(event)}>{kind !== 'recover' ? <label>管理员账号<input autoComplete="username" value={username} maxLength={32} minLength={3} pattern="[A-Za-z0-9_.\-]+" required disabled={busy} onChange={event => setUsername(event.target.value)}/>{kind === 'setup' ? <small className="admin-help">3–32 位，可用字母、数字、下划线、短横线或点。</small> : null}</label> : null}<label>{kind === 'recover' ? '设置新密码' : '密码'}<input type="password" autoComplete={kind === 'login' ? 'current-password' : 'new-password'} minLength={kind === 'login' ? undefined : 8} maxLength={128} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)}/>{kind !== 'login' ? <small className="admin-help">至少 8 位，不要求混合大小写或特殊符号。</small> : null}</label>{kind !== 'login' ? <label>再输入一次密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required disabled={busy} value={again} onChange={event => setAgain(event.target.value)}/></label> : null}{error ? <p role="alert" className="admin-alert">{error}</p> : null}<button className="admin-button primary" disabled={busy} type="submit">{busy ? '正在确认…' : kind === 'login' ? '登录管理后台' : kind === 'setup' ? '开通管理员' : '保存新密码'}</button></form>;
}

function AdminDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><div className="admin-dialog-head"><h2>{title}</h2><button className="admin-button link" type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}

function PasswordDialog({ onClose, onExpired }: { onClose: () => void; onExpired: (message?: string) => void }) {
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [old, setOld] = useState(''), [password, setPassword] = useState(''), [again, setAgain] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (busy) return; if (password !== again) { setError('两次新密码不一样。'); return; } setBusy(true); setError(''); try { await adminPost('/password', { password: old, newPassword: password }); if (!alive.current) return; onExpired('管理密码已更新，请使用新密码重新登录。'); } catch (cause) { if (!alive.current) return; if (cause instanceof ApiError && cause.status === 401) onExpired(); else setError(messageOf(cause)); } finally { setBusy(false); setOld(''); setPassword(''); setAgain(''); } };
  return <AdminDialog title="修改管理密码" onClose={onClose} busy={busy}><p className="admin-help">保存后会退出管理会话，再用新密码登录。</p><form className="admin-form" onSubmit={event => void submit(event)}><label>当前密码<input type="password" autoComplete="current-password" required disabled={busy} value={old} onChange={event => setOld(event.target.value)}/></label><label>新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={password} onChange={event => setPassword(event.target.value)}/></label><label>再输入新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={again} onChange={event => setAgain(event.target.value)}/></label>{error ? <p role="alert" className="admin-alert">{error}</p> : null}<button type="submit" className="admin-button primary" disabled={busy}>{busy ? '保存中…' : '保存并重新登录'}</button></form></AdminDialog>;
}

type ActionTarget = { type: 'account'; item: AdminAccount; recovery?: boolean } | { type: 'family'; item: AdminFamily } | { type: 'feedback'; item: AdminFeedback; status: FeedbackStatus };
function AdminWorkspace({ onExpire, onDebug }: { onExpire: (message?: string) => void; onDebug: () => void }) {
  const [tab, setTab] = useState<Tab>('overview'), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [status, setStatus] = useState(''), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [overview, setOverview] = useState<AdminOverview | null>(null), [page, setPage] = useState<AdminPage<AdminAccount | AdminFamily | AdminFeedback | AdminAudit> | null>(null);
  const [action, setAction] = useState<ActionTarget | null>(null), [report, setReport] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ url: string; expiresAt: string; username: string } | null>(null);
  const refreshNow = () => { setRefresh(value => value + 1); };
  const failure = useCallback((cause: unknown) => { if (cause instanceof ApiError && cause.status === 401) onExpire(); else setError(messageOf(cause)); }, [onExpire]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setPage(null); setOverview(null);
    const path = tab === 'overview' ? '/overview' : `/${tab}?${adminListQuery(offset, search, status, pageSize)}`;
    adminGet<AdminOverview | AdminPage<AdminAccount | AdminFamily | AdminFeedback | AdminAudit>>(path, controller.signal).then(value => { if (controller.signal.aborted) return; if (tab === 'overview') setOverview(value as AdminOverview); else { const nextPage = value as AdminPage<AdminAccount | AdminFamily | AdminFeedback | AdminAudit>; if (!nextPage.items.length && offset > 0) setOffset(Math.max(0, Math.floor((nextPage.total - 1) / pageSize) * pageSize)); else setPage(nextPage); } }).catch(cause => { if (!controller.signal.aborted) failure(cause); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tab, search, status, offset, refresh, failure]);
  const chooseTab = (next: Tab) => { if (next === tab) refreshNow(); setPage(null); setOverview(null); setLoading(true); setTab(next); setQuery(''); setSearch(''); setStatus(''); setOffset(0); setNotice(''); setAction(null); setReport(null); setRecovery(null); };
  const result = (target: ActionTarget, response: { token?: string; expiresAt?: string }) => {
    setAction(null); if (target.type === 'account' && target.recovery && response.token && response.expiresAt) setRecovery({ url: accountRecoveryUrl(window.location.origin, response.token), expiresAt: response.expiresAt, username: target.item.username });
    else setNotice(target.type === 'feedback' ? '处理状态已更新。此操作不会自动通知反馈人。' : '操作已完成，列表已更新。');
    refreshNow();
  };
  return <div className="admin-layout"><nav className="admin-nav" aria-label="运营管理栏目">{(Object.keys(titles) as Tab[]).map(value => { const Icon = icons[value]; return <button key={value} type="button" aria-current={tab === value ? 'page' : undefined} onClick={() => chooseTab(value)}><Icon size={19}/>{titles[value]}</button>; })}</nav><main className="admin-main"><section className="admin-card"><div className="admin-heading"><div><h2>{titles[tab]}</h2><p className="admin-help">{tab === 'overview' ? '了解当前服务与使用情况' : tab === 'accounts' ? '查看账号状态，协助用户恢复登录' : tab === 'families' ? '按孩子昵称找到家庭，查看各账号的自填联系方式' : tab === 'feedback' ? '处理用户主动提交的文字和语音问题' : '每次管理操作都有据可查'}</p></div><button className="admin-button" type="button" disabled={loading} onClick={refreshNow} aria-label="刷新当前栏目"><RefreshCw size={17}/>刷新</button></div>
    {tab !== 'overview' && tab !== 'audit' ? <form className="admin-toolbar" onSubmit={event => { event.preventDefault(); setOffset(0); setSearch(query); }}><input aria-label={tab === 'feedback' ? '搜索反馈编号' : tab === 'accounts' ? '账号名、手机号或账号编号' : '孩子昵称、账号、手机号或家庭编号'} placeholder={tab === 'feedback' ? '反馈编号' : tab === 'accounts' ? '账号名、手机号或账号编号' : '孩子昵称、账号、手机号或家庭编号'} value={query} maxLength={64} onChange={event => setQuery(event.target.value)}/><select aria-label="按状态筛选" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="">全部状态</option>{(tab === 'accounts' ? ['active', 'disabled'] : tab === 'families' ? ['active', 'paused'] : ['open', 'in_progress', 'resolved']).map(value => <option key={value} value={value}>{statusNames[value]}</option>)}</select><button className="admin-button" type="submit"><Search size={17}/>查找</button></form> : null}
    {error ? <div className="admin-alert" role="alert">{error}</div> : null}{notice ? <div className="admin-notice" role="status">{notice}</div> : null}
    {loading ? <div className="admin-loading" role="status">正在读取…</div> : overview && tab === 'overview' ? <Overview value={overview} onFeedback={() => chooseTab('feedback')} onDebug={onDebug}/> : page ? <><div className="admin-row-list">{page.items.length === 0 ? <p className="admin-empty">{search || status ? '没有符合条件的记录，可以换个条件查找。' : '这里暂时还没有记录。'}</p> : tab === 'accounts' ? (page.items as AdminAccount[]).map(item => (
      <AdminAccountCard key={item.id} item={item} onRecovery={() => setAction({ type: 'account', item, recovery: true })} onStatus={() => setAction({ type: 'account', item })}/>
    )) : tab === 'families' ? (page.items as AdminFamily[]).map(item => (
      <AdminFamilyCard key={item.id} item={item} onStatus={() => setAction({ type: 'family', item })}/>
    )) : tab === 'feedback' ? (page.items as AdminFeedback[]).map(item => <article className="admin-row" key={item.id}><div className="admin-row-info"><strong>{item.hasText && item.hasAudio ? '文字与语音反馈' : item.hasAudio ? '语音反馈' : '文字反馈'}</strong><Badge status={item.status}/><p className="admin-id">{item.id}</p><p>{adminTime(item.createdAt)} · {pageLabel(item.context.page)}</p></div><button className="admin-button" onClick={() => setReport(item.id)}>查看并处理</button></article>) : (page.items as AdminAudit[]).map(item => <article key={item.id} className="admin-audit"><strong>{actionNames[item.action] || item.action}</strong><p>{item.actor || '系统'} · {adminTime(item.at)}</p><small>{{ account: '账号', family: '家庭', feedback: '反馈', admin: '管理员', system: '系统' }[item.targetType] ?? item.targetType} · {item.targetId || '—'}</small>{item.reason ? <p className="admin-reason">{item.reason}</p> : null}</article>)}</div><div className="admin-pagination"><span>共 {page.total} 条{page.total > 0 ? ` · ${offset + 1}–${Math.min(offset + page.items.length, page.total)}` : ''}</span><div><button className="admin-button" disabled={offset <= 0 || loading} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>上一页</button><button className="admin-button" disabled={offset + pageSize >= page.total || loading} onClick={() => setOffset(value => value + pageSize)}>下一页</button></div></div></> : null}
    </section></main>{action ? <ActionDialog target={action} onClose={() => setAction(null)} onExpired={onExpire} onChanged={result} onStale={() => { setAction(null); setReport(null); setNotice('资料已被更新，请在刷新后的列表重新核对再操作。'); refreshNow(); }}/> : null}{report && !action ? <FeedbackDialog id={report} onClose={() => setReport(null)} onExpired={onExpire} onAction={(item, next) => setAction({ type: 'feedback', item, status: next })}/> : null}{recovery ? <RecoveryReceipt value={recovery} onClose={() => setRecovery(null)}/> : null}</div>;
}

export function AdminAccountCard({ item, onRecovery, onStatus }: {
  item: AdminAccount; onRecovery: () => void; onStatus: () => void;
}) {
  return <article className="admin-row admin-account-row">
    <div className="admin-row-info">
      <strong>{item.username}</strong><Badge status={item.status}/>
      <p className="admin-family-name">{item.familyName || '尚未加入家庭'}</p>
      {item.childNames.length > 1 ? <p>孩子：{item.childNames.join('、')}</p> : null}
      <p className="admin-contact-phone">联系电话：<span>{item.contactPhone || '未填写'}</span>{item.contactPhone ? <small>自填 · 未验证</small> : null}</p>
      <p>{item.guardian ? '关联家长' : item.familyId ? '家庭创建者' : '未关联'} · {item.deviceCount} 台设备</p>
      <p className="admin-id">账号编号：{item.id}{item.familyId ? <><br/>家庭编号：{item.familyId}</> : null}</p>
      <p>注册于 {adminTime(item.createdAt)}</p>
    </div>
    <div className="admin-row-actions">
      <button className="admin-button" disabled={item.status === 'disabled'} title={item.status === 'disabled' ? '请先恢复账号，再协助找回' : undefined} onClick={onRecovery}>协助找回</button>
      <button className={`admin-button ${item.status === 'active' ? 'danger' : ''}`} onClick={onStatus}>{item.status === 'active' ? '停用' : '恢复使用'}</button>
    </div>
  </article>;
}

export function AdminFamilyCard({ item, onStatus }: { item: AdminFamily; onStatus: () => void }) {
  return <article className="admin-row admin-family-row">
    <div className="admin-row-info">
      <strong>{item.displayName}</strong><Badge status={item.status}/>
      {item.childNames.length ? <p>孩子：{item.childNames.join('、')}</p> : <p>尚未设置孩子昵称</p>}
      <div className="admin-family-contacts" aria-label="家庭账号联系方式">
        {item.contacts.length ? item.contacts.map(contact => (
          <div className="admin-family-contact" key={contact.accountId}>
            <div><b>{contact.username}</b><small>{contact.guardian ? '关联家长' : '家庭创建者'}</small></div>
            <span className="admin-contact-number">{contact.contactPhone || '未填写手机号'}</span>
          </div>
        )) : <p>暂无已绑定账号，未填写手机号。</p>}
        {item.contacts.some(contact => contact.contactPhone) ? <p className="admin-contact-disclaimer">联系方式由账号本人填写，未经短信验证。</p> : null}
      </div>
      <p>{item.accountCount} 个账号 · {item.memberCount} 位已登记家人 · {item.deviceCount} 台设备</p>
      <p className="admin-id">家庭编号：{item.id}</p>
    </div>
    <button className={`admin-button ${item.status === 'active' ? 'danger' : ''}`} onClick={onStatus}>{item.status === 'active' ? '暂停家庭服务' : '恢复家庭服务'}</button>
  </article>;
}

function Badge({ status }: { status: string }) { return <span className={`admin-badge ${status}`}>{statusNames[status] || status}</span>; }
const pageLabel = (page?: string) => ({ setup: '首次设置', home: '首页', call: '聊天中', parent: '家长管理', connection: '连接页面', expired: '内测结束页面' }[page ?? ''] ?? '未记录页面');

function Overview({ value, onFeedback, onDebug }: { value: AdminOverview; onFeedback: () => void; onDebug: () => void }) {
  const service = value.service, budget = service.providerDayBudget;
  const stageNames: Record<string, string> = { asr: '语音识别', chat: '回复生成', tts: '语音合成', 'audio-understanding': '原音理解', unclassified: '其他阶段' };
  const duration = (milliseconds: number | null) => milliseconds === null ? '暂无样本' : `${(milliseconds / 1000).toFixed(1)} 秒`;
  return <><div className="admin-stats"><div className="admin-stat"><span>注册账号</span><strong>{value.accounts.total}</strong><small>{value.accounts.disabled} 个已停用</small></div><div className="admin-stat"><span>家庭</span><strong>{value.families.total}</strong><small>{value.families.paused} 个已暂停</small></div><div className="admin-stat"><span>当前聊天</span><strong>{value.activeCalls}</strong><small>{value.activeDevices} 台已授权设备</small></div><div className="admin-stat"><span>待处理反馈</span><strong>{service.feedback.open}</strong><small>{service.feedback.in_progress} 条处理中</small></div><div className="admin-stat"><span>今日模型调用</span><strong>{budget.calls ?? '—'}</strong><small>包括失败的尝试次数</small></div><div className="admin-stat"><span>今日剩余调用</span><strong>{budget.remaining ?? '—'}</strong><small>{budget.dailyBudget ? `每日上限 ${budget.dailyBudget} 次` : '未配置统计上限'}</small></div></div><section><h3>常用工作</h3><div className="admin-links"><button className="admin-button" onClick={onFeedback}><MessageSquareWarning size={17}/>处理问题反馈</button><button className="admin-button" onClick={onDebug}><FlaskConical size={17}/>进入内测调试</button></div><p className="admin-help">调试入口仍需独立调试密码，调整仅用于原有范围，不会全站发布。</p></section><section className="admin-service"><h3>近 {service.windowDays} 日回复与声音</h3><p className="admin-help">按每个处理环节分别统计，包含失败请求的耗时，不等于一整轮聊天的等待。</p><div className="admin-row-list">{service.providerStages.stages.filter(item => item.attempts > 0).map(item => <div className="admin-row" key={item.stage}><div className="admin-row-info"><strong>{stageNames[item.stage] || '其他阶段'}</strong><p>{item.attempts} 次尝试 · {item.failed} 次失败 · 成功率 {item.successRate === null ? '暂无' : `${Math.round(item.successRate * 100)}%`}</p></div><div><span>多数请求：{duration(item.p50Ms)}</span><p className="admin-help">95% 请求在 {duration(item.p95Ms)} 内返回</p></div></div>)}{!service.providerStages.stages.some(item => item.attempts > 0) ? <p className="admin-empty">这段时间暂时没有调用样本。</p> : null}</div><p className="admin-help">浏览器首声等待：{duration(service.clientFirstAudio.p50Ms)}（中位数，共 {service.clientFirstAudio.attempts} 个前端回传样本）。当前没有费用计量，请在服务商账单查看实际费用。</p></section><dl className="admin-definition"><dt>回复模型</dt><dd>{value.models.reply}</dd>{value.trial?.enabled ? <><dt>内测截止</dt><dd>{adminTime(value.trial.expiresAt)}</dd></> : null}<dt>管理账号数</dt><dd>{value.admins}</dd><dt>后台开通时间</dt><dd>{adminTime(value.initializedAt)}</dd><dt>统计时间</dt><dd>{adminTime(service.checkedAt)}（北京时间）</dd></dl></>;
}

function ActionDialog({ target, onClose, onChanged, onStale, onExpired }: { target: ActionTarget; onClose: () => void; onChanged: (target: ActionTarget, response: { token?: string; expiresAt?: string }) => void; onStale: () => void; onExpired: (message?: string) => void }) {
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const recovering = target.type === 'account' && target.recovery;
  const next = target.type === 'feedback' ? target.status : target.type === 'account' ? target.item.status === 'active' ? 'disabled' : 'active' : target.item.status === 'active' ? 'paused' : 'active';
  const title = recovering ? '协助找回账号' : target.type === 'feedback' ? `标记为${statusNames[next]}` : target.type === 'account' ? next === 'disabled' ? '停用账号' : '恢复账号使用' : next === 'paused' ? '暂停家庭服务' : '恢复家庭服务';
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !confirmed || !reason.trim()) return; setBusy(true); setError('');
    const group = target.type === 'account' ? 'accounts' : target.type === 'family' ? 'families' : 'feedback';
    try { const response = await adminPost<{ token?: string; expiresAt?: string }>(`/${group}/${encodeURIComponent(target.item.id)}/${recovering ? 'recovery' : 'status'}`, { revision: target.item.revision, ...(recovering ? {} : { status: next }), reason: reason.trim(), confirm: true }); if (alive.current) onChanged(target, response); }
    catch (cause) { if (!alive.current) return; if (cause instanceof ApiError && cause.status === 401) onExpired(); else if (cause instanceof ApiError && cause.status === 409) onStale(); else setError(cause instanceof ApiError && cause.status < 500 ? messageOf(cause) : '暂时无法确认操作结果。请关闭此窗口并刷新列表核对，不要立即重复提交。'); }
    finally { setBusy(false); }
  };
  return <AdminDialog title={title} busy={busy} onClose={onClose}>{target.type === 'family' ? <p><strong>{target.item.displayName}</strong></p> : null}<p className="admin-id">{target.type === 'account' ? `${target.item.username} · ` : ''}{target.item.id}</p><p className="admin-help">{recovering ? '先通过你与用户原有的联系渠道核对身份。生成一次性恢复链接后，由用户本人设置新密码。重设后该账号需重新登录；若为家庭创建者，该家庭的设备都需重新登录或关联。' : target.type === 'feedback' ? '保存处理状态和备注。不会自动向反馈人发送通知。' : target.type === 'account' ? next === 'disabled' ? '该账号将不能继续登录或使用服务，已有会话会失效。家庭其他账号不因此停用。' : '恢复此账号的使用资格，用户需要重新登录。' : next === 'paused' ? '该家庭的聊天和管理访问将暂停，正在进行的聊天会停止。已有资料保留，运营恢复后才能继续访问。' : '该家庭可再次使用服务，原有资料保留。账号用户需要重新登录；原无账号访客可用原设备继续。'}</p><form className="admin-form" onSubmit={event => void submit(event)}><label>{target.type === 'feedback' ? '处理备注' : '操作原因'}<textarea required maxLength={target.type === 'feedback' ? 500 : 200} value={reason} disabled={busy} placeholder={target.type === 'feedback' ? '记录已排查的情况或处理方法' : '简短说明原因，不填写密码或私人聊天'} onChange={event => setReason(event.target.value)}/></label><label className="admin-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>{recovering ? '我已核对账号归属，会把链接交给账号本人' : '我已核对对象和这次操作的影响'}</span></label>{error ? <p className="admin-alert" role="alert">{error}</p> : null}<div className="admin-dialog-actions"><button type="button" className="admin-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="admin-button primary" disabled={busy || !confirmed || !reason.trim()}>{busy ? '提交中…' : recovering ? '生成恢复链接' : '确认操作'}</button></div></form></AdminDialog>;
}

function RecoveryReceipt({ value, onClose }: { value: { url: string; expiresAt: string; username: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const copy = async () => { try { await navigator.clipboard.writeText(value.url); setCopied(true); } catch { setError('自动复制没有成功，可长按下方链接手动复制。'); } };
  return <AdminDialog title="恢复链接已生成" onClose={onClose}><p>账号：<strong>{value.username}</strong></p><p className="admin-token-warning">请只交给账号本人，勿发到群聊。链接只能使用一次，有效至 {adminTime(value.expiresAt)}。</p><textarea className="admin-recovery-link" aria-label="账号专属恢复链接" readOnly value={value.url} onFocus={event => event.currentTarget.select()}/><p className="admin-help">此链接仅在当前窗口临时显示。关闭窗口后无法再次查看；再次生成将替换之前的链接。</p>{error ? <p role="alert" className="admin-alert">{error}</p> : null}<div className="admin-dialog-actions"><button className="admin-button" onClick={() => void copy()}>{copied ? <Check size={17}/> : <Clipboard size={17}/>} {copied ? '已复制' : '复制专属链接'}</button><button className="admin-button primary" onClick={onClose}>完成</button></div></AdminDialog>;
}

function FeedbackDialog({ id, onClose, onAction, onExpired }: { id: string; onClose: () => void; onAction: (item: AdminFeedback, status: FeedbackStatus) => void; onExpired: (message?: string) => void }) {
  const [detail, setDetail] = useState<AdminFeedbackDetail | null>(null), [error, setError] = useState(''), [audioUrl, setAudioUrl] = useState(''), [audioBusy, setAudioBusy] = useState(false);
  const audioRequest = useRef<AbortController | null>(null), currentAudio = useRef('');
  useEffect(() => { const controller = new AbortController(); adminGet<AdminFeedbackDetail>(`/feedback/${encodeURIComponent(id)}`, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(cause => { if (controller.signal.aborted) return; if (cause instanceof ApiError && cause.status === 401) onExpired(); else setError(messageOf(cause)); }); return () => { controller.abort(); audioRequest.current?.abort(); if (currentAudio.current) URL.revokeObjectURL(currentAudio.current); }; }, [id, onExpired]);
  const loadAudio = async () => {
    if (audioBusy || audioUrl) return; const controller = new AbortController(); audioRequest.current = controller; setAudioBusy(true); setError('');
    let timedOut = false; const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 35000);
    try { const response = await fetch(`/api/admin/feedback/${encodeURIComponent(id)}/audio`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); if (!response.ok) throw await responseApiError(response, '语音暂时无法打开。'); const blob = await response.blob(); if (controller.signal.aborted) return; if (blob.size > 1_100_000 || !/^audio\/(wav|wave|x-wav)(;|$)/i.test(blob.type)) throw new Error('语音格式不正确，未播放。'); currentAudio.current = URL.createObjectURL(blob); setAudioUrl(currentAudio.current); }
    catch (cause) { if (timedOut) setError('语音读取超时，请重新加载。'); else if (!controller.signal.aborted) { if (cause instanceof ApiError && cause.status === 401) onExpired(); else setError(messageOf(cause)); } }
    finally { window.clearTimeout(timeout); if (audioRequest.current === controller) { audioRequest.current = null; setAudioBusy(false); } }
  };
  return <AdminDialog title="查看问题反馈" onClose={onClose}>{error ? <p className="admin-alert" role="alert">{error}</p> : null}{!detail && !error ? <p role="status">正在读取反馈…</p> : detail ? <><p className="admin-id">{detail.id}</p><p>{adminTime(detail.createdAt)}<Badge status={detail.status}/></p><p className="admin-help">{pageLabel(detail.context.page)} · {detail.context.appVersion ? `版本 ${detail.context.appVersion}` : '未记录版本'}{detail.expiresAt ? ` · 保留至 ${adminTime(detail.expiresAt)}` : ''}</p>{detail.hasText ? <div className="admin-report-text">{detail.text}</div> : <p className="admin-help">用户没有提交文字说明。</p>}{detail.hasAudio ? audioUrl ? <audio controls preload="none" src={audioUrl}/> : <button className="admin-button" disabled={audioBusy} onClick={() => void loadAudio()}>{audioBusy ? '正在读取语音…' : '加载用户提交的语音'}</button> : null}<p className="admin-sensitive">这里只显示用户主动提交的问题，不读取家庭聊天或记忆。</p>{detail.note ? <><h3>最新处理备注</h3><div className="admin-report-text">{detail.note}</div></> : null}<div className="admin-links">{(['open', 'in_progress', 'resolved'] as FeedbackStatus[]).filter(value => value !== detail.status).map(value => <button key={value} className="admin-button" onClick={() => onAction(detail, value)}>{value === 'open' ? '重新打开' : `标记${statusNames[value]}`}</button>)}</div><p className="admin-help">标记已处理不会自动通知反馈人。</p>{detail.events.length ? <details><summary>查看处理记录（{detail.events.length}）</summary>{detail.events.map((item, index) => <div className="admin-audit" key={`${item.createdAt}-${index}`}><strong>{statusNames[item.previousStatus]} → {statusNames[item.status]}</strong><p>{item.reviewer} · {adminTime(item.createdAt)}</p><p className="admin-reason">{item.note}</p></div>)}</details> : null}</> : null}</AdminDialog>;
}
