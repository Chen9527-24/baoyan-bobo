import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, CheckCircle2, RefreshCw, Smartphone } from 'lucide-react';
import { messageOf } from '../lib/api';
import {
  PHONE_ENVIRONMENT_LABELS, PHONE_EXPERIENCE_ENVIRONMENTS, PHONE_EXPERIENCE_SCORE_KEYS,
  PHONE_SCORE_LABELS, PHONE_TAG_LABELS, phoneExperienceProgress, preparePhoneExperienceDraft, phoneExperienceScopeInvalid,
  PHONE_OBSERVATION_RESULTS, PHONE_OBSERVATION_STAGES, PHONE_OBSERVATION_LANGUAGES, PHONE_OBSERVATION_NETWORKS,
  PHONE_OBSERVATION_RESULT_LABELS, PHONE_OBSERVATION_STAGE_LABELS, PHONE_OBSERVATION_LANGUAGE_LABELS, PHONE_OBSERVATION_NETWORK_LABELS,
  type PhoneExperienceDraft, type PhoneExperienceEnvironment, type PhoneExperienceScores, type PhoneExperienceState, type PhoneExperienceObservation,
} from '../lib/phoneExperience';

export interface PhoneExperiencePanelProps {
  contextKey: string;
  onLoad: (signal: AbortSignal) => Promise<PhoneExperienceState>;
  onSubmit: (draft: PhoneExperienceDraft, signal: AbortSignal) => Promise<PhoneExperienceState>;
  onDelete: (id: string, signal: AbortSignal) => Promise<PhoneExperienceState>;
  onBusyChange?: (busy: boolean) => void;
}
const emptyScores = (): PhoneExperienceScores => ({ voiceClarity: 0, voiceFeeling: 0, replyNaturalness: 0, continuity: 0, overall: 0 });
const emptyObservation = (): PhoneExperienceObservation => ({ result: 'uncertain', stages: [], language: 'uncertain', intendedMeaning: '', recognizedText: '', deviceModel: '', network: 'uncertain' });
const DAY_TASKS = [
  { title: '今天：说一句，听一句', text: '用平时说的语言讲一件虚构小事。看看页面文字对不对、宝妍有没有听懂，再听声音是否自然。' },
  { title: '隔天：接住前文', text: '用同一份虚构资料，继续昨天的话题。记忆接错时直接纠正，看看她能否接回来。' },
  { title: '再隔天：像日常聊天', text: '换个话题、开个玩笑，试着说“先听我说”或“短一点”，观察有没有明显套话和追问。' },
];

