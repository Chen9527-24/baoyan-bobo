import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, BookOpen, Keyboard, LockKeyhole, MessageCircle, Mic, Send, Square, ThumbsDown, Volume2 } from 'lucide-react';
import { AudioController, type PlaybackResult } from '../audio';
import { api, ApiError, messageOf, operationId } from '../lib/api';
import type { CalibrationDraft } from '../lib/calibration';
import type { PromptLabAge, PromptLabHistory } from '../lib/promptLab';
import { fetchReplySpeechStream } from '../lib/speechStream';
import type { ReplyAdjustmentRun } from '../lib/replyAdjustment';
import { fetchReplySpeech, permitsTextFallback, presentReplySegmentsWithPlayback } from '../lib/replyPlayback';
import { replySegmentEmotion, validateReplySegments } from '../lib/replySegments';
import { createReplySpeechPrefetch } from '../lib/replySpeechPrefetch';
import type { ReplySegment } from '../lib/types';
import { replyParagraphs } from '../lib/replyParagraphs';
import { Avatar, CharacterMark, type CharacterReaction } from './Avatar';
import { characterReactionFor } from '../lib/characterMotion';
import { VoiceTurnInput } from './VoiceTurnInput';
import { ReplyAdjustment } from './ReplyAdjustment';
import { CalibrationLibrary } from './CalibrationLibrary';
import './DebugRoom.css';

type Status = { enabled: boolean; authorized: boolean; expiresAt?: string; scopeChildId?: string; capabilities?: { chat: boolean; asr: boolean; tts: boolean; ttsStreaming: boolean }; audioInputFormat?: 'wav' | 'browser'; adoptionVersion?: number };
type Turn = { replyId: string; question: string; reply: string; replySegments?: ReplySegment[]; replyPlanVersion?: string; emotion: 'warm' | 'happy' | 'thoughtful' | 'calm'; ageGroup: PromptLabAge; testHistory: PromptLabHistory[]; model: string; personaVersion: string };
type Message = Turn & { shown: boolean; displayText?: string };
type Phase = 'idle' | 'thinking' | 'preparing' | 'speaking';

