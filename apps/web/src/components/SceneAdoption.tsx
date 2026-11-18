import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw, Undo2 } from 'lucide-react';
import { api, ApiError, messageOf, operationId } from '../lib/api';
import { promptLabAuthorizationExpired } from '../lib/promptLab';
import type { CalibrationCase } from '../lib/calibration';
import { adoptionCanApply, adoptionIntentLabels, directionLabel, directionMatches, adoptionScopeLabel, type AdoptionChoice, type AdoptionComparison, type AdoptionIntent, type AdoptionOverview, type AdoptionPreference, type AdoptionState, type AdoptionReceipt, type DirectionPreview } from '../lib/sceneAdoption';
import './SceneAdoption.css';

type Props = { item: CalibrationCase; apiBase: '/parent/calibration' | '/debug/calibration'; childId?: string; disabled?: boolean; onBusyChange: (busy: boolean) => void; onAuthorizationExpired: () => void; onApplied?: () => void };
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const emptyChoices = (): (AdoptionChoice | '')[] => ['', '', ''];

/** Load comparisons only after the parent opens this saved scene. */
export function SceneAdoption(props: Props) {
  const [open, setOpen] = useState(false);
  return <details className="scene-adoption" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>让这个方向用于以后的聊天</summary>
    {open ? <AdoptionEditor {...props} key={`${props.apiBase}:${props.childId}:${props.item.id}:${props.item.revision}`}/> : null}
  </details>;
}

