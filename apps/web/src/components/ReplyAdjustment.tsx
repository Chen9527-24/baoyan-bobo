import { useEffect, useRef, useState } from 'react';
import { Check, MessageCircle, Plus, Sparkles, Square, Trash2 } from 'lucide-react';
import { ApiError, api as baseApi, messageOf, operationId } from '../lib/api';
import type { CalibrationCase, CalibrationDraft } from '../lib/calibration';
import { promptLabAuthorizationExpired, type PromptLabAge, type PromptLabConfig } from '../lib/promptLab';
import { prepareReplyAdjustment, replyAdjustmentConfirmation, replyAdjustmentMatches,
  type ReplyAdjustmentConfirmation, type ReplyAdjustmentRun } from '../lib/replyAdjustment';
import './ReplyAdjustment.css';

const blank = (): CalibrationDraft => ({ question: '', actualReply: '', ageGroup: '6-8', guideline: '', testHistory: [], testMemories: [] });
const copy = (draft?: CalibrationDraft): CalibrationDraft => draft ? { ...draft,
  testHistory: (draft.testHistory ?? []).map(item => ({ ...item })), testMemories: (draft.testMemories ?? []).map(item => ({ ...item })) } : blank();
type Pending = { controller: AbortController; kind: 'generate' | 'confirm'; operationId: string };