/** A separate, fictional testing surface. It never uses household or parent endpoints. */
export function DebugRoom({ onClose }: { onClose: () => void }) {
  const [viewportHeight, setViewportHeight] = useState(() => Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight));
  useEffect(() => { const resize = () => setViewportHeight(Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight)); window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); }; }, []);
  const [status, setStatus] = useState<Status | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [age, setAge] = useState<PromptLabAge>('6-8');
  const [method, setMethod] = useState<'text' | 'voice'>('text');
  const [messages, setMessages] = useState<Message[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [playbackActive, setPlaybackActive] = useState(false);
  const [playbackEmotion, setPlaybackEmotion] = useState<Turn['emotion']>('warm');
  const [spokenSegment, setSpokenSegment] = useState('');
  const [characterReaction, setCharacterReaction] = useState<CharacterReaction>();
  const [ready, setReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [holding, setHolding] = useState(false);
  const [tab, setTab] = useState<'chat' | 'library'>('chat');
  const [draft, setDraft] = useState<CalibrationDraft>();
  const [selectedCase, setSelectedCase] = useState<string>();
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [audio] = useState(() => new AudioController());
  const mounted = useRef(true);
  const generation = useRef(0);
  const pending = useRef<{ id?: string; controller: AbortController } | undefined>(undefined);
  const unlocking = useRef<AbortController | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const lockRequest = useRef<Promise<unknown> | undefined>(undefined);
  const requestLock = () => {
    if (!lockRequest.current) lockRequest.current = api('/debug/lock', { method: 'POST', body: '{}', keepalive: true }).catch(() => {});
    return lockRequest.current;
  };
  const authorized = useRef(false);
  const expiry = useRef(0);
  const adoptionVersion = useRef<number | undefined>(undefined);
  const locked = closing || unlockBusy || phase !== 'idle' || preparing || holding || adjustBusy;

  useEffect(() => { const node = list.current; if (node) node.scrollTop = node.scrollHeight; }, [messages]);
  const stop = () => {
    ++generation.current;
    const old = pending.current; pending.current = undefined;
    old?.controller.abort(); audio.cancel(); setPlaybackActive(false); setCharacterReaction(undefined); setPhase('idle'); setReady(false); setPreparing(false); setHolding(false);
    setPreviewing(false);
    if (old?.id) void api('/debug/cancel', { method: 'POST', body: JSON.stringify({ operationId: old.id }), keepalive: true }).catch(() => {});
  };
  const expire = (message = '内测验证已结束，请重新输入密码。') => {
    authorized.current = false; stop(); setUnlocked(false); setMessages([]); setDraft(undefined); setSelectedCase(undefined); setText(''); setTab('chat'); setError(message);
  };
  const report = (cause: unknown) => {
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) expire();
    else setError(messageOf(cause));
  };
  useEffect(() => {
    mounted.current = true;
    const request = new AbortController();
    void api<Status>('/debug/status', { signal: request.signal }).then(value => { if (mounted.current && !request.signal.aborted) setStatus(value); }).catch(cause => { if (!request.signal.aborted && mounted.current) setError(messageOf(cause)); });
    const leave = () => {
      ++generation.current; authorized.current = false; unlocking.current?.abort(); unlocking.current = undefined; pending.current?.controller.abort(); pending.current = undefined; audio.cancel();
      void requestLock();
      if (mounted.current) { setPreviewing(false); setSelectedCase(undefined); setAdjustBusy(false); setUnlockBusy(false); setPlaybackActive(false); setPhase('idle'); setUnlocked(false); setMessages([]); setDraft(undefined); setText(''); setReady(false); setPreparing(false); setHolding(false); setTab('chat'); }
    };
    const hidden = () => { if (document.hidden) leave(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('offline', leave); window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; request.abort(); leave(); audio.endPlaybackSession(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('offline', leave); window.removeEventListener('pagehide', leave); };
  }, [audio]);
  useEffect(() => {
    if (!unlocked) return;
    const remaining = expiry.current - Date.now();
    if (remaining <= 0) { expire(); return; }
    const timer = window.setTimeout(() => expire(), Math.min(remaining, 2147483647));
    return () => window.clearTimeout(timer);
  }, [unlocked, status?.expiresAt]);

  useEffect(() => {
    if (!unlocked) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const poll = async () => {
      request = new AbortController();
      try {
        const value = await api<Status>('/debug/status', { signal: request.signal });
        if (stopped || !mounted.current || !authorized.current) return;
        if (!value.authorized) { expire(); return; }
        if (value.adoptionVersion !== undefined && adoptionVersion.current !== undefined && value.adoptionVersion !== adoptionVersion.current) {
          stop(); setMessages([]); setSpokenSegment(''); setError('接话方向已更新，刚才的声音已停止，可以继续聊天。');
        }
        adoptionVersion.current = value.adoptionVersion;
      } catch (cause) {
        if (!stopped && mounted.current && authorized.current) report(cause);
      }
      if (!stopped && authorized.current) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => { stopped = true; clearTimeout(timer); request?.abort(); };
  }, [unlocked]);

  const unlock = async () => {
    if (closing || unlockBusy || !consent || !password.trim()) return;
    setUnlockBusy(true); setError('');
    const token = ++generation.current; const request = new AbortController(); unlocking.current = request;
    try {
      await lockRequest.current;
      if (!mounted.current || request.signal.aborted || token !== generation.current) return;
      const value = await api<Status>('/debug/unlock', { method: 'POST', body: JSON.stringify({ password }), signal: request.signal });
      if (!mounted.current || request.signal.aborted || token !== generation.current) return;
      if (!value.authorized || !value.scopeChildId || !Number.isFinite(Date.parse(value.expiresAt ?? ''))) throw new Error('验证状态未完整返回，请重新进入。');
      adoptionVersion.current = value.adoptionVersion; expiry.current = Date.parse(value.expiresAt!); lockRequest.current = undefined; authorized.current = true; setStatus(value); setUnlocked(true); setPassword(''); setMessages([]);
    } catch (cause) { if (mounted.current && !request.signal.aborted && token === generation.current) setError(messageOf(cause)); }
    finally { if (unlocking.current === request) unlocking.current = undefined; if (mounted.current && token === generation.current) setUnlockBusy(false); }
  };
  const close = async () => {
    if (closing) return; setClosing(true);
    stop(); authorized.current = false; setUnlocked(false); setMessages([]); setDraft(undefined); setPassword('');
    try { await requestLock(); }
    catch { /* No household authorization was granted; the short session also expires server-side. */ }
    if (mounted.current) onClose();
  };
  const playReply = async (replyId: string, onStart: () => void, current: () => boolean, signal: AbortSignal, segmentIndex?: number): Promise<PlaybackResult> => {
    const available = audio.getCapabilities();
    const options = { onStart: () => { if (current()) { onStart(); setPhase('speaking'); } }, onActivityChange: (value: boolean) => { if (current()) setPlaybackActive(value); }, startTimeoutMs: 35000 };
    const endpoint = `/api/debug/speech/${encodeURIComponent(replyId)}`;
    if (status?.capabilities?.ttsStreaming && available.streamingPlayback) return audio.playPcmStream(media => fetchReplySpeechStream('', replyId, [media, signal], 35000, fetch, endpoint, segmentIndex), options);
    if (status?.capabilities?.tts && available.playback) { const blob = await fetchReplySpeech('', replyId, signal, 35000, fetch, endpoint, segmentIndex); return current() ? audio.playBlob(blob, options) : 'cancelled'; }
    if (current()) onStart();
    return current() ? 'ended' : 'cancelled';
  };
  const preview = async (run: ReplyAdjustmentRun) => {
    if (pending.current || adjustBusy || !authorized.current) return;
    audio.preparePlayback(); audio.cancel(); setPlaybackActive(false); setCharacterReaction(undefined); setPlaybackEmotion('warm'); setSpokenSegment(run.reply); setPreviewing(true); setPhase('preparing'); setError('');
    const request = { controller: new AbortController() }; pending.current = request; const token = ++generation.current;
    const current = () => mounted.current && authorized.current && generation.current === token && pending.current === request && !request.controller.signal.aborted;
    try { await playReply(run.id, () => {}, current, request.controller.signal); }
    catch (cause) { if (current()) report(cause); }
    finally { if (current()) { pending.current = undefined; setPhase('idle'); setPlaybackActive(false); setPreviewing(false); } }
  };
  const send = async (input: string | Blob) => {
    if (!authorized.current || pending.current || draft || tab !== 'chat' || phase !== 'idle' || (preparing && !(input instanceof Blob)) || adjustBusy) return;
    audio.preparePlayback(); audio.cancel(); setPlaybackActive(false); setCharacterReaction(undefined); setError(''); setPhase('thinking'); setReady(false); setPreparing(false);
    const request = { id: operationId(), controller: new AbortController() }; pending.current = request;
    const token = ++generation.current;
    const current = () => mounted.current && authorized.current && generation.current === token && pending.current === request && !request.controller.signal.aborted;
    let returned: Turn | undefined;
    // Keep the registered complete reply intact for natural-language adjustment;
    // only displayText grows as each segment actually starts playing.
    const reveal = (displayText?: string) => { if (current() && returned) setMessages(items => items.map(item => item.replyId === returned!.replyId ? { ...item, shown: true, displayText: displayText ?? returned!.reply } : item)); };
    try {
      let body: BodyInit;
      if (input instanceof Blob) { const data = new FormData(); data.set('audio', input, input.type.includes('wav') ? 'utterance.wav' : 'utterance.webm'); data.set('operationId', request.id); data.set('ageGroup', age); body = data; }
      else { const value = input.trim(); if (!value) return; setText(''); body = JSON.stringify({ operationId: request.id, text: value, ageGroup: age }); }
      const turn = await api<Turn>('/debug/turn', { method: 'POST', body, signal: request.controller.signal });
      if (!current()) return;
      returned = turn; setPlaybackEmotion(turn.emotion); setSpokenSegment(turn.reply); setMessages(items => [...items, { ...turn, shown: false }].slice(-12)); setPhase('preparing');
      let heardReply = false, lastSpoken = turn.reply, lastEmotion = turn.emotion;
      const reactAfterReply = () => { if (!current() || !heardReply) return; const motion = characterReactionFor({ emotion: lastEmotion, spokenText: lastSpoken, inputText: turn.question }); if (motion) setCharacterReaction({ id: turn.replyId, motion }); };
      const segments = validateReplySegments(turn.reply, turn.replySegments);
      if (segments) {
        const available = audio.getCapabilities();
        const streaming = Boolean(status?.capabilities?.ttsStreaming && available.streamingPlayback);
        const endpoint = `/api/debug/speech/${encodeURIComponent(turn.replyId)}`;
        const prefetched = streaming || (status?.capabilities?.tts && available.playback) ? createReplySpeechPrefetch({
          segmentCount: segments.length, segments, isCurrent: current, signal: request.controller.signal, streaming, audio,
          onActivityChange: value => { if (current()) setPlaybackActive(value); },
          fetchPcm: (index, signal) => fetchReplySpeechStream('', turn.replyId, signal, 35000, fetch, endpoint, index),
          fetchBlob: (index, signal) => fetchReplySpeech('', turn.replyId, signal, 35000, fetch, endpoint, index),
        }) : undefined;
        try {
          await presentReplySegmentsWithPlayback({
            reply: turn.reply, segments, isCurrent: current,
            playback: prefetched ? (_segment, index, onStart) => prefetched.play(index, onStart) : undefined,
            preparing: index => { if (current()) { setPlaybackActive(false); if (!(index > 0 && prefetched?.isReady(index))) setPhase('preparing'); } },
            reveal: (displayText, _mode, segment) => { reveal(displayText); if (current() && segment) { lastSpoken = segment.text; lastEmotion = replySegmentEmotion(segment.expression); setSpokenSegment(lastSpoken); setPlaybackEmotion(lastEmotion); } },
            speaking: () => { if (current()) { heardReply = true; setPhase('speaking'); } }, ready: reactAfterReply,
            failed: cause => { if (current()) report(cause); },
          });
        } finally { prefetched?.dispose(); }
      } else { const available = audio.getCapabilities(); const audible = Boolean((status?.capabilities?.ttsStreaming && available.streamingPlayback) || (status?.capabilities?.tts && available.playback)); const result = await playReply(turn.replyId, () => { heardReply = audible; reveal(); }, current, request.controller.signal); if (result === 'ended') reactAfterReply(); }
    } catch (cause) {
      if (current()) { if (permitsTextFallback(cause)) reveal(); report(cause); }
    } finally {
      if (current()) { pending.current = undefined; setPhase('idle'); setPlaybackActive(false); }
    }
  };
  const adjust = (turn: Turn) => {
    stop(); setError(''); setDraft({ question: turn.question, actualReply: turn.reply, ageGroup: turn.ageGroup, testHistory: turn.testHistory, testMemories: [], title: '聊天回复调整', category: '接话自然度' });
  };
  const switchTab = (next: 'chat' | 'library') => { if (adjustBusy || holding || preparing) return; stop(); setDraft(undefined); setTab(next); setError(''); };
  return <div className="debug-shell" style={{ '--debug-viewport-height': `${viewportHeight}px` } as CSSProperties}><header className="debug-header"><button className="text-button" onClick={() => void close()} disabled={closing || unlockBusy || adjustBusy || previewing}><ArrowLeft size={18}/>回到宝妍</button><span><LockKeyhole size={17}/>内测调试</span></header>
    {!unlocked ? <main className="debug-unlock companion-card"><CharacterMark/><h1>进入内测调试</h1><p>在这里和宝妍聊天，觉得回答不合适，就直接告诉她怎么改。</p><form onSubmit={event => { event.preventDefault(); void unlock(); }}><label className="field">内测密码<input type="password" autoComplete="off" value={password} maxLength={128} disabled={closing || unlockBusy} onChange={event => setPassword(event.target.value)} placeholder="输入分享人设置的密码"/></label><label className="check-row"><input type="checkbox" checked={consent} disabled={closing || unlockBusy} onChange={event => setConsent(event.target.checked)}/><span>我用虚构资料测试。保存的场景会让其他持有内测密码的人看到，不包含真实儿童和家庭信息。</span></label><button className="button primary full" disabled={closing || unlockBusy || !consent || !password.trim() || status?.enabled === false}>{unlockBusy ? '正在验证…' : '进入调试'}</button></form>{status?.enabled === false ? <p className="helper">调试入口尚未开启，请联系分享人。</p> : null}{error ? <p role="alert" className="error-note">{error}</p> : null}</main> : <main className="debug-main"><div className="debug-title"><div><h1>和宝妍一起试试</h1><p>调试聊天不读取家庭记忆；只保存你确认满意的场景。</p></div><Avatar outfit="mint" state={phase === 'speaking' ? 'speaking' : phase === 'idle' ? 'listening' : 'processing'} emotion={playbackEmotion} playbackActive={playbackActive} listeningActive={phase === 'idle' && method === 'voice' && ready && holding && !draft && !adjustBusy && !preparing} segmentText={spokenSegment} reaction={characterReaction} suspended={preparing || (holding && !ready) || tab !== 'chat' || !!draft || closing || !unlocked}/></div>
      <nav className="debug-tabs" aria-label="内测工作区"><button aria-pressed={tab === 'chat'} onClick={() => switchTab('chat')} disabled={adjustBusy || previewing || holding || preparing}><MessageCircle size={18}/>试着聊</button><button aria-pressed={tab === 'library'} onClick={() => switchTab('library')} disabled={adjustBusy || previewing || holding || preparing}><BookOpen size={18}/>内测场景库</button></nav>
      {tab === 'library' ? <CalibrationLibrary key={selectedCase ?? 'debug-library'} apiBase="/debug/calibration" onAdoptionChange={stop} initialTab="cases" initialSelectedId={selectedCase} onBusyChange={setAdjustBusy} onAuthorizationExpired={() => expire()} onAdjustCase={value => { setTab('chat'); setDraft(value); }}/>
        : draft ? <section className="debug-adjust"><button className="text-button" disabled={adjustBusy || previewing} onClick={() => { stop(); setDraft(undefined); }}><ArrowLeft size={18}/>返回调试聊天</button><ReplyAdjustment key={`${draft.question}:${draft.actualReply}`} initialDraft={draft} childId={status!.scopeChildId!} apiBase="/debug/reply-adjustment" configPath="/debug/config" scope="debug" onBusyChange={setAdjustBusy} onAuthorizationExpired={() => expire()} onDraftChange={stop} previewBusy={previewing} onPreview={status?.capabilities?.tts ? run => void preview(run) : undefined} onSaved={item => { setSelectedCase(item.id); setDraft(undefined); setTab('library'); }}/></section>
        : <section className="debug-chat companion-card"><div className="debug-chat-tools"><label>模拟年龄<select value={age} disabled={locked} onChange={event => setAge(event.target.value as PromptLabAge)}><option value="3-5">3–5岁</option><option value="6-8">6–8岁</option><option value="9-12">9–12岁</option><option value="13-14">13–14岁</option></select></label><span>普通话 · 虚构测试</span></div>
          <div className="debug-messages" ref={list} aria-label="内测聊天内容" tabIndex={0}>{messages.length ? messages.map(turn => <article key={turn.replyId}><p className="debug-question"><small>你说</small>{turn.question}</p>{turn.shown ? <div className="debug-answer"><small>宝妍姐姐</small>{replyParagraphs(turn.displayText ?? turn.reply).map((part, index) => <p key={index}>{part}</p>)}<button className="text-button" onClick={() => adjust(turn)} disabled={adjustBusy}><ThumbsDown size={16}/>这条回答不满意，换个思路</button></div> : null}</article>) : <div className="debug-empty"><MessageCircle size={30}/><h2>随便聊一句就好</h2><p>例如：我搭的积木又倒了，不想玩了。</p><p>点回答下方的“不满意”，用自己的话说希望怎么接。</p></div>}</div>
          <div className="debug-input"><p role="status" className="debug-phase">{phase === 'thinking' ? '宝妍在想怎么接话…' : phase === 'preparing' ? '正在准备声音…' : phase === 'speaking' ? <><Volume2 size={16}/>宝妍在说话</> : '轮到你说了'}</p><div className="debug-input-tabs"><button aria-pressed={method === 'text'} disabled={locked} onClick={() => { audio.stopCapture(); setMethod('text'); }}><Keyboard size={18}/>打字</button>{status?.capabilities?.asr ? <button aria-pressed={method === 'voice'} disabled={locked} onClick={() => setMethod('voice')}><Mic size={18}/>按住说</button> : null}{phase !== 'idle' ? <button onClick={stop}><Square size={16}/>停止这次回答</button> : null}</div>
            {method === 'text' ? <form onSubmit={event => { event.preventDefault(); void send(text); }}><label className="sr-only" htmlFor="debug-message">想对宝妍说什么</label><input id="debug-message" value={text} onChange={event => setText(event.target.value)} placeholder="想对宝妍说什么？" maxLength={600} disabled={locked}/><button className="button primary" aria-label="发送调试消息" disabled={locked || !text.trim()}><Send size={19}/></button></form> : <VoiceTurnInput compact showModeSelector={false} mode="hold" onModeChange={() => {}} onHoldingChange={setHolding} ready={ready} preparing={preparing} active={phase === 'idle' && !adjustBusy && authorized.current} audio={audio} outputFormat={status?.audioInputFormat ?? 'wav'} onAudio={value => void send(value)} onProcessing={setPreparing} onReady={setReady} onError={message => { setPreparing(false); setError(message); }}/>} </div>
        </section>}
      {previewing ? <button className="button secondary" onClick={stop}><Square size={16}/>停止试听</button> : null}{error ? <p className="error-note" role="alert">{error}</p> : null}<p className="debug-privacy">内测场景库由同密码使用者共享；满意保存后才会留下参考案例，退出会清空本次聊天。保存不会自动改变正式回复。</p>
    </main>}
  </div>;
}
