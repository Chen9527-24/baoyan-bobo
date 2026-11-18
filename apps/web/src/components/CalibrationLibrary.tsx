import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Download, FilePlus2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api as baseApi, messageOf, operationId } from '../lib/api';
import { promptLabAuthorizationExpired, promptLabElapsed, type PromptLabAge } from '../lib/promptLab';
import {
  calibrationImportByteLimit, calibrationImportCaseLimit, calibrationProgress, calibrationSnapshotChoiceLabel, calibrationStatusLabels,
  parseCalibrationImport, prepareCalibrationSubmission, splitCalibrationExport,
  type CalibrationCase, type CalibrationComparisonSnapshot, type CalibrationDraft, type CalibrationExport,
  type CalibrationSample, type CalibrationStatus, type CalibrationSubmission, type CalibrationWorkflow,
} from '../lib/calibration';
import './CalibrationLibrary.css';
import { SceneAdoption } from './SceneAdoption';
import { SceneRetest } from './SceneRetest';

type Tab = 'samples' | 'new' | 'cases';
type Pending = { controller: AbortController; kind: 'create' | 'review' | 'delete' | 'import' | 'export' };
type ImportPreview = { filename: string; document: { schemaVersion: 'baoyan-calibration-v1'; cases: CalibrationSubmission[] } };
const emptyDraft = (): CalibrationDraft => ({ question: '', actualReply: '', ageGroup: '6-8', title: '', category: '接话调整', expectedReply: '', guideline: '', note: '', testHistory: [], testMemories: [] });
const copyDraft = (draft: CalibrationDraft): CalibrationDraft => ({ ...draft, testHistory: (draft.testHistory ?? []).map(message => ({ ...message })), testMemories: (draft.testMemories ?? []).map(memory => ({ ...memory })) });
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

function ComparisonSnapshot({ snapshot }: { snapshot: CalibrationComparisonSnapshot }) {
  return <details className="calibration-context"><summary>以前保存的回答与选择</summary><p className="helper">当时的选择：{calibrationSnapshotChoiceLabel(snapshot)}。这里保留的是以前的回答。</p>{snapshot.displayOrder.map((side, index) => <div className="calibration-comparison-reply" key={side}><strong>回复 {index + 1} · {promptLabElapsed(snapshot[side].elapsedMs)}</strong>{snapshot[side].error ? <p className="error-note">{snapshot[side].error}</p> : <p className="calibration-copy">{snapshot[side].reply || '未返回文字。'}</p>}</div>)}</details>;
}

export interface CalibrationLibraryProps {
  apiBase?: '/parent/calibration' | '/debug/calibration';
  childId?: string;
  onAdoptionChange?: () => void;
  onBusyChange: (busy: boolean) => void;
  initialDraft?: CalibrationDraft;
  initialTab?: Tab;
  initialSelectedId?: string;
  onAdjustCase?: (draft: CalibrationDraft) => void;
  disabled?: boolean;
  authorizationExpired?: boolean;
  onAuthorizationExpired?: () => void;
}

