import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, CalendarDays, Check, Globe2, Leaf, MessageCircle, Pencil, RefreshCw, Smile, Trash2 } from 'lucide-react';
import { ApiError, api, messageOf } from '../lib/api';
import type { Bootstrap, Child, Memory } from '../lib/types';
import './MemoryPanel.css';

const kindLabels: Record<string, string> = { preference: '小小偏好', event: '分享的小事', imaginary: '一起想象', plan: '以后想做' };
type AutoSummary = { state: 'idle' | 'pending' | 'saved' | 'empty' | 'failed' | 'cancelled' | 'skipped'; savedCount: number; updatedAt?: string };
type DailyRecord = { day: string; topics: string[]; concerns: string[]; concernState: 'expressed' | 'not-explicit'; moods?: string[]; moodState?: 'expressed' | 'not-explicit' | 'legacy-unavailable'; moodCoverage?: 'current-rules' | 'partial-history' | 'legacy-unavailable'; summary?: string; detailLevel?: 'semantic' | 'mixed' | 'basic'; semanticSessions?: number; turns: number; sessions: number; updatedAt: string; expiresAt: string };
type DailySummaries = { today: string; retentionDays: 30; classification: 'rules-v1' | 'rules-v2' | 'semantic-v3'; records: DailyRecord[] };
type MemoryResponse = { items: Memory[]; autoSummary?: AutoSummary; dailySummaries?: DailySummaries };
const sourceLabel = (source: string) => source.startsWith('聊天自动整理（') ? '聊天自动整理' : source === '家长修订' ? '家长修订' : source.startsWith('孩子明确请求并确认') ? '主动确认' : '已保存条目';
const dateTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间尚未取得';
const summaryMessage = (summary: AutoSummary) => ({
  idle: '尚未取得新的整理结果；符合记录范围的聊天在结束后整理。',
  pending: '正在补充今天的小结，并挑选值得留给以后聊天的小事。页面会自动刷新一小段时间。',
  saved: `最近一次整理保存了 ${summary.savedCount} 条专属记忆，当前有效条目见下方。`,
  empty: '本次没有新的长期条目；今天聊过的话题、心情和困扰请看上方小结。',
  failed: '详细整理未完成，已保存的简略小结和记忆仍保留。请刷新核对状态。',
  cancelled: '最近一次专属记忆整理已停止。已有记忆仍可管理，今日话题另见上方小结。',
  skipped: '最近一次整理没有新增长期条目，现有记忆保持；这不代表没有聊天。',
}[summary.state]);