export function ReplyAdjustment({ initialDraft, childId, onBusyChange, onAuthorizationExpired, onSaved, onDraftChange, apiBase = '/parent/reply-adjustment', configPath = '/parent/prompt-lab?ageGroup=6-8', scope = 'family', onPreview, previewBusy = false }: {
  apiBase?: '/parent/reply-adjustment' | '/debug/reply-adjustment';
  configPath?: '/parent/prompt-lab?ageGroup=6-8' | '/debug/config';
  scope?: 'family' | 'debug';
  onPreview?: (run: ReplyAdjustmentRun) => void;
  previewBusy?: boolean;
  initialDraft?: CalibrationDraft;
  childId: string;
  onBusyChange: (value: boolean) => void;
  onAuthorizationExpired: () => void;
  onSaved: (item: CalibrationCase) => void;
  onDraftChange: (draft: CalibrationDraft) => void;
}) {
  const api = <T,>(path: string, options: RequestInit = {}) => baseApi<T>(path.replace('/parent/reply-adjustment', apiBase), options);
  const [draft, setDraft] = useState(() => copy(initialDraft));
  const [confirmed, setConfirmed] = useState(false);
  const [run, setRun] = useState<ReplyAdjustmentRun | null>(null);
  const [saved, setSaved] = useState<CalibrationCase | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<Pending['kind'] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const mounted = useRef(false);
  const uncertainRef = useRef(false);
  const pending = useRef<Pending | null>(null);
  const confirmation = useRef<ReplyAdjustmentConfirmation | null>(null);
  const generation = useRef(0);
  const runRef = useRef(run); runRef.current = run;
  const onBusyRef = useRef(onBusyChange); onBusyRef.current = onBusyChange;
  const onExpiredRef = useRef(onAuthorizationExpired); onExpiredRef.current = onAuthorizationExpired;
  const headers = { 'X-Baoyan-Child': childId };
  const cancelRun = (id: string) => api(`/parent/reply-adjustment/generate/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', body: '{}', keepalive: true, headers,
  }).catch(() => undefined);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<PromptLabConfig>(configPath, { signal: controller.signal }).then(value => {
      if (mounted.current && !controller.signal.aborted) setAvailable(value.configured);
    }).catch(cause => {
      if (!mounted.current || controller.signal.aborted) return;
      if (promptLabAuthorizationExpired(cause)) onExpiredRef.current();
      else { setAvailable(false); setError(messageOf(cause)); }
    });
    return () => {
      mounted.current = false; ++generation.current; controller.abort();
      const active = pending.current; pending.current = null; active?.controller.abort();
      if (active?.kind === 'generate') void cancelRun(active.operationId);
      if (runRef.current) void cancelRun(runRef.current.operationId);
      confirmation.current = null; onBusyRef.current(false);
    };
  }, [childId, apiBase, configPath]);
  const report = (cause: unknown) => {
    if (promptLabAuthorizationExpired(cause) || (cause instanceof ApiError && cause.code === 'REPLY_ADJUSTMENT_CHILD_CHANGED')) {
      setDraft(blank()); setRun(null); setSaved(null); setConfirmed(false); confirmation.current = null;
      uncertainRef.current = false; setSaveUncertain(false); onExpiredRef.current(); return;
    }
    setError(messageOf(cause));
  };
  const edit = (changes: Partial<CalibrationDraft>) => {
    if (pending.current || saveUncertain) return;
    ++generation.current;
    const next = { ...draft, ...changes }; setDraft(next); onDraftChange(next);
    if (run) void cancelRun(run.operationId);
    setRun(null); setSaved(null); setTitle(''); confirmation.current = null;
    setConfirmed(false); setError(''); setNotice('');
  };
  const begin = (kind: Pending['kind'], id: string) => {
    if (pending.current || !mounted.current) return null;
    const value: Pending = { kind, operationId: id, controller: new AbortController() };
    pending.current = value; setBusy(kind); onBusyRef.current(true); setError(''); setNotice(''); return value;
  };
  const current = (request: Pending) => mounted.current && pending.current === request && !request.controller.signal.aborted;
  const finish = (request: Pending) => {
    if (pending.current !== request) return;
    pending.current = null;
    if (mounted.current) { setBusy(null); onBusyRef.current(uncertainRef.current); }
  };
  const generate = async () => {
    if (!available || pending.current || saveUncertain) return;
    let input;
    try { input = prepareReplyAdjustment(draft, confirmed); }
    catch (cause) { report(cause); return; }
    const request = begin('generate', operationId()); if (!request) return;
    const token = ++generation.current;
    if (run) void cancelRun(run.operationId);
    setRun(null); setSaved(null); confirmation.current = null;
    try {
      const value = await api<ReplyAdjustmentRun>('/parent/reply-adjustment/generate', {
        method: 'POST', headers, body: JSON.stringify({ ...input, operationId: request.operationId }), signal: request.controller.signal,
      });
      if (current(request) && token === generation.current && value.operationId === request.operationId && replyAdjustmentMatches(value, draft, confirmed)) {
        setRun(value); setTitle(draft.title && draft.title !== '聊天回复调整' ? draft.title : value.question.slice(0, 40));
        setNotice('先看看这次回答。还不合适就修改方向；满意后再保存。');
      }
    } catch (cause) {
      if (current(request)) { report(cause); void cancelRun(request.operationId); }
    } finally { finish(request); }
  };
  const cancel = () => {
    const request = pending.current;
    if (!request || request.kind !== 'generate') return;
    ++generation.current; request.controller.abort(); pending.current = null;
    void cancelRun(request.operationId); setBusy(null); onBusyRef.current(false);
    setNotice('已停止这次生成，没有保存场景。');
  };
  const save = async () => {
    if (!run || saved || pending.current || !replyAdjustmentMatches(run, draft, confirmed)) return;
    let input;
    try { input = confirmation.current ?? replyAdjustmentConfirmation(run, operationId(), title); }
    catch (cause) { report(cause); return; }
    confirmation.current = input;
    const request = begin('confirm', input.operationId); if (!request) return;
    try {
      const item = await api<CalibrationCase>('/parent/reply-adjustment/confirm', {
        method: 'POST', headers, body: JSON.stringify(input), signal: request.controller.signal,
      });
      if (current(request)) { setSaved(item); uncertainRef.current = false; setSaveUncertain(false); setNotice(`已存入${scope === 'debug' ? '共享内测场景库' : '本家庭场景库'}，待后续校准；日常聊天尚未改变。`); }
    } catch (cause) {
      if (current(request)) {
        const rejected = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
        uncertainRef.current = !rejected; setSaveUncertain(!rejected);
        if (rejected) {
          confirmation.current = null;
          if (cause instanceof ApiError && cause.status === 410) { setRun(null); setNotice('这次预览已到期，请重新生成后再确认。'); }
          report(cause);
        } else setError('暂时无法确认是否保存成功。点击“核对并完成保存”会核对同一次保存，不会重复创建场景。');
      }
    } finally { finish(request); }
  };
  const locked = !!busy || saveUncertain || previewBusy;
  const example = () => edit({ question: '我搭的城堡又倒了，不想再搭了。', actualReply: '不要放弃，坚持就能成功。你要相信自己，加油！',
    guideline: '先像姐姐一样陪他失落一会儿，回应城堡倒了这件事，不要马上说教或连续追问。可以说两小段，最后让他自己决定休息还是继续。', ageGroup: '6-8', testHistory: [], testMemories: [] });

  return <section className="reply-adjustment" aria-labelledby="reply-adjustment-title">
    <div className="panel-title"><div><span className="eyebrow">把你想要的接法告诉宝妍</span><h2 id="reply-adjustment-title">这条回答，换个思路</h2></div><MessageCircle size={26}/></div>
    <ol className="reply-adjustment-steps" aria-label="本次回答调整进度"><li className="active" aria-current={!run ? 'step' : undefined}>1 说方向</li><li className={run ? 'active' : ''} aria-current={run && !saved ? 'step' : undefined}>2 试新回答</li><li className={saved ? 'active' : ''} aria-current={saved ? 'step' : undefined}>3 满意保存</li></ol>
    <div className="reply-adjustment-scope"><strong>{saved ? '已保存，还未采用' : run ? '这次试答还未保存' : '先改这一条回答'}</strong><p>{saved ? '到场景里比较并采用接话方向后，才会用于后续聊天。' : '方向只用于本次试答，满意再保存。'}</p><details className="reply-adjustment-explanation"><summary>保存后会怎样？</summary><p>保存问题、原回答、修改方向和满意的新回答，供后续校准或换模型时复用。保存不会训练模型或自动改变聊天。进入已保存的场景，选择接话方向、比较新旧回答，再确认采用；随时可以撤回。</p><p>{scope === 'debug' ? '这是共享内测场景库，同密码使用者可查看。' : '仅本家庭家长可查看保存的场景。'}</p></details></div>
    <form onSubmit={event => { event.preventDefault(); void generate(); }}>
      <div className="reply-adjustment-question"><label className="field">孩子说了什么<textarea rows={2} maxLength={1200} disabled={locked} value={draft.question} onChange={event => edit({ question: event.target.value })} placeholder="例如：我搭的城堡又倒了，不想再搭了。"/></label>
        <details className="reply-adjustment-background" open={!draft.question ? true : undefined}><summary>原回答与补充背景</summary><p className="helper">{scope === 'debug' ? '已带入本句和本次调试的前文，请先把个人细节换成虚构内容。' : '这里只带入本句问题和回答；需要前文时可以补充，请先把个人细节换成虚构内容。'}</p>
          <label className="field">需要改的原回答<textarea rows={3} maxLength={1200} disabled={locked} value={draft.actualReply} onChange={event => edit({ actualReply: event.target.value })} placeholder="贴一条让你不满意的回答，也可以留空来试一个新场景。"/></label>
          <label className="field">模拟年龄<select disabled={locked} value={draft.ageGroup} onChange={event => edit({ ageGroup: event.target.value as PromptLabAge })}><option value="3-5">3–5 岁</option><option value="6-8">6–8 岁</option><option value="9-12">9–12 岁</option><option value="13-14">13–14 岁</option></select></label>
          <p className="helper">如果这句话接着前文，按顺序补充最多 4 轮虚构对话。</p>
          {(draft.testHistory ?? []).map((message, index) => <label className="field" key={index}>{message.role === 'user' ? '孩子之前说' : '宝妍之前答'}<textarea rows={2} maxLength={600} disabled={locked} value={message.content} onChange={event => edit({ testHistory: draft.testHistory!.map((item, at) => at === index ? { ...item, content: event.target.value } : item) })}/></label>)}
          <div className="inline-actions"><button type="button" className="text-button" disabled={locked || (draft.testHistory?.length ?? 0) >= 8} onClick={() => edit({ testHistory: [...(draft.testHistory ?? []), { role: 'user', content: '' }, { role: 'assistant', content: '' }] })}><Plus size={16}/>补一轮前文</button>{draft.testHistory?.length ? <button type="button" className="text-button" disabled={locked} onClick={() => edit({ testHistory: draft.testHistory!.slice(0, -2) })}><Trash2 size={16}/>去掉最后一轮</button> : null}</div>
          {draft.testMemories?.length ? <div><p className="helper">这个场景附带的虚构背景：</p>{draft.testMemories.map(item => <p key={item.key}>{item.content}</p>)}<button type="button" className="text-button" disabled={locked} onClick={() => edit({ testMemories: [] })}>移除这些背景</button></div> : null}
        </details>
      </div>
      <label className="field reply-adjustment-direction">你希望宝妍怎样回答？<textarea rows={4} maxLength={1000} disabled={locked} value={draft.guideline ?? ''} onChange={event => edit({ guideline: event.target.value })} placeholder="例如：先陪孩子失落一会儿，不要马上讲道理；像姐姐一样说两小段，最后给一个轻松的小办法。"/></label>
      <div className="reply-adjustment-chips">{['先接住感受，别急着讲道理', '少追问，像姐姐一样自然接话', '分成两小段，先回应再给小办法'].map(text => <button type="button" key={text} disabled={locked} onClick={() => edit({ guideline: [draft.guideline?.trim(), text].filter(Boolean).join('\n').slice(0, 1000) })}>{text}</button>)}</div>
      <label className="check-row"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => { if (run) void cancelRun(run.operationId); setConfirmed(event.target.checked); setRun(null); setSaved(null); confirmation.current = null; }}/><span>我已将问题、原回答和背景改成虚构或脱敏内容，可以用于测试并保存到{scope === 'debug' ? '内测场景库（同密码使用者可见）' : '本家庭场景库'}。</span></label>
      <div className="inline-actions"><button type="submit" className="button primary" disabled={locked || !confirmed || !draft.question.trim() || !draft.guideline?.trim() || !available}><Sparkles size={18}/>{busy === 'generate' ? '正在按你的方向回答…' : run ? '再按这个方向回答' : '按我的方向试着回答'}</button>{busy === 'generate' ? <button type="button" className="button secondary" onClick={cancel}><Square size={16}/>停止</button> : <button type="button" className="text-button" disabled={locked} onClick={example}>试一个儿童示例</button>}</div>
      {available === false ? <p className="helper">暂时不能生成新回答。已有场景仍可在场景库查看、导出。</p> : null}
    </form>
    {error ? <p className="error-note" role="alert">{error}</p> : null}
    {notice ? <p className="success-note" role="status"><Check size={17}/>{notice}</p> : null}
    {run ? <article className="reply-adjustment-result"><h3>宝妍按你的方向这样答</h3>{onPreview ? <button className="button secondary" disabled={locked} onClick={() => onPreview(run)}>{previewBusy ? '正在播放新回答…' : '听听新回答'}</button> : null}<div className="reply-adjustment-reply">{run.reply.split(/\n\s*\n/).filter(Boolean).map((text, index) => <p key={index}>{text}</p>)}</div>
      <p className="helper">{saved ? '想换个方向？修改上面的内容可以试答并另存新场景，原场景仍保留。' : '还不合适？直接修改上面的方向，再试一次。这次预览还没有保存。'}</p>
      {!saved ? <><label className="field">给场景起个名字（选填）<input maxLength={80} disabled={locked} value={title} onChange={event => setTitle(event.target.value)}/></label><button type="button" className="button primary" disabled={!!busy || previewBusy || !confirmed || !replyAdjustmentMatches(run, draft, confirmed)} onClick={() => void save()}><Check size={18}/>{busy === 'confirm' ? '正在保存…' : saveUncertain ? '核对并完成保存' : '满意，保存为场景'}</button></> : <button type="button" className="button secondary" onClick={() => onSaved(saved)}>查看场景，继续采用</button>}
    </article> : null}
  </section>;
}