function AdoptionEditor({ item, apiBase, childId, disabled = false, onBusyChange, onAuthorizationExpired, onApplied }: Props) {
  const [overview, setOverview] = useState<AdoptionOverview | null>(null);
  const [report, setReport] = useState<AdoptionComparison | null>(null);
  const [preferences, setPreferences] = useState<AdoptionPreference[]>([]);
  const [directionText, setDirectionText] = useState(item.guideline?.slice(0, 400) ?? '');
  const [direction, setDirection] = useState<DirectionPreview | null>(null);
  const [directionConfirmed, setDirectionConfirmed] = useState(false);
  const [mode, setMode] = useState<'natural' | 'fixed'>('natural');
  const [intent, setIntent] = useState<AdoptionIntent>('sharing');
  const [choices, setChoices] = useState(emptyChoices);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mutation, setMutation] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const activeJob = useRef<string | null>(null);
  const callbacks = useRef({ onBusyChange, onAuthorizationExpired, onApplied });
  callbacks.current = { onBusyChange, onAuthorizationExpired, onApplied };
  const base = `${apiBase}/adoption`;
  const headers: Record<string, string> = childId ? { 'X-Baoyan-Child': childId } : {};
  const pending = report?.status === 'pending';
  const busy = loading || mutation || pending || !!activeJob.current;
  const locked = disabled || busy;
  const selectedScope = adoptionScopeLabel(apiBase === '/debug/calibration' ? 'debug' : 'family');
  const request = async <T,>(path: string, init: RequestInit = {}) => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { return await api<T>(`${base}${path}`, { ...init, headers, signal: controller.signal }); }
    finally { controllers.current.delete(controller); }
  };
  const fail = (cause: unknown) => {
    if (!mounted.current) return;
    if (promptLabAuthorizationExpired(cause) || (cause instanceof ApiError && cause.code === 'REPLY_ADJUSTMENT_CHILD_CHANGED')) {
      activeJob.current = null; setReport(null); setDirection(null); setDirectionConfirmed(false); setOverview(null); setChoices(emptyChoices()); setConfirmed(false);
      callbacks.current.onAuthorizationExpired(); return;
    }
    setError(messageOf(cause));
  };
  const showReport = (value: AdoptionComparison) => {
    setReport(value); activeJob.current = value.status === 'pending' ? value.operationId : null;
  };
  const refresh = async (restore = false) => {
    setLoading(true); setError('');
    try {
      const value = await request<AdoptionOverview>('');
      if (!mounted.current) return;
      setOverview(value);
      if (restore) {
        setChoices(emptyChoices()); setConfirmed(false);
        const latest = value.reports.find(row => row.caseId === item.id && row.caseRevision === item.revision);
        if (latest) { showReport(latest); setPreferences(latest.preferences); setIntent(latest.intent); setMode(latest.direction ? 'natural' : 'fixed'); const saved = value.directions?.find(row => row.id === latest.directionId); setDirection(saved ?? null); if (saved) setDirectionText(saved.sourceText); }
        setDirectionConfirmed(false);
      }
    } catch (cause) { if (mounted.current) setOverview(null); fail(cause); }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true; void refresh(true);
    return () => {
      mounted.current = false; controllers.current.forEach(controller => controller.abort()); controllers.current.clear();
      if (activeJob.current) void fetch(`/api${base}/compare/${encodeURIComponent(activeJob.current)}/cancel`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }).catch(() => {});
      callbacks.current.onBusyChange(false);
    };
  }, []);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    if (!report || report.status !== 'pending' || disabled) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await request<AdoptionComparison>(`/comparisons/${encodeURIComponent(report.id)}`);
        if (!stopped && mounted.current) { showReport(value); if (value.status === 'pending') timer = setTimeout(() => void poll(), 1800); }
      } catch (cause) {
        if (!stopped && mounted.current) {
          fail(cause);
          if (cause instanceof ApiError && [401, 403, 404, 409, 410].includes(cause.status)) {
            activeJob.current = null; setReport(value => value ? { ...value, status: 'failed', error: '这次比较已失效，请刷新后重新查看。' } : null);
            setOverview(null); setChoices(emptyChoices()); setConfirmed(false);
          } else timer = setTimeout(() => void poll(), 5000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [report?.id, report?.status, disabled]);
  const previewDirection = async () => {
    if (locked || !directionText.trim()) return;
    setMutation(true); setError(''); setNotice(''); setDirection(null); setDirectionConfirmed(false);
    try {
      const value = await request<DirectionPreview>('/directions/preview', { method: 'POST', body: JSON.stringify({ operationId: operationId(), caseId: item.id, caseRevision: item.revision, text: directionText, intent }) });
      if (mounted.current) setDirection(value);
    } catch (cause) { fail(cause); }
    finally { if (mounted.current) setMutation(false); }
  };
  const naturalReady = directionConfirmed && directionMatches(direction, item, directionText, intent, apiBase === '/debug/calibration' ? 'debug' : 'family');
  const compare = async () => {
    if (locked || !overview || (mode === 'natural' ? !naturalReady : !preferences.length)) return;
    setMutation(true); setError(''); setNotice(''); setConfirmed(false); setChoices(emptyChoices());
    const id = operationId(); activeJob.current = id;
    try {
      const value = await request<AdoptionComparison>('/compare', { method: 'POST', body: JSON.stringify({ operationId: id, caseId: item.id, caseRevision: item.revision, intent, ...(mode === 'natural' ? { directionId: direction!.id, directionConfirmed: true } : { preferences }) }) });
      if (mounted.current) showReport(value);
    } catch (cause) { fail(cause); if (mounted.current) setNotice('比较没有确认完成，不会自动采用。请先刷新查看结果。'); }
    finally { if (mounted.current) setMutation(false); }
  };
  const cancel = async () => {
    const id = activeJob.current; if (!id || mutation) return;
    setMutation(true);
    try {
      await request(`/compare/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
      if (mounted.current) { activeJob.current = null; setReport(value => value ? { ...value, status: 'cancelled' } : null); setNotice('比较已停止，没有采用新方向。'); }
    } catch (cause) { fail(cause); }
    finally { if (mounted.current) setMutation(false); }
  };
  const apply = async () => {
    if (locked || !confirmed || !adoptionCanApply(report, choices, overview?.state, item)) return;
    setMutation(true); setError('');
    try {
      const value = await request<{ state: AdoptionState; receipt: AdoptionReceipt }>('/apply', { method: 'POST', body: JSON.stringify({ operationId: operationId(), comparisonId: report!.id, expectedVersion: overview!.state.version, choices, confirmed: true }) });
      if (mounted.current) { setOverview(old => old ? { ...old, state: value.state } : old); setConfirmed(false); setNotice('已采用这个接话方向，从下一次匹配的聊天开始使用。'); callbacks.current.onApplied?.(); }
    } catch (cause) { fail(cause); if (mounted.current) { setOverview(null); setNotice('提交结果尚未确认，请刷新查看实际采用状态。'); } }
    finally { if (mounted.current) setMutation(false); }
  };
  const revoke = async () => {
    if (locked || !overview?.state.active || !revokeConfirm) return;
    setMutation(true); setError('');
    try {
      const value = await request<{ state: AdoptionState }>('/revoke', { method: 'POST', body: JSON.stringify({ operationId: operationId(), expectedVersion: overview.state.version }) });
      if (mounted.current) { setOverview(old => old ? { ...old, state: value.state } : old); setRevokeConfirm(false); setNotice('已撤回，后续聊天恢复宝妍默认接法。保存的场景仍在。'); callbacks.current.onApplied?.(); }
    } catch (cause) { fail(cause); if (mounted.current) { setOverview(null); setNotice('撤回结果尚未确认，请刷新查看实际采用状态。'); } }
    finally { if (mounted.current) setMutation(false); }
  };
  const edit = () => { setReport(null); setChoices(emptyChoices()); setConfirmed(false); setNotice(''); setDirection(null); setDirectionConfirmed(false); };
  const active = overview?.state.active;
  const canApply = adoptionCanApply(report, choices, overview?.state, item);
  return <div className="scene-adoption-body">
    <p>用你自己的话告诉宝妍怎么接话，先确认理解，再看看新旧回答。你确认采用后，以后的类似聊天才会使用。</p>
    <p className="helper">{selectedScope}，适用于 {item.ageGroup} 岁的对应话题；本轮支持文字和语音聊天，图片聊天保持原接法。</p>
    {error ? <p role="alert" className="error-note">{error}</p> : null}
    {notice ? <p role="status" className="success-note">{notice}</p> : null}
    <div className="scene-adoption-current" aria-live="polite">
      <strong>{loading ? '正在查看采用状态…' : !overview ? '采用状态尚未确认，请刷新查看' : active ? active.caseId === item.id ? '这个场景的方向已在使用' : '当前正在使用另一个场景的方向' : '尚未采用新方向，保持默认接法'}</strong>
      {active ? <><p>{directionLabel(active, overview?.directionSteps)} · {active.ageGroup} 岁 · {adoptionIntentLabels[active.intent]}</p><small>{adoptionScopeLabel(active.scope)} · 第 {active.version} 版 · {dateLabel(active.appliedAt)}</small><button type="button" className="text-button" disabled={locked} onClick={() => setRevokeConfirm(true)}><Undo2 size={15}/>撤回当前采用</button>{revokeConfirm ? <div className="inline-confirm"><p>撤回后恢复默认接法，已保存的场景会保留。</p><button type="button" className="button secondary" disabled={locked} onClick={() => void revoke()}>确认撤回</button><button type="button" className="text-button" disabled={locked} onClick={() => setRevokeConfirm(false)}>继续使用</button></div> : null}</> : overview?.state.lastChange ? <p className="helper">{overview.state.lastChange.reason} · {dateLabel(overview.state.lastChange.at)}</p> : null}
    </div>
    <button type="button" className="text-button" disabled={mutation || loading} onClick={() => void refresh(true)}><RefreshCw size={15}/>刷新采用状态</button>
    {pending || activeJob.current ? <button type="button" className="text-button" disabled={mutation} onClick={() => void cancel()}>停止比较</button> : null}
    {overview && item.status === 'accepted' ? <>
      <fieldset disabled={locked} className="scene-adoption-options"><legend>① 你希望宝妍怎么接话？</legend>
        <div className="scene-direction-mode"><button type="button" aria-pressed={mode === 'natural'} className="text-button" onClick={() => { edit(); setMode('natural'); }}>自己说说</button><button type="button" aria-pressed={mode === 'fixed'} className="text-button" onClick={() => { edit(); setMode('fixed'); }}>选择简单方向</button></div>
        {mode === 'natural' ? <><label className="field">把你的想法写在这里<textarea rows={3} maxLength={400} value={directionText} onChange={event => { edit(); setDirectionText(event.target.value); }} placeholder="例如：先回应发生的事，再问原因，最后给一个可试的小办法。"/></label>
          <details className="calibration-context"><summary>不知道怎么写？看看例子</summary>{overview.directionExamples?.map(text => <button key={text} type="button" className="text-button" onClick={() => { edit(); setDirectionText(text); }}>{text}</button>)}</details>
        </> : overview.preferences.map(option => <label className="check-row" key={option.id}><input type="checkbox" checked={preferences.includes(option.id)} disabled={!preferences.includes(option.id) && preferences.length >= 2} onChange={event => { edit(); setPreferences(old => event.target.checked ? [...old, option.id] : old.filter(id => id !== option.id)); }}/><span><b>{option.label}</b><small>{option.description}</small></span></label>)}
        <label className="field">用在哪种聊天里<select value={intent} onChange={event => { edit(); setIntent(event.target.value as AdoptionIntent); }}>{overview.intents.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        {mode === 'natural' ? <button type="button" className="button secondary" disabled={!directionText.trim()} onClick={() => void previewDirection()}>整理我的想法</button> : null}
      </fieldset>
      {mode === 'natural' && direction ? <div className="scene-direction-preview" aria-live="polite"><strong>我理解你希望这样接话</strong><ol>{direction.steps.map(step => <li key={step.id}><b>{step.label}</b><p>{step.description}</p></li>)}</ol>{direction.warnings.map(text => <p key={text} className="helper">{text}</p>)}<label className="check-row"><input type="checkbox" checked={directionConfirmed} disabled={locked || !directionMatches(direction, item, directionText, intent, overview.scope)} onChange={event => setDirectionConfirmed(event.target.checked)}/><span>这就是我的意思，继续比较回答</span></label></div> : null}
      <p className="helper">② 比较这条场景和两个新问题，会生成6份回答，可能要稍等。你看完后决定，不会自动采用。</p>
      <div className="inline-actions"><button type="button" className="button secondary" disabled={locked || (mode === 'natural' ? !naturalReady : !preferences.length) || !overview.configured} onClick={() => void compare()}>{pending ? `正在比较 ${report!.completedPairs}/${report!.total} 组…` : '看看新旧回答'}</button></div>
      {!overview.configured ? <p className="helper">对话服务暂不可用，尚不能比较或采用。</p> : null}
    </> : null}
    {report ? <section className="scene-adoption-results" aria-label="接话方向比较结果">
      {report.error ? <p className="error-note">{report.error}</p> : null}
      {report.rows.map((row, index) => <article key={row.id}><h5>{index + 1}. {row.label}</h5><p>{row.ageGroup} 岁 · {row.question}</p><div className="scene-adoption-pair"><div><strong>现在的接法</strong><p>{row.baseline.reply ?? row.baseline.error}</p></div><div><strong>试试新方向</strong><p>{row.candidate.reply ?? row.candidate.error}</p></div></div><fieldset disabled={locked || report.status !== 'completed'}><legend>这组你更喜欢哪种？</legend>{([['candidate', '新方向更好'], ['tie', '都可以'], ['baseline', '原来更好'], ['neither', '都不满意']] as const).map(([value, label]) => <label key={value}><input type="radio" name={`adoption-${report.id}-${row.id}`} checked={choices[index] === value} onChange={() => { setChoices(old => old.map((choice, at) => at === index ? value : choice)); setConfirmed(false); }}/>{label}</label>)}</fieldset></article>)}
      {report.status === 'completed' ? <><p className="helper">前三组都认可，且前两组至少有一组新方向更好，才能采用。若有一组变差，就换个方向再比较。</p>{report.baseVersion !== overview?.state.version ? <p className="helper">当前采用版本已经变化。这份比较可查看，重新比较后才能再次采用。</p> : null}<label className="check-row"><input type="checkbox" checked={confirmed} disabled={locked || !canApply} onChange={event => setConfirmed(event.target.checked)}/><span>③ 我看过三组回答，确认{selectedScope}采用这个方向{active ? '，替换当前方向' : ''}。</span></label><button type="button" className="button primary" disabled={locked || !canApply || !confirmed} onClick={() => void apply()}><Check size={17}/>确认采用这个方向</button></> : report.status === 'pending' ? <p role="status">正在生成第 {Math.min(report.completedPairs + 1, 3)} 组回答…</p> : <p className="helper">这次比较没有完成，未采用新方向。</p>}
      <details className="calibration-context"><summary>这次比较的记录</summary><p>生成于 {dateLabel(report.createdAt)}，采用确认有效至 {dateLabel(report.expiresAt)}。</p><p>接话方向：{directionLabel(report, overview?.directionSteps)}</p><p>回复规则 {report.personaVersion} · 方向规则 {report.policyVersion}</p><p>模型：{report.model}</p></details>
    </section> : null}
  </div>;
}
