import { useEffect, useRef, useState } from 'react';
import { api, ApiError, messageOf, operationId } from '../lib/api';
import { promptLabAuthorizationExpired } from '../lib/promptLab';
import type { CalibrationCase } from '../lib/calibration';
import { adoptionScopeLabel, retestSelection, type AdoptionOverview, type SceneRetest as Report } from '../lib/sceneAdoption';
import './SceneAdoption.css';

type Props = { cases: CalibrationCase[]; apiBase: '/parent/calibration' | '/debug/calibration'; childId?: string; disabled?: boolean; onBusyChange: (value: boolean) => void; onAuthorizationExpired: () => void };
export function SceneRetest(props: Props) {
  const [open, setOpen] = useState(false);
  return <details className="scene-adoption scene-retest" onToggle={event => setOpen(event.currentTarget.open)}><summary>一起试试已保存的场景</summary>{open ? <RetestEditor {...props} key={`${props.apiBase}:${props.childId}`}/> : null}</details>;
}
function RetestEditor({ cases, apiBase, childId, disabled = false, onBusyChange, onAuthorizationExpired }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [overview, setOverview] = useState<AdoptionOverview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutation, setMutation] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const job = useRef<string | null>(null);
  const callbacks = useRef({ onBusyChange, onAuthorizationExpired });
  callbacks.current = { onBusyChange, onAuthorizationExpired };
  const base = `${apiBase}/adoption`;
  const headers: Record<string, string> = childId ? { 'X-Baoyan-Child': childId } : {};
  const busy = loading || mutation || report?.status === 'pending' || !!job.current;
  const locked = disabled || busy;
  const selection = retestSelection(cases, selected);
  const showReport = (value: Report | null) => { setReport(value); job.current = value?.status === 'pending' ? value.operationId : null; };
  const request = async <T,>(path: string, init: RequestInit = {}) => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { return await api<T>(`${base}${path}`, { ...init, headers, signal: controller.signal }); }
    finally { controllers.current.delete(controller); }
  };
  const fail = (cause: unknown) => {
    if (!mounted.current) return;
    if (promptLabAuthorizationExpired(cause) || (cause instanceof ApiError && cause.code === 'REPLY_ADJUSTMENT_CHILD_CHANGED')) {
      showReport(null); setOverview(null); setSelected([]); callbacks.current.onAuthorizationExpired();
    } else setError(messageOf(cause));
  };
  const refresh = async () => {
    setLoading(true); setError('');
    try { const value = await request<AdoptionOverview>(''); if (mounted.current) { setOverview(value); showReport(value.retests?.[0] ?? null); } }
    catch (cause) { if (mounted.current) setOverview(null); fail(cause); }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => {
      mounted.current = false; controllers.current.forEach(controller => controller.abort());
      if (job.current) void fetch(`/api${base}/retests/${encodeURIComponent(job.current)}/cancel`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }).catch(() => {});
      callbacks.current.onBusyChange(false);
    };
  }, []);
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    if (report?.status !== 'pending' || disabled) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await request<Report>(`/retests/${encodeURIComponent(report.id)}`);
        if (!stopped && mounted.current) { showReport(value); if (value.status === 'pending') timer = setTimeout(() => void poll(), 1800); }
      } catch (cause) {
        if (!stopped && mounted.current) {
          fail(cause);
          if (cause instanceof ApiError && [401, 403, 404, 409, 410].includes(cause.status)) { job.current = null; setReport(null); setOverview(null); }
          else timer = setTimeout(() => void poll(), 5000);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [report?.id, report?.status, disabled]);
  const start = async () => {
    if (locked || !selection || !overview?.configured) return;
    setMutation(true); setError(''); const id = operationId(); job.current = id;
    try { const value = await request<Report>('/retests', { method: 'POST', body: JSON.stringify({ operationId: id, cases: selection }) }); if (mounted.current) showReport(value); }
    catch (cause) { fail(cause); }
    finally { if (mounted.current) setMutation(false); }
  };
  const cancel = async () => {
    if (!job.current || mutation) return;
    setMutation(true);
    try { await request(`/retests/${encodeURIComponent(job.current)}/cancel`, { method: 'POST', body: '{}' }); if (mounted.current) { job.current = null; setReport(value => value ? { ...value, status: 'cancelled' } : null); } }
    catch (cause) { fail(cause); }
    finally { if (mounted.current) setMutation(false); }
  };
  const stale = report && (['model', 'personaVersion', 'replyPlanVersion', 'conversationPolicyVersion', 'policyVersion'].some(key => { const field = key as 'model' | 'personaVersion' | 'replyPlanVersion' | 'conversationPolicyVersion' | 'policyVersion'; return !!overview?.[field] && report[field] !== overview[field]; }) || report.baseVersion !== overview?.state.version || report.cases.some(source => !cases.some(item => item.id === source.id && item.revision === source.revision && item.status === 'accepted')));
  return <div className="scene-adoption-body">
    <p>选 3–5 条你认可的场景，看看现在的宝妍会怎么回答。以后换模型，也可以用这些场景再试一次。</p>
    {error ? <p role="alert" className="error-note">{error} 提交结果不确定时，请刷新查看或停止复测。</p> : null}
    <div className="inline-actions"><button type="button" className="text-button" disabled={loading || mutation} onClick={() => void refresh()}>刷新复测记录</button>{job.current ? <button type="button" className="text-button" disabled={mutation} onClick={() => void cancel()}>停止复测</button> : null}</div>
    <fieldset disabled={locked}><legend>选择已确认的场景 · {selected.length}/5</legend><div className="scene-retest-selection">{cases.filter(item => item.status === 'accepted' && !!item.expectedReply?.trim()).map(item => <label key={item.id} className="check-row"><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && selected.length >= 5} onChange={event => setSelected(old => event.target.checked ? [...old, item.id] : old.filter(id => id !== item.id))}/><span>{item.title}<small>{item.ageGroup} 岁</small></span></label>)}</div>{cases.filter(item => item.status === 'accepted' && !!item.expectedReply?.trim()).length < 3 ? <p className="helper">先保存并确认至少 3 条带满意回答的场景，就能一起复测。</p> : null}</fieldset>
    <p className="helper">会生成 {selection?.length ?? '3–5'} 份当前回答，只复测，不改变正在使用的接法。</p>
    <button type="button" className="button secondary" disabled={locked || !selection || !overview?.configured} onClick={() => void start()}>{report?.status === 'pending' ? `正在复测 ${report.completed}/${report.total} 条…` : '开始复测这些场景'}</button>
    {report ? <section className="scene-adoption-results" aria-label="场景复测结果"><p role="status">{report.status === 'completed' ? '这次复测已完成，请逐条看看是否自然。' : report.status === 'pending' ? `正在生成 ${report.completed}/${report.total} 条` : report.status === 'cancelled' ? '已停止，已生成的结果保留供查看。' : '这次复测未完成，请查看原因。'}</p>{report.error ? <p className="error-note">{report.error}</p> : null}{stale ? <p className="helper">模型、场景或采用方向已变化，这份旧结果仅供回看，可重新复测。</p> : null}{report.rows.map(row => <article key={row.caseId}><h5>{row.title}</h5><p>{row.ageGroup} 岁 · {row.question}</p><div className="scene-adoption-pair"><div><strong>你保存的满意回答</strong><p>{row.expectedReply}</p></div><div><strong>本次生成的回答</strong><p>{row.reply ?? row.error ?? '等待生成…'}</p></div></div><small>{row.adopted ? '这条回答使用了当前采用的接话方向' : '这条回答使用默认接法'}</small></article>)}<details className="calibration-context"><summary>查看这次复测的记录</summary><p>{new Date(report.createdAt).toLocaleString('zh-CN')} · {adoptionScopeLabel(report.scope)}</p><p>模型：{report.model}</p><p>回复规则 {report.personaVersion} · 采用第 {report.baseVersion} 版</p></details></section> : null}
  </div>;
}
