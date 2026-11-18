import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Mic, RotateCcw, Send, Square, Trash2, Volume2 } from 'lucide-react';
import { AudioController } from '../audio';
import { messageOf } from '../lib/api';
import { FEEDBACK_RECORDING_SECONDS, FeedbackAttempt, feedbackError, submitFeedback, type FeedbackContext, type FeedbackReceipt } from '../lib/feedback';
import { Modal } from './Modal';

type Phase = 'idle' | 'requesting' | 'recording' | 'processing' | 'playing';

export function Feedback({ context, onClose }: { context: FeedbackContext; onClose: () => void }) {
  const [audio] = useState(() => new AudioController());
  const [attempt] = useState(() => new FeedbackAttempt());
  const [text, setText] = useState('');
  const [clip, setClip] = useState<Blob | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const mounted = useRef(true);
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const ticker = useRef<number | undefined>(undefined);
  const updatePhase = useCallback((value: Phase) => { phaseRef.current = value; setPhase(value); }, []);
  const clearTimers = useCallback(() => { window.clearTimeout(timer.current); window.clearInterval(ticker.current); }, []);
  const stop = useCallback((message = '') => {
    ++epoch.current; clearTimers(); audio.cancel(); updatePhase('idle'); setLevel(0);
    if (message) setNotice(message);
  }, [audio, clearTimers, updatePhase]);

  useEffect(() => {
    mounted.current = true;
    const leave = () => {
      const active = phaseRef.current !== 'idle';
      stop(active ? '离开页面后，录音和试听已停止。这段未完成的录音没有上传。' : '');
      request.current?.abort();
    };
    const hidden = () => { if (document.hidden) leave(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    window.addEventListener('offline', leave);
    return () => {
      mounted.current = false; ++epoch.current; clearTimers(); audio.cancel(); request.current?.abort();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('offline', leave);
    };
  }, [audio, clearTimers, stop]);

  const record = async () => {
    if (phaseRef.current !== 'idle' || request.current) return;
    const generation = ++epoch.current;
    const current = () => mounted.current && generation === epoch.current;
    setError(''); setClip(null); setNotice('等待麦克风授权；不方便录音也可以直接写文字。'); setSeconds(0); setLevel(0);
    updatePhase('requesting');
    try {
      const started = await audio.startListening({ outputFormat: 'wav', endMode: 'manual', maxDurationMs: 30_000,
        onLevel: value => { if (current()) setLevel(value); },
        onProcessing: () => { if (current()) { clearTimers(); setLevel(0); updatePhase('processing'); setNotice('正在本机整理录音…'); } },
        onUtterance: blob => {
          if (!current()) return;
          clearTimers(); setClip(blob); updatePhase('idle'); setNotice('录好了，可以先试听。点击“提交反馈”才会发送。');
        },
        onSilence: () => { if (current()) { clearTimers(); updatePhase('idle'); setLevel(0); setNotice('没听到声音，可以重录或直接写文字。'); } },
        onError: failure => { if (current()) { clearTimers(); updatePhase('idle'); setLevel(0); setError(`${failure.message} 仍可使用文字反馈。`); } },
      });
      if (!current()) return;
      if (!started) { updatePhase('idle'); return; }
      updatePhase('recording'); setNotice(`正在录音，最多 ${FEEDBACK_RECORDING_SECONDS} 秒。录好后点击结束。`);
      const began = performance.now();
      ticker.current = window.setInterval(() => { if (current()) setSeconds(Math.min(FEEDBACK_RECORDING_SECONDS, Math.floor((performance.now() - began) / 1000))); }, 200);
      timer.current = window.setTimeout(() => { if (current()) audio.finishUtterance(); }, FEEDBACK_RECORDING_SECONDS * 1000);
    } catch (failure) {
      if (current()) { clearTimers(); updatePhase('idle'); setError(`${messageOf(failure)} 仍可使用文字反馈。`); }
    }
  };
  const preview = async () => {
    if (!clip || phaseRef.current !== 'idle' || request.current) return;
    const generation = ++epoch.current;
    setError(''); updatePhase('playing');
    try { await audio.playBlob(clip); }
    catch (failure) { if (mounted.current && generation === epoch.current) setError(messageOf(failure)); }
    finally { if (mounted.current && generation === epoch.current) updatePhase('idle'); }
  };
  const submit = async () => {
    if (request.current || phaseRef.current !== 'idle') return;
    let payload;
    try { payload = attempt.prepare(text, clip, context); }
    catch (failure) { setError(messageOf(failure)); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setNotice('正在提交，请稍等…');
    try {
      const result = await submitFeedback(payload, controller.signal);
      if (mounted.current) { setReceipt(result); setClip(null); setText(''); setNotice(''); }
    } catch (failure) { if (mounted.current) { setError(feedbackError(failure)); setNotice(''); } }
    finally { request.current = null; if (mounted.current) setBusy(false); }
  };
  const recording = phase === 'recording';
  const pendingAudio = phase === 'requesting' || phase === 'processing';
  const unavailable = busy || phase !== 'idle';

  return <Modal title="问题反馈" onClose={() => { stop(); onClose(); }} closeDisabled={busy}>
    {receipt ? <div className="feedback-success" role="status"><CheckCircle2 size={36}/><h3>收到啦，谢谢你</h3><p>开发者会查看这条反馈。后续沟通时可以提供下面的编号。</p><strong className="feedback-id">{receipt.id}</strong><button className="button primary full" onClick={onClose}>完成</button></div>
      : <div className="feedback-form">
        <p className="muted">哪里不顺利？写几句话或录段语音就好。</p>
        <label className="field" htmlFor="feedback-text">发生了什么 <span>文字、语音任选一种</span><textarea id="feedback-text" rows={4} maxLength={2000} value={text} onChange={event => setText(event.target.value)} disabled={busy} placeholder="例如：按住说话后，一直没有出现文字。" aria-describedby="feedback-text-count"/></label>
        <p id="feedback-text-count" className="feedback-count">{text.length} / 2000</p>
        <div className={`feedback-recorder ${recording ? 'recording' : ''}`}>
          <div className="feedback-recording-label"><Mic size={19}/><strong>{recording ? `正在录音 ${seconds} / ${FEEDBACK_RECORDING_SECONDS} 秒` : `语音反馈 · 最多 ${FEEDBACK_RECORDING_SECONDS} 秒`}</strong></div>
          {recording ? <div className="sound-meter" aria-label={`录音音量 ${Math.min(100, Math.round(level * 400))}%`}><span style={{ width: `${Math.min(100, level * 400)}%` }}/></div> : null}
          <div className="feedback-audio-actions">
            {recording ? <><button className="button primary" type="button" onClick={() => audio.finishUtterance()}><Square size={17}/>结束录音</button><button className="button ghost" type="button" onClick={() => stop('本次录音已取消，没有上传。')}>取消录音</button></>
              : pendingAudio ? <button className="button secondary" type="button" onClick={() => stop('已取消，麦克风已关闭，没有上传。')}><Square size={17}/>{phase === 'requesting' ? '取消授权等待' : '取消录音处理'}</button>
                : phase === 'playing' ? <button className="button secondary" type="button" onClick={() => stop('试听已停止。')}><Square size={17}/>停止试听</button>
                  : <><button className="button secondary" type="button" disabled={busy} onClick={() => void record()}>{clip ? <RotateCcw size={17}/> : <Mic size={17}/>} {clip ? '重新录音' : '开始录音'}</button>{clip ? <><button className="button secondary" type="button" disabled={busy} onClick={() => void preview()}><Volume2 size={17}/>试听</button><button className="button ghost" type="button" disabled={busy} onClick={() => { stop(); setClip(null); setNotice('录音已删除，没有上传。'); }}><Trash2 size={17}/>删除</button></> : null}</>}
          </div>
          {notice ? <p className="helper" role="status">{notice}</p> : null}
        </div>
        <p className="feedback-privacy">点击提交后，文字／录音与当前页面状态仅发给开发者排查，不自动上传聊天内容，最长保留 30 天。请勿填写密码或真实儿童信息。</p>
        {error ? <p className="error-note" role="alert">{error}</p> : null}
        <button className="button primary full" disabled={unavailable || (!text.trim() && !clip)} onClick={() => void submit()}><Send size={17}/>{busy ? '正在提交…' : '提交反馈'}</button>
        <p className="helper">反馈关闭后不会自动恢复通话；需要时请重新开始聊天。</p>
      </div>}
  </Modal>;
}