/** A household-scoped fictional reference library. Saving and accepting never publish a persona. */
export function CalibrationLibrary({ childId, onAdoptionChange, onBusyChange, initialDraft, initialTab, initialSelectedId, onAdjustCase, disabled = false, authorizationExpired = false, onAuthorizationExpired, apiBase = '/parent/calibration' }: CalibrationLibraryProps) {
  const debug = apiBase === '/debug/calibration';
  const api = <T,>(path: string, options: RequestInit = {}) => baseApi<T>(path.replace('/parent/calibration', apiBase), options);
  const [tab, setTab] = useState<Tab>(initialDraft ? 'new' : initialTab ?? 'samples');
  const [samples, setSamples] = useState<CalibrationSample[]>([]);
  const [samplesVersion, setSamplesVersion] = useState('');
  const [cases, setCases] = useState<CalibrationCase[]>([]);
  const [workflow, setWorkflow] = useState<CalibrationWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Pending['kind'] | null>(null);
  const [retestBusy, setRetestBusy] = useState(false);
  const [adoptionBusy, setAdoptionBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sampleAge, setSampleAge] = useState<PromptLabAge | 'all'>('all');
  const [draft, setDraft] = useState<CalibrationDraft>(() => initialDraft ? copyDraft(initialDraft) : emptyDraft());
  const [fictionalConfirmed, setFictionalConfirmed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [statusFilter, setStatusFilter] = useState<CalibrationStatus | 'all'>('all');
  const [reviewNote, setReviewNote] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importConfirmed, setImportConfirmed] = useState(false);
  const [exportParts, setExportParts] = useState<CalibrationExport[]>([]);
  const mounted = useRef(false);
  const expiredRef = useRef(false);
  const disabledRef = useRef(disabled);
  const pending = useRef<Pending | null>(null);
  const reads = useRef(new Set<AbortController>());
  const readGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const onBusyRef = useRef(onBusyChange);
  const onExpiredRef = useRef(onAuthorizationExpired);
  const formRef = useRef<HTMLDivElement | null>(null);
  const transferRef = useRef<HTMLDetailsElement | null>(null);
  disabledRef.current = disabled;
  onBusyRef.current = onBusyChange;
  onExpiredRef.current = onAuthorizationExpired;

  const expire = (notify = true) => {
    expiredRef.current = true;
    ++readGeneration.current; ++fileGeneration.current;
    reads.current.forEach(controller => controller.abort()); reads.current.clear();
    const active = pending.current; pending.current = null; active?.controller.abort();
    setExpired(true); setBusy(null); setLoading(false); setSamples([]); setSamplesVersion(''); setCases([]); setWorkflow(null);
    setDraft(emptyDraft()); setFictionalConfirmed(false); setSelectedId(null); setReviewNote(''); setDeleteId(null);
    setImportPreview(null); setImportConfirmed(false); setExportParts([]); setNotice('');
    setError(debug ? '内测验证已失效，本页资料已清除，请重新输入密码。' : '家长验证已失效，本页资料已清除。请退出后重新进入家长空间。');
    onBusyRef.current(false);
    if (notify) onExpiredRef.current?.();
  };
  const reportError = (cause: unknown) => {
    if (!mounted.current || expiredRef.current) return;
    if (promptLabAuthorizationExpired(cause)) { expire(); return; }
    setError(cause instanceof TypeError || (cause instanceof Error && cause.name === 'AbortError')
      ? '连接中断，未自动重试。提交结果暂时不确定时，请刷新记录核对后再操作。' : messageOf(cause));
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; ++readGeneration.current; ++fileGeneration.current;
      reads.current.forEach(controller => controller.abort()); reads.current.clear();
      const active = pending.current; pending.current = null; active?.controller.abort();
      onBusyRef.current(false);
    };
  }, []);
  useEffect(() => { if (authorizationExpired && !expiredRef.current) expire(false); }, [authorizationExpired]);
  useEffect(() => {
    if (!initialDraft || expiredRef.current) return;
    setDraft(copyDraft(initialDraft)); setFictionalConfirmed(false); setTab('new'); setError('');
    setNotice('已带入这次回复。请先替换姓名、地点等个人细节，改成虚构或脱敏示例，再写调整建议。');
    const frame = window.requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    return () => window.cancelAnimationFrame(frame);
  }, [initialDraft]);

  const refresh = async () => {
    if (expiredRef.current || pending.current || disabledRef.current) return;
    const token = ++readGeneration.current;
    const controller = new AbortController(); reads.current.add(controller); setLoading(true); setError('');
    const results = await Promise.allSettled([
      api<{ version: string; items: CalibrationSample[] }>('/parent/calibration/samples', { signal: controller.signal }),
      api<{ items: CalibrationCase[]; workflow?: CalibrationWorkflow }>('/parent/calibration/cases', { signal: controller.signal }),
    ]);
    if (mounted.current && !controller.signal.aborted && token === readGeneration.current && !expiredRef.current) {
      // Authorization takes priority over any successfully returned sibling response.
      const denied = results.find(result => result.status === 'rejected' && promptLabAuthorizationExpired(result.reason));
      if (denied?.status === 'rejected') reportError(denied.reason);
      else {
        const sampleResult = results[0]; const caseResult = results[1];
        if (sampleResult.status === 'fulfilled') { setSamples(sampleResult.value.items); setSamplesVersion(sampleResult.value.version); }
        else reportError(sampleResult.reason);
        if (caseResult.status === 'fulfilled') { setCases(caseResult.value.items); setWorkflow(caseResult.value.workflow ?? null); }
        else { setWorkflow(null); reportError(caseResult.reason); }
      }
    }
    reads.current.delete(controller);
    if (mounted.current && !controller.signal.aborted && token === readGeneration.current && !expiredRef.current) setLoading(false);
  };
  useEffect(() => { void refresh(); }, []);

  const begin = (kind: Pending['kind']): Pending | null => {
    if (pending.current || expiredRef.current || disabledRef.current || loading) return null;
    const request: Pending = { controller: new AbortController(), kind };
    pending.current = request; setBusy(kind); onBusyRef.current(true); setError(''); setNotice('');
    return request;
  };
  const current = (request: Pending) => mounted.current && !expiredRef.current && pending.current === request && !request.controller.signal.aborted;
  const finish = (request: Pending) => {
    if (pending.current !== request) return;
    pending.current = null;
    if (mounted.current) { setBusy(null); onBusyRef.current(false); }
  };
  const create = async () => {
    let body: CalibrationSubmission;
    try { body = prepareCalibrationSubmission(draft, fictionalConfirmed); } catch (cause) { reportError(cause); return; }
    const request = begin('create'); if (!request) return;
    try {
      const item = await api<CalibrationCase>('/parent/calibration/cases', { method: 'POST', body: JSON.stringify({ ...body, operationId: operationId() }), signal: request.controller.signal });
      if (current(request)) {
        ++readGeneration.current; setCases(items => [item, ...items.filter(value => value.id !== item.id)]);
        setSelectedId(item.id); setReviewNote(''); setDeleteId(null); setDraft(emptyDraft()); setFictionalConfirmed(false); setTab('cases');
        setNotice('建议已保存，等你确认。可以先试答；确认后作为待校准参考，日常聊天不会自动改变。');
      }
    } catch (cause) { if (current(request)) reportError(cause); }
    finally { finish(request); }
  };
  const review = async (item: CalibrationCase, status: CalibrationStatus) => {
    if (reviewNote.trim().length > 1000) { reportError(new Error('确认说明不能超过 1000 字。')); return; }
    const request = begin('review'); if (!request) return;
    try {
      const value = await api<CalibrationCase>(`/parent/calibration/cases/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ revision: item.revision, status, reviewNote: reviewNote.trim() }), signal: request.controller.signal });
      if (current(request)) {
        ++readGeneration.current; setCases(items => items.map(record => record.id === value.id ? value : record)); setReviewNote('');
        setNotice(status === 'accepted' ? '已确认这条参考。接下来可以比较并采用接话方向，保存本身不会改变聊天。' : status === 'proposed' ? '已撤销确认，回到待确认。原记录保留。' : '已标记暂不采用。记录仍保留，可以换个方向继续调整。');
      }
    } catch (cause) { if (current(request)) reportError(cause); }
    finally { finish(request); }
  };
  const deleteCase = async (item: CalibrationCase) => {
    const request = begin('delete'); if (!request) return;
    try {
      await api(`/parent/calibration/cases/${encodeURIComponent(item.id)}`, { method: 'DELETE', signal: request.controller.signal });
      if (current(request)) {
        ++readGeneration.current; setCases(items => items.filter(record => record.id !== item.id)); setSelectedId(null); setDeleteId(null); setReviewNote('');
        setNotice('这条调优记录及确认历史已删除。已导出的本地文件不会一起删除。');
      }
    } catch (cause) { if (current(request)) reportError(cause); }
    finally { finish(request); }
  };
  const exportCases = async () => {
    const request = begin('export'); if (!request) return;
    try {
      const document = await api<CalibrationExport>('/parent/calibration/export', { signal: request.controller.signal });
      if (current(request)) {
        const parts = splitCalibrationExport(document); setExportParts(parts);
        setNotice(parts.length === 1 ? `导出文件已准备好，共 ${document.cases.length} 条记录。请点击下方下载，妥善保存场景、回复、建议、确认记录与模型快照。` : `已准备 ${parts.length} 份分卷，共 ${document.cases.length} 条记录。请分别下载，后续逐份导入，无需编辑 JSON。`);
      }
    } catch (cause) { if (current(request)) reportError(cause); }
    finally { finish(request); }
  };
  const downloadPart = (document: CalibrationExport, index: number, total: number) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
    const link = window.document.createElement('a'); link.href = url;
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    link.download = `宝妍-儿童人感调优-${date}${total > 1 ? `-第${index + 1}卷-共${total}卷` : ''}.json`;
    link.style.display = 'none'; window.document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const readImportFile = async (file: File | undefined) => {
    if (!file || pending.current || disabledRef.current || expiredRef.current) return;
    const token = ++fileGeneration.current; setImportPreview(null); setImportConfirmed(false); setError(''); setNotice('');
    try {
      if (file.size > calibrationImportByteLimit) throw new Error('记录文件不能超过 2 MiB。');
      const document = parseCalibrationImport(await file.text());
      if (mounted.current && token === fileGeneration.current && !expiredRef.current) {
        setImportPreview({ filename: file.name, document }); setNotice(debug ? '已在本机读取文件。确认后才会提交到内测场景库。' : '已在本机读取文件。确认后才会提交到本家庭记录库。');
      }
    } catch (cause) { if (mounted.current && token === fileGeneration.current && !expiredRef.current) reportError(cause); }
  };
  const importCases = async () => {
    if (!importPreview || !importConfirmed) return;
    const request = begin('import'); if (!request) return;
    try {
      const body = JSON.stringify({ operationId: operationId(), document: importPreview.document, fictionalConfirmed: true });
      if (new TextEncoder().encode(body).byteLength > calibrationImportByteLimit) throw new Error('这份记录加上提交信息后超过 2 MiB。请使用调优库自动分卷导出的文件。');
      const value = await api<{ items: CalibrationCase[]; imported: number }>('/parent/calibration/import', { method: 'POST', body, signal: request.controller.signal });
      if (current(request)) {
        ++readGeneration.current; setCases(items => [...value.items, ...items.filter(item => !value.items.some(imported => imported.id === item.id))]);
        setImportPreview(null); setImportConfirmed(false); setTab('cases'); setSelectedId(null);
        if (transferRef.current) transferRef.current.open = false;
        setNotice(`已导入 ${value.imported} 条场景，全部需要重新确认。确认后作为待校准参考，日常聊天不会自动改变。`);
      }
    } catch (cause) { if (current(request)) reportError(cause); }
    finally { finish(request); }
  };
  const editDraft = (changes: Partial<CalibrationDraft>) => { setDraft(value => ({ ...value, ...changes })); setFictionalConfirmed(false); };
  const useCaseForSuggestion = (item: CalibrationCase) => {
    setDraft(copyDraft(item)); setFictionalConfirmed(false); setTab('new'); setNotice('已复制为新建议，原记录及确认历史保留。修改后重新确认虚构资料，再提交。');
  };
  useEffect(() => { onBusyRef.current(!!busy || adoptionBusy || retestBusy); }, [busy, adoptionBusy, retestBusy]);
  const isLocked = disabled || !!busy || adoptionBusy || retestBusy || expired || loading;
  const selected = cases.find(item => item.id === selectedId);
  const selectedProgress = selected ? calibrationProgress(selected.status) : null;
  const confirmedCount = cases.filter(item => item.status === 'accepted').length;
  const proposedCount = cases.filter(item => item.status === 'proposed').length;
  const visibleCases = cases.filter(item => statusFilter === 'all' || item.status === statusFilter);
  const visibleSamples = samples.filter(item => sampleAge === 'all' || item.ageGroup === sampleAge);
  const tabs: { value: Tab; label: string }[] = onAdjustCase ? [{ value: 'cases', label: `我的场景 · ${cases.length}` }, { value: 'samples', label: '儿童示例' }] : [{ value: 'samples', label: '儿童示例' }, { value: 'new', label: '提交调整建议' }, { value: 'cases', label: `记录库 · ${cases.length}` }];

  return <section className="calibration-library" aria-labelledby="calibration-library-title">
    <div className="calibration-heading"><div><span className="eyebrow">先接住孩子，再一起校准</span><h3 id="calibration-library-title">{onAdjustCase ? '我的回答场景库' : '儿童人感调优库'}</h3></div><BookOpen size={23}/></div>
    <p className="calibration-intro">{onAdjustCase ? '满意的接法留在这里，想换个方向时可以继续调整。' : '从示例开始，或记录一条不满意的回复；试答满意后，再确认保存。'}</p>
    {error ? <p className="error-note" role="alert">{error}</p> : null}
    {notice ? <p className="success-note" role="status"><Check size={17}/>{notice}</p> : null}
    {!expired ? <>
      <div className="calibration-adoption" aria-label="场景采用进度">
        <strong>{loading ? '正在读取场景状态…' : `${confirmedCount} 条满意参考 · ${proposedCount} 条待你确认`}</strong>
        <p className="helper">保存场景不会自动改变日常聊天。</p>
        <details className="calibration-formal-state"><summary>保存后怎样采用？</summary>
          <ol className="calibration-adoption-steps"><li><b>① 先试答</b><span>只改变这次测试回答</span></li><li><b>② 满意存场景</b><span>留作校准参考</span></li><li><b>③ 比较接话方向</b><span>看看不同场景的回答</span></li><li><b>④ 确认采用</b><span>限定范围生效，可撤回</span></li></ol>
          <p>{debug ? '这里是共享内测库，同密码使用者可查看。' : '这里是本家庭的私有库，仅本家庭家长可查看。'}最多 200 条，保留至主动删除{debug ? '。' : '或家庭撤回。'}保存不会训练模型，也不会把场景自动发到其他家庭。</p>
          {workflow ? <><p>当前宝妍规则：{workflow.formalPersonaVersion}。保存的场景仍是参考，明确比较并采用的接话方向才会生效。</p><p>选择已确认的场景，展开“让这个方向用于以后的聊天”，可查看采用状态。确认参考或导入文件都不会自动启用。</p>{workflow.formalModel ? <p className="helper">当前回复模型：{workflow.formalModel}</p> : null}</> : <p className="helper">{loading ? '正在读取当前正式版本…' : '暂时没有读到正式版本信息，请刷新核对；不根据场景里的旧版本判断。'}</p>}
          {samplesVersion ? <p className="helper">儿童示例为虚构接话样本，不要求逐字背诵。样本版本：{samplesVersion}</p> : null}
        </details>
      </div>
      <nav className="calibration-tabs" aria-label="调优库栏目">{tabs.map(item => <button key={item.value} className={tab === item.value ? 'selected' : ''} disabled={disabled || !!busy || adoptionBusy || retestBusy} aria-current={tab === item.value ? 'page' : undefined} onClick={() => { setTab(item.value); setError(''); setNotice(''); }}>{item.label}</button>)}</nav>
      {loading ? <p className="muted" role="status">正在读取儿童示例与{debug ? '内测场景' : '本家庭调优'}记录…</p> : null}
      <div className="calibration-toolbar"><span className="helper">{debug ? '共享内测场景' : '仅本家庭家长可见'}</span><button type="button" className="text-button" disabled={isLocked} onClick={() => void refresh()}><RefreshCw size={15}/>刷新</button></div>
      {tab === 'samples' ? <div className="calibration-samples">
        <p className="helper">挑一个接近的场景，试试你希望的回答方向。</p>
        <label className="field calibration-filter">模拟年龄<select value={sampleAge} disabled={isLocked} onChange={event => setSampleAge(event.target.value as PromptLabAge | 'all')}><option value="all">全部儿童样本</option><option value="3-5">3–5 岁</option><option value="6-8">6–8 岁</option><option value="9-12">9–12 岁</option><option value="13-14">13–14 岁</option></select></label>
        {!loading && visibleSamples.length === 0 ? <p className="prompt-lab-empty">暂无这个年龄段的样本，可以自己提交一个虚构场景。</p> : <div className="calibration-sample-list">{visibleSamples.map(sample => <details className="calibration-sample" key={sample.id}><summary><strong>{sample.title}</strong><span>{sample.ageGroup} 岁 · {sample.category}</span></summary><div className="calibration-sample-body"><p className="calibration-copy"><strong>孩子说：</strong>{sample.question}</p>{sample.testHistory.length ? <details className="calibration-context"><summary>查看这次虚构前文</summary>{sample.testHistory.map((message, index) => <p className="calibration-copy" key={index}><strong>{message.role === 'user' ? '孩子' : '宝妍'}：</strong>{message.content}</p>)}</details> : null}<div className="calibration-ideal"><strong>可以这样接</strong><p>{sample.expectedReply}</p></div><p className="calibration-copy"><strong>为什么：</strong>{sample.guideline}</p><p className="calibration-copy"><strong>不希望：</strong>{sample.avoid.join('；')}</p><button type="button" className="button secondary" disabled={isLocked || !onAdjustCase} onClick={() => onAdjustCase?.({ ...sample, actualReply: '', sourceSampleId: sample.id })}>从这个示例试着回答</button></div></details>)}</div>}
      </div> : null}
      {tab === 'new' ? <div className="calibration-new" ref={formRef}>
        <h4>这条回复，你希望怎样接？</h4><p className="helper">这里只保存主动提交的脱敏或虚构测试例，不自动收集整段聊天。保存后需要你确认，开发校准时可以复用。</p>
        <form onSubmit={event => { event.preventDefault(); void create(); }}>
          <div className="calibration-form-grid"><label className="field">记录标题<input maxLength={80} value={draft.title ?? ''} disabled={isLocked} onChange={event => editDraft({ title: event.target.value })} placeholder="例如：不想继续画画时怎么陪"/></label><label className="field">模拟年龄<select value={draft.ageGroup} disabled={isLocked} onChange={event => editDraft({ ageGroup: event.target.value as PromptLabAge })}><option value="3-5">3–5 岁</option><option value="6-8">6–8 岁</option><option value="9-12">9–12 岁</option><option value="13-14">13–14 岁</option></select></label></div>
          <label className="field">场景类别<input maxLength={40} value={draft.category ?? ''} disabled={isLocked} onChange={event => editDraft({ category: event.target.value })} placeholder="例如：分享小事、受挫安慰、自然分段"/></label>
          <label className="field">孩子想表达什么<textarea rows={3} maxLength={1200} value={draft.question} disabled={isLocked} onChange={event => editDraft({ question: event.target.value })} placeholder="替换个人细节后，保留原本想表达的意思。"/></label>
          <label className="field">需要调整的原回复（已有时填写）<textarea rows={4} maxLength={1200} value={draft.actualReply} disabled={isLocked} onChange={event => editDraft({ actualReply: event.target.value })} placeholder="已有回复时贴在这里，先删除真实姓名等信息；也可先写新的测试场景。"/></label>
          <label className="field">你希望宝妍怎么回复<textarea rows={4} maxLength={1200} value={draft.expectedReply ?? ''} disabled={isLocked} onChange={event => editDraft({ expectedReply: event.target.value })} placeholder="可以写一个自然接法。需要分段时，空一行即可。"/></label>
          <div className="calibration-issue-options" aria-label="常见调整方向">{['少说教，先回应孩子的具体内容', '情绪更自然，不机械复述', '减少连续追问', '分段自然，不把一句话切碎'].map(text => <button type="button" disabled={isLocked} key={text} onClick={() => editDraft({ guideline: [draft.guideline?.trim(), text].filter(Boolean).join('\n').slice(0, 1000) })}>{text}</button>)}</div>
          <label className="field">调整建议或理由<textarea rows={3} maxLength={1000} value={draft.guideline ?? ''} disabled={isLocked} onChange={event => editDraft({ guideline: event.target.value })} placeholder="例如：只是分享画画，不需要教育；先接住‘画了很久’这个具体细节。"/></label>
          <label className="field">补充说明（选填）<textarea rows={2} maxLength={1000} value={draft.note ?? ''} disabled={isLocked} onChange={event => editDraft({ note: event.target.value })} placeholder="哪里让你觉得不自然？你对孩子当时情绪的理解是什么？"/></label>
          {draft.testHistory?.length || draft.testMemories?.length || draft.model ? <details className="calibration-context"><summary>这次比较附带的测试背景与版本</summary>{draft.model ? <p className="helper">原模型：{draft.model} · 人设：{draft.personaVersion || '未记录'}</p> : null}{draft.testHistory?.map((message, index) => <p className="calibration-copy" key={index}><strong>{message.role === 'user' ? '虚构用户' : '宝妍'}：</strong>{message.content}</p>)}{draft.testMemories?.map(memory => <p className="calibration-copy" key={memory.key}><strong>测试记忆：</strong>{memory.content}</p>)}<p className="helper">测试背景也会随记录保存。需要改背景时，请先到“改回答”里调整，再保存新建议。</p></details> : null}
          {draft.comparison ? <ComparisonSnapshot snapshot={draft.comparison}/> : null}
          <label className="check-row calibration-fictional"><input type="checkbox" checked={fictionalConfirmed} disabled={isLocked} onChange={event => setFictionalConfirmed(event.target.checked)}/><span>我已把上述内容及测试背景改成虚构或脱敏示例，不含真实儿童、姓名、学校、联系方式等家庭隐私，并同意保存到{debug ? '同密码使用者可见的内测场景库' : '本家庭调优库'}。</span></label>
          <div className="inline-actions"><button type="submit" className="button primary" disabled={isLocked || !fictionalConfirmed}><FilePlus2 size={17}/>{busy === 'create' ? '正在提交…' : '保存建议，稍后确认'}</button><button type="button" className="button ghost" disabled={isLocked} onClick={() => { setDraft(emptyDraft()); setFictionalConfirmed(false); setNotice('已清空编辑草稿，未删除已提交记录。'); }}>清空草稿</button></div>
        </form>
      </div> : null}
      {tab === 'cases' ? <div className="calibration-cases">
        <SceneRetest cases={cases} apiBase={apiBase} childId={childId} disabled={disabled || !!busy || adoptionBusy || expired || loading} onBusyChange={setRetestBusy} onAuthorizationExpired={() => expire()}/>
        <label className="field calibration-filter">记录状态<select value={statusFilter} disabled={isLocked} onChange={event => { setStatusFilter(event.target.value as CalibrationStatus | 'all'); setSelectedId(null); setDeleteId(null); }}><option value="all">全部记录</option><option value="proposed">待你确认</option><option value="accepted">已确认的参考</option><option value="rejected">暂不采用</option></select></label>
        {!loading && visibleCases.length === 0 ? <p className="prompt-lab-empty">还没有这个状态的场景。先在“改回答”里试一次，满意后保存。</p> : <ul className="calibration-case-list">{visibleCases.map(item => <li key={item.id}><button type="button" className={selectedId === item.id ? 'selected' : ''} disabled={isLocked} onClick={() => { setSelectedId(selectedId === item.id ? null : item.id); setReviewNote(''); setDeleteId(null); }}><strong>{item.title}</strong><span>{item.ageGroup} 岁 · {item.category}</span><small className={`calibration-status status-${item.status}`}>{calibrationStatusLabels[item.status]}</small></button></li>)}</ul>}
        {selected ? <article className="calibration-case-detail"><h4>{selected.title}</h4><p className="helper">{calibrationStatusLabels[selected.status]} · 记录修订 {selected.revision} · 更新于 {dateLabel(selected.updatedAt)}</p>{selectedProgress ? <div className="calibration-case-progress"><strong>{selected.status === 'accepted' ? '满意场景已保存' : selectedProgress.title}</strong><small>保存仍是参考，实际采用状态见下方。</small><details className="calibration-formal-state"><summary>查看采用详情</summary><p>{selected.status === 'accepted' ? '保存不会自动改变聊天。是否已采用，请查看下方实际状态。' : selectedProgress.detail}</p><p><b>接下来：</b>{selectedProgress.next}</p></details></div> : null}<p className="calibration-copy"><strong>测试问题：</strong>{selected.question}</p><div className="calibration-old-reply"><strong>原回复</strong><p>{selected.actualReply || '这条场景没有提供原回答。'}</p></div>{selected.expectedReply ? <div className="calibration-ideal"><strong>{selected.rewrite ? '确认过的新回答' : '期望接法'}</strong><p>{selected.expectedReply}</p></div> : null}{selected.guideline ? <p className="calibration-copy"><strong>调整建议：</strong>{selected.guideline}</p> : null}{selected.note ? <p className="calibration-copy"><strong>补充：</strong>{selected.note}</p> : null}<details className="calibration-context"><summary>这次回答的补充信息</summary><p className="helper">这里可以查看当时补充的对话和背景。</p>
          {selected.testHistory.length || selected.testMemories.length ? <details className="calibration-context"><summary>当时补充的对话和背景</summary>{selected.testHistory.map((message, index) => <p className="calibration-copy" key={index}><strong>{message.role === 'user' ? '虚构用户' : '宝妍'}：</strong>{message.content}</p>)}{selected.testMemories.map(memory => <p className="calibration-copy" key={memory.key}><strong>测试记忆：</strong>{memory.content}</p>)}</details> : null}
          {selected.rewrite ? <p className="helper">{selected.rewrite.provenance === 'server-generated' ? (debug ? '在内测调试生成并确认' : '在本应用生成并由家长确认') : '由文件导入，生成来源未核实'} · 确认于 {dateLabel(selected.rewrite.confirmedAt)}。{selected.rewrite.actualReplySource === 'user-provided' ? '原回答由你提供。' : '本场景未提供原回答。'}</p> : null}
          </details>
          {selected.status === 'accepted' ? <SceneAdoption key={`${selected.id}:${selected.revision}`} item={selected} apiBase={apiBase} childId={childId} disabled={disabled || !!busy || retestBusy || expired || loading} onBusyChange={setAdoptionBusy} onAuthorizationExpired={() => expire()} onApplied={onAdoptionChange}/> : null}
          {selected.comparison ? <ComparisonSnapshot snapshot={selected.comparison}/> : null}
          <div className="inline-actions">{onAdjustCase ? <button type="button" className="button primary" disabled={isLocked} onClick={() => onAdjustCase(copyDraft(selected))}>按新方向调整</button> : <button type="button" className="button secondary" disabled={isLocked} onClick={() => useCaseForSuggestion(selected)}>修改成一条新建议</button>}</div>
          <details className="calibration-context" open={onAdjustCase ? undefined : true}><summary>确认或撤回这条参考</summary>
          <form className="calibration-review" onSubmit={event => { event.preventDefault(); void review(selected, 'accepted'); }}><h5>确认这条接法作为参考</h5><p className="helper">确认只表示你认可这个方向，不会直接修改日常聊天。下一步可以比较并采用接话方向。撤回参考会同时停用由它采用的方向。</p><label className="field">确认说明（选填）<textarea rows={2} maxLength={1000} value={reviewNote} disabled={isLocked} onChange={event => setReviewNote(event.target.value)} placeholder="你为什么认可，或还需要改哪里？"/></label><div className="inline-actions"><button type="submit" className="button primary" disabled={isLocked || selected.status === 'accepted'}><Check size={17}/>确认这条参考</button><button type="button" className="button secondary" disabled={isLocked || selected.status === 'rejected'} onClick={() => void review(selected, 'rejected')}>暂不采用</button>{selected.status !== 'proposed' ? <button type="button" className="button ghost" disabled={isLocked} onClick={() => void review(selected, 'proposed')}>撤回确认</button> : null}</div></form>
          {selected.reviewHistory.length ? <details className="calibration-context"><summary>确认记录 · {selected.reviewHistory.length}</summary>{selected.reviewHistory.map((item, index) => <p className="calibration-copy" key={`${index}-${item.date}`}><strong>{calibrationStatusLabels[item.status] ?? item.status}：</strong>{item.note || '未填写说明'}<small> · {dateLabel(item.date)}</small></p>)}</details> : null}
          {selected.importedFrom ? <details className="calibration-context"><summary>导入前的确认来源</summary><p className="helper">导入于 {dateLabel(selected.importedFrom.importedAt)}，来源状态：{selected.importedFrom.status ? calibrationStatusLabels[selected.importedFrom.status] : '未记录'}；导入后的确认单独记录。</p>{selected.importedFrom.reviewNote ? <p className="calibration-copy">{selected.importedFrom.reviewNote}</p> : null}{selected.importedFrom.reviewHistory.map((item, index) => <p className="calibration-copy" key={`${index}-${item.date}`}><strong>{calibrationStatusLabels[item.status]}：</strong>{item.note || '未填写说明'}<small> · {dateLabel(item.date)}</small></p>)}</details> : null}
          {selected.importHistory?.length ? <details className="calibration-context"><summary>更早的迁移来源 · {selected.importHistory.length}</summary>{selected.importHistory.map((source, index) => <div className="calibration-import-source" key={`${index}-${source.importedAt}`}><p className="helper">来源 {index + 1} · {dateLabel(source.importedAt)} · {source.status ? calibrationStatusLabels[source.status] : '未记录状态'}</p>{source.reviewNote ? <p className="calibration-copy">{source.reviewNote}</p> : null}{source.reviewHistory.map((item, at) => <p className="calibration-copy" key={`${at}-${item.date}`}><strong>{calibrationStatusLabels[item.status]}：</strong>{item.note || '未填写说明'}<small> · {dateLabel(item.date)}</small></p>)}</div>)}</details> : null}
          </details>
          <button type="button" className="text-button calibration-delete" disabled={isLocked} onClick={() => setDeleteId(selected.id)}><Trash2 size={15}/>删除这条记录</button>{deleteId === selected.id ? <div className="inline-confirm"><p>删除这条建议、比较和确认历史？由它采用的方向也会停用。已导出的本地文件仍由你保管。</p><div className="inline-actions"><button type="button" className="button danger" disabled={isLocked} onClick={() => void deleteCase(selected)}>{busy === 'delete' ? '正在删除…' : '确认删除'}</button><button type="button" className="button ghost" disabled={isLocked} onClick={() => setDeleteId(null)}>保留记录</button></div></div> : null}
        </article> : null}
      </div> : null}
      <details className="calibration-more" ref={transferRef}><summary>更多 · 备份与迁移</summary><div className="calibration-transfer"><h4>保存或导入场景文件</h4><p className="helper">把问题、原回答、调整方向和满意答案保存成文件，以后换模型时还能继续使用。打开已有文件后，请重新确认里面的场景。</p><button type="button" className="button secondary" disabled={isLocked} onClick={() => void exportCases()}><Download size={17}/>{busy === 'export' ? '正在导出…' : '保存场景文件'}</button>{exportParts.length ? <div className="calibration-export-parts"><p className="helper">请分别下载全部文件，妥善保存。以后可逐份导入。</p><div className="inline-actions">{exportParts.map((part, index) => <button type="button" key={index} className="button secondary" disabled={isLocked} onClick={() => downloadPart(part, index, exportParts.length)}><Download size={16}/>下载{exportParts.length > 1 ? `第 ${index + 1} / ${exportParts.length} 卷` : '记录文件'} · {part.cases.length} 条</button>)}</div></div> : null}<label className="field calibration-import-label"><span><Upload size={16}/>打开场景文件</span><input type="file" accept="application/json,.json" disabled={isLocked} onChange={event => { void readImportFile(event.target.files?.[0]); event.target.value = ''; }}/></label><p className="helper">选择文件只在本机预览，确认后才会上传。请先核对不含真实个人资料。</p><details className="calibration-context"><summary>文件大小与分卷说明</summary><p className="helper">每次 1–{calibrationImportCaseLimit} 条、文件不超过 2 MiB，可分批导入。导出的每卷约 1.8 MiB 以内；每次导入单独保存，导入后都需要重新确认，不能直接改变正式回复。</p></details>
        {importPreview ? <div className="calibration-import-preview"><strong>{importPreview.filename}</strong><p>将导入 {importPreview.document.cases.length} 条，全部重新设为待确认：</p><ul>{importPreview.document.cases.map((item, index) => <li key={index}>{item.title} · {item.ageGroup} 岁{item.model ? ` · 原模型 ${item.model}` : ''}</li>)}</ul><label className="check-row"><input type="checkbox" checked={importConfirmed} disabled={isLocked} onChange={event => setImportConfirmed(event.target.checked)}/><span>我已核对整份文件，均为虚构或脱敏测试内容，不含真实儿童和家庭隐私，同意导入{debug ? '同密码使用者可见的内测场景库' : '本家庭记录库'}。</span></label><div className="inline-actions"><button type="button" className="button primary" disabled={isLocked || !importConfirmed} onClick={() => void importCases()}><Upload size={17}/>{busy === 'import' ? '正在导入…' : '存入场景库，稍后确认'}</button><button type="button" className="button ghost" disabled={isLocked} onClick={() => { ++fileGeneration.current; setImportPreview(null); setImportConfirmed(false); }}>取消导入</button></div></div> : null}
      </div></details>
    </> : null}
  </section>;
}