export function PhoneExperiencePanel({ contextKey, onLoad, onSubmit, onDelete, onBusyChange }: PhoneExperiencePanelProps) {
  const [data, setData] = useState<PhoneExperienceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [environment, setEnvironment] = useState<PhoneExperienceEnvironment | ''>('');
  const [observation, setObservation] = useState<PhoneExperienceObservation>(emptyObservation);
  const [note, setNote] = useState('');
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [phoneConfirmed, setPhoneConfirmed] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const attempt = useRef<{ signature: string; operationId: string } | null>(null);
  const scopeLocked = useRef(false);
  const callbacks = useRef({ onLoad, onSubmit, onDelete, onBusyChange });
  callbacks.current = { onLoad, onSubmit, onDelete, onBusyChange };
  const discardSensitiveState = useCallback(() => {
    setData(null); setObservation(emptyObservation()); setEnvironment(''); setNote(''); setAdultConfirmed(false); setPhoneConfirmed(false); setNotice(''); setDeleting(null); attempt.current = null;
  }, []);
  const rejectExpiredScope = useCallback((failure: unknown) => {
    if (!phoneExperienceScopeInvalid(failure)) return false;
    scopeLocked.current = true; setLocked(true);
    ++generation.current; request.current?.abort(); request.current = null;
    discardSensitiveState(); setBusy(false);
    setError('家长授权或孩子资料已变化，本页记录和未提交内容已清除。请退出后重新进入家长管理。');
    return true;
  }, [discardSensitiveState]);
  const load = useCallback(async () => {
    if (scopeLocked.current || request.current) return;
    const controller = new AbortController(); request.current = controller; const epoch = ++generation.current;
    const current = () => mounted.current && epoch === generation.current && !controller.signal.aborted;
    setBusy(true); setError('');
    try { const result = await callbacks.current.onLoad(controller.signal); if (current()) setData(result); }
    catch (failure) { if (current() && !rejectExpiredScope(failure)) setError(messageOf(failure)); }
    finally { if (current()) { request.current = null; setBusy(false); } }
  }, [rejectExpiredScope]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++generation.current; request.current?.abort(); request.current = null; callbacks.current.onBusyChange?.(false); };
  }, []);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  useEffect(() => {
    ++generation.current; request.current?.abort(); request.current = null;
    scopeLocked.current = false; setLocked(false); discardSensitiveState();
    void load();
  }, [contextKey, load, discardSensitiveState]);
  useEffect(() => {
    const leave = () => { ++generation.current; request.current?.abort(); request.current = null; setBusy(false); };
    window.addEventListener('pagehide', leave); window.addEventListener('offline', leave);
    return () => { window.removeEventListener('pagehide', leave); window.removeEventListener('offline', leave); };
  }, []);
  const submit = async () => {
    if (scopeLocked.current || !data || request.current || phoneExperienceProgress(data).todayRecorded) return;
    let draft: PhoneExperienceDraft;
    try {
      const signature = JSON.stringify({ environment, observation, note: note.trim(), adultConfirmed, phoneConfirmed });
      if (!attempt.current || attempt.current.signature !== signature) attempt.current = { signature, operationId: crypto.randomUUID() };
      draft = preparePhoneExperienceDraft({ operationId: attempt.current.operationId, environment, scores: emptyScores(), tags: [], note, observation, adultFictionalConfirmed: adultConfirmed, phoneUsedConfirmed: phoneConfirmed });
    } catch (failure) { setError(messageOf(failure)); return; }
    const controller = new AbortController(); request.current = controller; const epoch = ++generation.current;
    const current = () => mounted.current && epoch === generation.current && !controller.signal.aborted;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await callbacks.current.onSubmit(draft, controller.signal);
      if (current()) { setData(result); setNotice('今天的体验记录已保存。隔一个自然日再回来，看看聊天是否接得自然。'); attempt.current = null; }
    } catch (failure) {
      if (current() && !rejectExpiredScope(failure)) setError(failure instanceof TypeError || failure instanceof DOMException && failure.name === 'AbortError' ? '暂时无法确认是否保存，可先刷新记录查看；同样内容再提交会沿用本次编号。' : messageOf(failure));
    } finally { if (current()) { request.current = null; setBusy(false); } }
  };
  const deleteRecord = async (id: string) => {
    if (scopeLocked.current || request.current || !data?.records.some(record => record.id === id)) return;
    const controller = new AbortController(); request.current = controller; const epoch = ++generation.current;
    const current = () => mounted.current && epoch === generation.current && !controller.signal.aborted;
    setBusy(true); setError(''); setNotice('');
    try { const result = await callbacks.current.onDelete(id, controller.signal); if (current()) { setData(result); setDeleting(null); setNotice('这条体验记录已删除。'); } }
    catch (failure) { if (current() && !rejectExpiredScope(failure)) setError(messageOf(failure)); }
    finally { if (current()) { request.current = null; setBusy(false); } }
  };
  const progress = data ? phoneExperienceProgress(data) : null;
  const canSubmit = !!data && !busy && !progress?.todayRecorded && adultConfirmed && phoneConfirmed && !!environment && (observation.result !== 'problem' || observation.stages.length > 0);
  return <section className="phone-experience-panel" aria-label="手机与方言体验">
    <div className="panel-title"><div><span className="eyebrow">哪里不顺，就记在哪里</span><h2>手机与方言体验</h2></div><Smartphone size={26}/></div>
    <p className="helper">请成年人用虚构资料在真实手机上体验。不用打分：选一下哪里出了问题，再自愿补一句。这里只保存你主动填写的内容，不附带整段聊天、原音或手机标识。</p>
    <div className="phone-experience-plan">{DAY_TASKS.map((day, index) => <article key={day.title} className={progress && index < progress.completed ? 'recorded' : ''}><strong><CalendarDays size={16}/>{day.title}</strong><p>{day.text}</p></article>)}</div>
    {error ? <p className="error-note" role="alert">{error}</p> : null}
    {notice ? <p className="success-note" role="status">{notice}</p> : null}
    {!data ? <p role="status">{locked ? '请重新进入家长管理后再查看。' : busy ? '正在查看体验记录…' : '暂未取得体验记录。'}</p> : <>
      <div className="phone-experience-progress"><strong>已记录 {progress!.completed} / 3 个自然日</strong><span>{data.today} · 按北京时间分日</span></div>
      {progress!.allDaysRecorded ? <p className="phone-experience-status"><CheckCircle2 size={18}/>三天记录已齐，仍需开发者结合反馈校准；这不代表自然度验收自动通过。</p> : null}
      {progress!.todayRecorded ? <p className="phone-experience-status"><CheckCircle2 size={18}/>今天已记录，请隔天再来。同一天重复记录不会多算一天。</p> : <form className="phone-experience-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="field">实际使用的手机浏览器<select value={environment} disabled={busy} onChange={event => setEnvironment(event.target.value as PhoneExperienceEnvironment)}><option value="">请选择</option>{PHONE_EXPERIENCE_ENVIRONMENTS.map(value => <option value={value} key={value}>{PHONE_ENVIRONMENT_LABELS[value]}</option>)}</select></label>
        <fieldset className="phone-experience-options" disabled={busy}><legend>今天聊得怎么样</legend>{PHONE_OBSERVATION_RESULTS.map(result => <label key={result} className={observation.result === result ? 'selected' : ''}><input type="radio" name="phone-observation-result" checked={observation.result === result} onChange={() => setObservation(old => ({ ...old, result, stages: result === 'smooth' ? [] : old.stages }))}/><span>{PHONE_OBSERVATION_RESULT_LABELS[result]}</span></label>)}</fieldset>
        {observation.result !== 'smooth' ? <fieldset className="phone-experience-options" disabled={busy}><legend>哪里不顺 <span>最多 4 个；说不准可不选</span></legend>{PHONE_OBSERVATION_STAGES.map(stage => <label key={stage} className={observation.stages.includes(stage) ? 'selected' : ''}><input type="checkbox" checked={observation.stages.includes(stage)} disabled={!observation.stages.includes(stage) && observation.stages.length >= 4} onChange={event => setObservation(old => ({ ...old, stages: event.target.checked ? [...old.stages, stage] : old.stages.filter(value => value !== stage) }))}/><span>{PHONE_OBSERVATION_STAGE_LABELS[stage]}</span></label>)}</fieldset> : null}
        <label className="field">实际说的语言<select value={observation.language} disabled={busy} onChange={event => setObservation(old => ({ ...old, language: event.target.value as PhoneExperienceObservation['language'] }))}>{PHONE_OBSERVATION_LANGUAGES.map(language => <option key={language} value={language}>{PHONE_OBSERVATION_LANGUAGE_LABELS[language]}</option>)}</select></label>
        <details className="phone-experience-detail"><summary>补充现场，方便找到问题（选填）</summary>
          <p className="helper">填一小句就好，请去掉真实姓名、地址等信息。选择语言只用于记录这次体验，不会改变聊天识别模式。</p>
          <label className="field">我原本想说的意思 <span>最多 200 字</span><input type="text" value={observation.intendedMeaning} maxLength={200} disabled={busy} onChange={event => setObservation(old => ({ ...old, intendedMeaning: event.target.value }))} placeholder="例如：晚上十点回来，不是八点。"/></label>
          <label className="field">页面显示的那一小句 <span>最多 200 字</span><input type="text" value={observation.recognizedText} maxLength={200} disabled={busy} onChange={event => setObservation(old => ({ ...old, recognizedText: event.target.value }))} placeholder="可以只写听错的几个字"/></label>
          <label className="field">手机型号 <span>最多 60 字，不填也可以</span><input type="text" value={observation.deviceModel} maxLength={60} disabled={busy} onChange={event => setObservation(old => ({ ...old, deviceModel: event.target.value }))} placeholder="例如：iPhone 15，不填写序列号"/></label>
          <label className="field">当时的网络<select value={observation.network} disabled={busy} onChange={event => setObservation(old => ({ ...old, network: event.target.value as PhoneExperienceObservation['network'] }))}>{PHONE_OBSERVATION_NETWORKS.map(network => <option key={network} value={network}>{PHONE_OBSERVATION_NETWORK_LABELS[network]}</option>)}</select></label>
          <label className="field">还想补充什么 <span>最多 500 字</span><input type="text" value={note} maxLength={500} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="例如：锁屏回来没声音；重新点说话后恢复。"/></label>
        </details>
        <label className="checkbox-row phone-experience-confirm"><input type="checkbox" checked={adultConfirmed} disabled={busy} onChange={event => setAdultConfirmed(event.target.checked)}/><span>我以成年人身份，使用虚构资料体验。</span></label>
        <label className="checkbox-row phone-experience-confirm"><input type="checkbox" checked={phoneConfirmed} disabled={busy} onChange={event => setPhoneConfirmed(event.target.checked)}/><span>我确实已在上方手机浏览器尝试语音聊天，记录的是亲自遇到的情况。</span></label>
        <button type="submit" className="button primary full" disabled={!canSubmit}>{busy ? '正在保存…' : '保存今天的体验'}</button>
      </form>}
      {data.records.length ? <details className="phone-experience-records"><summary>查看已提交的体验记录（{data.records.length} 条）</summary>{data.records.map(record => <article key={record.id}><strong>{record.day} · {PHONE_ENVIRONMENT_LABELS[record.environment]}</strong>{record.observation ? <>
        <p>{PHONE_OBSERVATION_RESULT_LABELS[record.observation.result]} · {PHONE_OBSERVATION_LANGUAGE_LABELS[record.observation.language]}</p>
        {record.observation.stages.length ? <p>{record.observation.stages.map(stage => PHONE_OBSERVATION_STAGE_LABELS[stage]).join('、')}</p> : null}
        {record.observation.intendedMeaning ? <p>原意：{record.observation.intendedMeaning}</p> : null}{record.observation.recognizedText ? <p>页面文字：{record.observation.recognizedText}</p> : null}
        {record.observation.deviceModel ? <p>手机：{record.observation.deviceModel}</p> : null}{record.observation.network !== 'uncertain' ? <p>网络：{PHONE_OBSERVATION_NETWORK_LABELS[record.observation.network]}</p> : null}
      </> : <details><summary>查看早期体验记录</summary><p>{PHONE_EXPERIENCE_SCORE_KEYS.map(key => `${PHONE_SCORE_LABELS[key]}：${record.scores[key] || '未体验'}`).join(' / ')}</p></details>}{record.tags.length ? <p>{record.tags.map(tag => PHONE_TAG_LABELS[tag]).join('、')}</p> : null}{record.note ? <p className="phone-experience-note">{record.note}</p> : null}{deleting === record.id ? <div className="phone-experience-delete"><p>确认删除这条记录？日期计数会随之更新。</p><button type="button" className="button danger small" disabled={busy} onClick={() => void deleteRecord(record.id)}>确认删除</button><button type="button" className="button ghost small" disabled={busy} onClick={() => setDeleting(null)}>保留</button></div> : <button type="button" className="text-button" disabled={busy} onClick={() => setDeleting(record.id)}>删除这条记录</button>}</article>)}</details> : null}
    </>}
    <button type="button" className="button secondary small" disabled={busy || locked} onClick={() => void load()}><RefreshCw size={16}/>刷新记录</button>
    <p className="helper">体验记录最长保留 30 天，随家庭资料撤回删除。一天一条；日期由服务端记录，不会把模拟时间算成真人多日体验。</p>
  </section>;
}