export function MemoryPanel({ data, onChild, onBusyChange, preview = false, onOpenMemory }: { data: Bootstrap; onChild: (child: Child) => void; onBusyChange?: (busy: boolean) => void; preview?: boolean; onOpenMemory?: () => void }) {
  const childId = data.child?.id ?? '';
  const [items, setItems] = useState<Memory[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadedChild, setLoadedChild] = useState('');
  const [edit, setEdit] = useState('');
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState('');
  const [deletingDay, setDeletingDay] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [autoSummary, setAutoSummary] = useState<AutoSummary | null>(null);
  const [dailySummaries, setDailySummaries] = useState<DailySummaries | null>(null);
  const [pollStopped, setPollStopped] = useState(false);
  const [scopeRejected, setScopeRejected] = useState(false);
  const rejectedScope = useRef(false);
  const mounted = useRef(true);
  const activeChild = useRef(childId);
  activeChild.current = childId;
  const contextEpoch = useRef(0);
  const loadGeneration = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const poll = useRef({ key: '', attempts: 0 });
  const callbacks = useRef({ onChild, onBusyChange });
  callbacks.current = { onChild, onBusyChange };
  const abortRead = useCallback(() => { ++loadGeneration.current; readRequest.current?.abort(); readRequest.current = null; }, []);
  const rejectScope = useCallback((failure: ApiError) => {
    rejectedScope.current = true; ++contextEpoch.current; abortRead(); mutation.current?.abort(); mutation.current = null; busyRef.current = false;
    poll.current = { key: '', attempts: 12 };
    setItems([]); setDailySummaries(null); setAutoSummary(null); setLoadedChild(''); setHasLoaded(false);
    setEdit(''); setDraft(''); setDeleting(''); setDeletingDay(''); setNotice('');
    setLoading(false); setRefreshing(false); setBusy(false); setPollStopped(true); setScopeRejected(true);
    setError(failure.status === 409 ? '当前孩子资料已变化，旧记录已清除。请刷新孩子资料，重新打开小本后再查看。' : '家长授权已失效，旧记录已清除。请重新验证家长权限，再刷新小本。');
  }, [abortRead]);

  const refresh = useCallback(async (quiet = false) => {
    if (!childId || readRequest.current || document.hidden || (quiet && rejectedScope.current)) return;
    if (!quiet) { poll.current = { key: '', attempts: 0 }; setPollStopped(false); setLoading(true); }
    const controller = new AbortController(); readRequest.current = controller;
    const epoch = contextEpoch.current, generation = ++loadGeneration.current;
    const current = () => mounted.current && activeChild.current === childId && epoch === contextEpoch.current && generation === loadGeneration.current && !controller.signal.aborted;
    setRefreshing(true); setError('');
    try {
      const value = await api<MemoryResponse>('/parent/memories', { signal: controller.signal, headers: { 'X-Baoyan-Child': childId } });
      if (!current()) return;
      setItems(value.items); setAutoSummary(value.autoSummary ?? null); setDailySummaries(value.dailySummaries ?? null); setLoadedChild(childId); setHasLoaded(true);
      rejectedScope.current = false; setScopeRejected(false);
    } catch (failure) { if (current()) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403 || (failure.status === 409 && failure.code === 'CONTEXT_CHANGED'))) rejectScope(failure);
      else setError(messageOf(failure));
    } }
    finally { if (current()) { readRequest.current = null; setLoading(false); setRefreshing(false); } }
  }, [childId, rejectScope]);

  useEffect(() => {
    mounted.current = true; ++contextEpoch.current; abortRead(); mutation.current?.abort(); mutation.current = null; busyRef.current = false;
    poll.current = { key: '', attempts: 0 };
    rejectedScope.current = false; setScopeRejected(false);
    setItems([]); setAutoSummary(null); setDailySummaries(null); setHasLoaded(false); setLoadedChild(''); setLoading(true); setRefreshing(false); setBusy(false); setPollStopped(false);
    setEdit(''); setDraft(''); setDeleting(''); setDeletingDay(''); setNotice(''); setError('');
    void refresh();
    return () => { ++contextEpoch.current; abortRead(); mutation.current?.abort(); mutation.current = null; busyRef.current = false; };
  }, [childId, abortRead, refresh]);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); return () => callbacks.current.onBusyChange?.(false); }, [busy]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) { abortRead(); setRefreshing(false); setLoading(false); }
      else if (!rejectedScope.current) { poll.current = { key: '', attempts: 0 }; setPollStopped(false); void refresh(true); }
    };
    const offline = () => { abortRead(); mutation.current?.abort(); setRefreshing(false); setLoading(false); if (!rejectedScope.current) setError('网络已断开，请连接后刷新确认最新整理状态和操作结果。'); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('offline', offline);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('offline', offline); };
  }, [abortRead, refresh]);
  useEffect(() => {
    if (scopeRejected) return;
    if (autoSummary?.state !== 'pending' || !data.child?.memoryEnabled) { poll.current = { key: '', attempts: 0 }; setPollStopped(false); return; }
    const key = `${childId}:${autoSummary.updatedAt ?? 'pending'}`;
    if (poll.current.key !== key) { poll.current = { key, attempts: 0 }; setPollStopped(false); }
    if (busy || refreshing || loading || error || document.hidden) return;
    if (poll.current.attempts >= 12) { setPollStopped(true); return; }
    const timer = window.setTimeout(() => { ++poll.current.attempts; void refresh(true); }, 1500);
    return () => window.clearTimeout(timer);
  }, [autoSummary, data.child?.memoryEnabled, childId, busy, refreshing, loading, error, refresh, scopeRejected]);

  const mutate = async <T,>(path: string, method: 'PATCH' | 'DELETE', body: unknown, success: (value: T) => void) => {
    if (busyRef.current || !childId || rejectedScope.current || !hasLoaded || loadedChild !== childId || activeChild.current !== childId) return;
    busyRef.current = true; abortRead(); setLoading(false); setRefreshing(false); setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); mutation.current = controller; const epoch = contextEpoch.current;
    const current = () => mounted.current && activeChild.current === childId && epoch === contextEpoch.current && mutation.current === controller;
    try {
      const value = await api<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, headers: { 'X-Baoyan-Child': childId } });
      if (current() && !controller.signal.aborted) success(value);
    } catch (failure) { if (current()) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403 || (failure.status === 409 && failure.code === 'CONTEXT_CHANGED'))) rejectScope(failure);
      else setError(controller.signal.aborted ? '操作结果暂时无法确认，请刷新查看，避免重复提交。' : messageOf(failure));
    } }
    finally { if (current()) { mutation.current = null; busyRef.current = false; setBusy(false); } }
  };
  const toggle = () => mutate<Child>('/parent/settings', 'PATCH', { memoryEnabled: !data.child?.memoryEnabled }, child => {
    callbacks.current.onChild(child);
    setNotice(child.memoryEnabled ? '已开启新的今日小结和专属记忆整理；正常聊天结束后更新。' : '已关闭新的小结与记忆整理，已有记录仍保留，可查看或删除。');
    void refresh(true);
  });
  const save = (id: string) => mutate<Memory>(`/parent/memories/${id}`, 'PATCH', { content: draft.trim() }, value => {
    setItems(rows => rows.map(row => row.id === id ? value : row)); setEdit(''); setNotice('记忆已更新。有效期内，家长修改优先，自动整理不会覆盖。');
  });
  const erase = (id: string) => mutate<{ ok: true }>(`/parent/memories/${id}`, 'DELETE', undefined, () => {
    setItems(rows => rows.filter(row => row.id !== id)); setDeleting(''); setNotice('专属记忆已删除，30天内不会自动恢复同一条；仍可主动请求并确认重新保存。');
  });
  const eraseDay = (day: string) => mutate<{ dailySummaries: DailySummaries }>(`/parent/chat-summaries/${day}`, 'DELETE', undefined, value => {
    setDailySummaries(value.dailySummaries); setDeletingDay(''); setNotice('这一天的小结已删除，不影响专属记忆；以后新的聊天仍按当前开关整理。');
  });

  const summaryStatus = scopeRejected ? '需要重新验证家长权限或刷新孩子资料，才能查看整理状态。' : error ? '当前整理状态暂时无法确认，请刷新后再判断是否完成。'
    : !hasLoaded || !autoSummary ? '尚未取得整理状态，请稍后刷新。'
    : !data.child?.memoryEnabled ? '已关闭新的整理，已有记录仍保留。'
    : summaryMessage(autoSummary);
  const emptyTitle = error ? '暂时无法确认专属记忆'
    : !hasLoaded || !autoSummary ? '尚未取得小本状态'
    : !data.child?.memoryEnabled ? '暂无已保留的专属记忆'
    : autoSummary.state === 'pending' ? '正在整理专属记忆'
    : autoSummary.state === 'failed' ? '这次整理未完成'
    : autoSummary.state === 'cancelled' ? '这次整理已停止'
    : autoSummary.state === 'empty' || autoSummary.state === 'skipped' ? '本次没有新增长期条目'
    : '当前没有有效的专属记忆';
  const scopeReady = !scopeRejected && hasLoaded && !!childId && loadedChild === childId;
  const today = scopeReady ? dailySummaries?.records.find(record => record.day === dailySummaries.today) : undefined;
  const history = scopeReady ? dailySummaries?.records.filter(record => record.day !== dailySummaries.today) ?? [] : [];
  const visible = scopeReady ? items : [];
  const blockingLoad = (loading && !hasLoaded) || (!scopeReady && !error);
  const detailMessage = (record: DailyRecord, isToday: boolean) => isToday && autoSummary?.state === 'pending' && data.child?.memoryEnabled
    ? '已有简略小结，正在补充具体话题…'
    : record.detailLevel === 'semantic' ? '已补充聊天内容'
    : record.detailLevel === 'mixed' ? '部分内容已细化，其余保留简略小结'
    : '简略小结 · 详细整理暂未完成或为旧记录';
  const dailyCard = (record: DailyRecord, isToday: boolean) => <article className="memory-daily-card" key={record.day}>
    <div className="memory-daily-heading"><strong><CalendarDays size={17}/>{isToday ? '今天' : record.day}</strong><span>整理自 {record.sessions} 次聊天 · {record.turns} 条表达</span></div>
    <p className="memory-daily-detail" role="status">{detailMessage(record, isToday)}</p>
    <p className="memory-daily-overview">{record.summary || `这天聊到了${record.topics.join('、') || '一些日常话题'}。`}</p>
    <div className="memory-daily-topics"><h4>聊过的话题</h4><div className="memory-daily-tags">{record.topics.map(topic => <span key={topic}>{topic}</span>)}</div></div>
    <div className="memory-daily-moods"><h4><Smile size={16}/>聊天里提到的心情</h4>{record.moodState === 'expressed' && record.moods?.length ? <div className="memory-daily-tags moods">{record.moods.map(mood => <span key={mood}>{mood}</span>)}</div> : <p>{!record.moodState || record.moodState === 'legacy-unavailable' ? '这份旧小结没有整理心情，不能补猜当时的感受。' : '这份小结暂未记录到明确心情，先不猜。'}</p>}{record.moodCoverage === 'partial-history' ? <p className="memory-daily-coverage">仅整理了新聊天提到的心情，这天部分旧聊天没有心情记录。</p> : null}</div>
    <div className="memory-daily-concerns"><h4>明确提到的困扰</h4>{record.concernState === 'expressed' && record.concerns.length ? <div className="memory-daily-tags concerns">{record.concerns.map(concern => <span key={concern}>{concern}</span>)}</div> : <p>这份小结未记录到明确表达的困扰，不能据此判断没有困扰。</p>}</div>
    <p className="memory-daily-time">更新：{dateTime(record.updatedAt)} · 到期：{new Date(record.expiresAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
    {deletingDay === record.day ? <div className="memory-daily-delete"><p>删除 {record.day} 的小结？专属记忆不会一起删除。</p><div className="inline-actions"><button type="button" className="button danger small" disabled={busy || !scopeReady} onClick={() => void eraseDay(record.day)}>确认删除小结</button><button type="button" className="button ghost small" disabled={busy} onClick={() => setDeletingDay('')}>保留</button></div></div> : <button type="button" className="text-button" disabled={busy || refreshing || !scopeReady} onClick={() => { setDeletingDay(record.day); setDeleting(''); }}><Trash2 size={15}/>删除这天的小结</button>}
  </article>;


  if (preview) return <section className="memory-panel memory-overview-preview" aria-label="今日聊天小结">
    <div className="memory-section-heading"><h3><MessageCircle size={20}/>今日聊天小结</h3><button type="button" className="text-button" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={15}/>{refreshing ? '正在刷新…' : '刷新'}</button></div>
    {error ? <p className="error-note" role="alert">{error}{scopeReady ? ' 下方保留上次取得的小结。' : ''}</p> : null}
    {blockingLoad ? <p className="memory-daily-empty" role="status">正在查看今日小结…</p> : today ? <article className="memory-daily-card">
      <p className="memory-daily-detail" role="status">{detailMessage(today, true)}</p>
      <p className="memory-daily-overview">{today.summary || `今天聊到了${today.topics.join('、') || '一些日常话题'}。`}</p>
      <p className="memory-preview-detail"><strong>心情</strong>{today.moodState === 'expressed' && today.moods?.length ? today.moods.join('、') : !today.moodState || today.moodState === 'legacy-unavailable' ? '旧小结未整理心情，不能补猜。' : '暂未记录到明确心情，先不猜。'}</p>
      {today.moodCoverage === 'partial-history' ? <p className="memory-daily-coverage">心情仅来自新聊天，部分旧记录未整理。</p> : null}
      <p className="memory-preview-detail"><strong>困扰</strong>{today.concernState === 'expressed' && today.concerns.length ? today.concerns.join('、') : '未记录到明确表达，不能据此判断没有困扰。'}</p>
      <span className="memory-daily-time">{today.day} · 整理自 {today.sessions} 次聊天</span>
    </article> : <div className="memory-daily-empty"><strong>{error ? '今日小结暂时无法确认' : !dailySummaries ? '尚未取得今日小结' : '今天还没有可展示的小结'}</strong><p>{error || !dailySummaries ? '请刷新后核对。' : data.child?.memoryEnabled ? '符合记录范围的聊天正常结束后会更新。暂无小结不代表今天没有聊过。' : '已关闭新的整理，已有记录仍可在记忆小本查看。'}</p></div>}
    {!data.child?.memoryEnabled ? <p className="helper">新的小结与记忆整理已关闭。</p> : null}
    <button type="button" className="text-button memory-open-button" onClick={onOpenMemory}>查看记忆小本 <span aria-hidden="true">›</span></button>
  </section>;

  return <section className="memory-panel">
    <div className="panel-title"><div><span className="eyebrow">聊了什么、什么心情，还有重要的小事</span><h2>宝妍的记忆小本</h2></div><BookOpen size={25}/></div>
    <div className="setting-row"><div><strong>保存聊天小结与专属记忆</strong><p>新建资料默认开启。正常聊天结束后整理；关闭停止新增，已有记录仍可管理。</p></div><button type="button" role="switch" aria-checked={data.child?.memoryEnabled ?? false} aria-label="保存聊天小结与专属记忆" className={`switch ${data.child?.memoryEnabled ? 'on' : ''}`} disabled={busy || loading || refreshing || !scopeReady} onClick={() => void toggle()}><span/></button></div>
    {error ? <p className="error-note" role="alert">{error}{hasLoaded && scopeReady ? ' 下方保留上次成功取得的记录。' : ''}</p> : null}
    {notice && scopeReady ? <p className="success-note" role="status"><Check size={16}/>{notice}</p> : null}
    <>
      <section className="memory-daily-section" aria-label="今日聊天小结">
        <div className="memory-section-heading"><h3><MessageCircle size={20}/>今日聊天小结</h3><button type="button" className="button secondary small" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={15}/>{refreshing ? '正在刷新…' : '刷新小本'}</button></div>
        <p className="helper">聊过的话题、本人提到的心情和困扰。先显示简略小结，再补充具体内容；只留摘要，不保存整段聊天。</p>
        {dailySummaries && scopeReady ? <p className="memory-daily-day">{dailySummaries.today} · 按北京时间分日 · 最长保留 {dailySummaries.retentionDays} 天</p> : null}
        {blockingLoad ? <p className="memory-daily-empty" role="status">正在查看今日小结…</p> : today ? dailyCard(today, true) : <div className="memory-daily-empty"><strong>{error ? '今日小结状态暂时无法确认' : !dailySummaries ? '尚未取得今日小结' : '今天还没有可展示的小结'}</strong><p>{error || !dailySummaries ? '请刷新后核对，不据此判断今天有没有聊天。' : data.child?.memoryEnabled ? '符合记录范围的聊天正常结束后会更新。这里暂无记录，不表示今天没聊过。' : '当前已关闭新的整理，已有历史小结仍可查看和删除。'}</p></div>}
        {history.length ? <details className="memory-daily-history"><summary>每日历史 · {history.length} 天</summary><div>{history.map(record => dailyCard(record, false))}</div></details> : null}
      </section>
      <section className="memory-longterm-section" aria-label="长期专属记忆">
        <div className="memory-section-heading"><h3><Leaf size={20}/>专属记忆 <span>{scopeReady ? items.length : 0}</span></h3></div>
        <p className="helper">留给以后聊天的小事，家长可以修改或删除。</p>
        <div className="auto-memory-status"><p className="helper" role="status">{blockingLoad ? '正在查看专属记忆整理状态…' : summaryStatus}{hasLoaded && scopeReady && autoSummary?.updatedAt ? <><br/>最近状态更新：{dateTime(autoSummary.updatedAt)}</> : null}{scopeReady && pollStopped && autoSummary?.state === 'pending' ? <><br/>已暂停自动刷新，当前仍未确认整理完成。可点击“刷新小本”再次查看。</> : null}</p></div>
      </section>
    </>
    {blockingLoad ? <p className="empty-state">正在翻开专属记忆…</p> : visible.length === 0 ? <div className="empty-state"><BookOpen size={32}/><h3>{emptyTitle}</h3><p>长期记忆会筛选适合保留的内容；今天聊过的话题与明确困扰请看上方小结。也可主动说“帮我记住…”并确认。</p></div> : <div className="memory-list">{visible.map(item => <article className="memory-card" key={item.id}>
      <div className="memory-meta"><span>{kindLabels[item.kind] || '角色设定'}</span><span>{item.expiresAt ? `到期 ${new Date(item.expiresAt).toLocaleDateString('zh-CN')}` : '已确认'}</span></div>
      {edit === item.id ? <><label className="field">修改记忆<textarea maxLength={60} value={draft} disabled={busy || !scopeReady} onChange={event => setDraft(event.target.value)}/></label><div className="inline-actions"><button type="button" className="button primary small" disabled={busy || !scopeReady || !draft.trim()} onClick={() => void save(item.id)}>保存修改</button><button type="button" className="button ghost small" disabled={busy} onClick={() => setEdit('')}>取消</button></div></> : <div><p className="memory-content">{item.content}</p><p className="memory-source">来源：{sourceLabel(item.source)}</p></div>}
      {edit !== item.id ? <div className="memory-actions">{deleting === item.id ? <><span>确定忘掉这条？30天内不会自动恢复同一条，仍可主动确认重新保存。</span><button type="button" className="button danger small" disabled={busy || !scopeReady} onClick={() => void erase(item.id)}>确认删除</button><button type="button" className="button ghost small" disabled={busy} onClick={() => setDeleting('')}>取消</button></> : <><button type="button" className="text-button" disabled={busy || refreshing || !scopeReady} onClick={() => { setEdit(item.id); setDraft(item.content); setDeleting(''); setDeletingDay(''); }}><Pencil size={15}/>修改</button><button type="button" className="text-button" disabled={busy || refreshing || !scopeReady} onClick={() => { setDeleting(item.id); setDeletingDay(''); }}><Trash2 size={15}/>删除</button></>}</div> : null}
    </article>)}</div>}

    <details className="memory-explanation">
      <summary>记忆说明与宝妍设定</summary>
      <h3>小结与记忆怎么记录</h3>
      <p className="helper">正常聊天结束后整理。今日小结只依据明确表达，不猜一整天的心情，只留必要的短摘要，不保存整段聊天；按北京时间分日，最长保留30天。专属记忆每次最多3条、共20条、每条60字，30天到期；家长修改优先，关闭整理不等于删除已有记录。</p>
      <h3><Globe2 size={18}/>宝妍的共享设定 <span>{data.globalMemories.length}</span></h3>
      <p className="helper">这是宝妍的共同角色设定，不是与孩子共同经历的事。同一设定冲突时，孩子有效的专属约定优先。</p>
      <p className="global-memory-version">共享设定版本 {data.globalRevision === undefined ? '尚未取得' : `r${data.globalRevision}`} · 仅供查看</p>
      {data.globalMemories.length ? <div className="memory-list">{data.globalMemories.map(item => <article className="memory-card" key={item.id}>
        <div className="memory-meta"><span>{kindLabels[item.kind] || '角色设定'}</span><span>共享 · 只读</span></div>
        <p className="memory-content">{item.content}</p><p className="memory-source">来源：{item.source || '系统共享设定'} · 条目版本 r{item.revision}</p>
      </article>)}</div> : <p className="helper">当前没有共享设定。</p>}
    </details>
  </section>;
}
