import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, Images, Keyboard, Mic, Play, Send, Square, Trash2 } from 'lucide-react';
import type { AudioController } from '../audio';
import { MAX_RECORDING_BYTES } from '../audioWav';
import { messageOf } from '../lib/api';
import { prepareImage, type PreparedImage } from '../lib/imageTurn';
import { PressToTalkSession, type PressToTalkState } from '../lib/pressToTalk';
import { Modal } from './Modal';

export interface ImageTurnPayload { image: Blob; question: string; audio?: Blob }
export interface ImageTurnInputProps {
  disabled: boolean;
  contextKey: string;
  audio?: AudioController;
  audioInputFormat?: 'browser' | 'wav';
  /** ASR availability, separate from voiceprint enrollment. */
  voiceEnabled?: boolean;
  /** A new explicit photo action opens the chooser, never the native picker. */
  openRequest?: number;
  onDraftActiveChange?: (active: boolean) => void;
  onPickerActiveChange?: (active: boolean) => void;
  onSend: (payload: ImageTurnPayload, signal: AbortSignal) => Promise<void>;
}
type DraftImage = PreparedImage & { previewUrl: string };
type QuestionMode = 'voice' | 'text';
const audioTypes = new Set(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a']);

export function ImageTurnInput({ disabled, contextKey, audio, audioInputFormat = 'browser', voiceEnabled = false, openRequest, onDraftActiveChange, onPickerActiveChange, onSend }: ImageTurnInputProps) {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<DraftImage | null>(null);
  const [question, setQuestion] = useState('');
  const [questionMode, setQuestionMode] = useState<QuestionMode>(voiceEnabled && audio ? 'voice' : 'text');
  const [voice, setVoice] = useState<Blob | null>(null);
  const [voicePhase, setVoicePhase] = useState<PressToTalkState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'sending'>('idle');
  const [error, setError] = useState('');
  const cameraInput = useRef<HTMLInputElement>(null);
  const albumInput = useRef<HTMLInputElement>(null);
  const holdButton = useRef<HTMLButtonElement>(null);
  const pointer = useRef<number | null>(null);
  const pressBounds = useRef<DOMRect | null>(null);
  const key = useRef<string | null>(null);
  const mounted = useRef(true);
  const openRef = useRef(false);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const previewActive = useRef(false);
  const request = useRef<AbortController | null>(null);
  const draftRef = useRef<DraftImage | null>(null);
  const voiceRef = useRef<Blob | null>(null);
  const modeRef = useRef<QuestionMode>(questionMode);
  const voicePhaseRef = useRef<PressToTalkState>('idle');
  const sessionRef = useRef<PressToTalkSession | null>(null);
  const previousContext = useRef(contextKey);
  const lastOpenRequest = useRef(0);
  const pickerActive = useRef(false);
  const pickerWasHidden = useRef(false);
  const pickerTimer = useRef<number | undefined>(undefined);
  const latest = useRef({ disabled, audio, audioInputFormat, voiceEnabled, onDraftActiveChange, onPickerActiveChange, onSend });
  latest.current = { disabled, audio, audioInputFormat, voiceEnabled, onDraftActiveChange, onPickerActiveChange, onSend };
  const session = useMemo(() => audio ? new PressToTalkSession(audio, state => {
    voicePhaseRef.current = state;
    if (mounted.current) { setVoicePhase(state); if (state !== 'recording') setLevel(0); }
  }) : null, [audio]);
  sessionRef.current = session;

  const finishPicker = useCallback(() => {
    window.clearTimeout(pickerTimer.current); pickerTimer.current = undefined;
    pickerActive.current = false; pickerWasHidden.current = false;
    latest.current.onPickerActiveChange?.(false);
  }, []);
  const releasePointer = useCallback(() => {
    const id = pointer.current; pointer.current = null; pressBounds.current = null;
    if (id !== null && holdButton.current?.hasPointerCapture(id)) holdButton.current.releasePointerCapture(id);
  }, []);
  const stopPreview = useCallback(() => {
    ++previewGeneration.current;
    // A sent reply belongs to the call. Closing this draft may stop only its local audition.
    if (previewActive.current) { previewActive.current = false; latest.current.audio?.stopPlayback(); }
    if (mounted.current) setPreviewing(false);
  }, []);
  const cancelVoice = useCallback(() => {
    key.current = null; releasePointer();
    if (sessionRef.current?.state !== 'idle') sessionRef.current?.cancel();
    if (mounted.current) { setLevel(0); setSeconds(0); }
  }, [releasePointer]);
  const clearVoice = useCallback(() => {
    stopPreview(); cancelVoice(); voiceRef.current = null;
    if (mounted.current) setVoice(null);
  }, [cancelVoice, stopPreview]);
  const releaseImage = useCallback(() => {
    if (draftRef.current) URL.revokeObjectURL(draftRef.current.previewUrl);
    draftRef.current = null;
  }, []);
  const close = useCallback(() => {
    openRef.current = false; finishPicker();
    ++generation.current; request.current?.abort(); request.current = null;
    clearVoice(); releaseImage();
    if (cameraInput.current) cameraInput.current.value = '';
    if (albumInput.current) albumInput.current.value = '';
    if (mounted.current) { setImage(null); setQuestion(''); setError(''); setPhase('idle'); setOpen(false); }
    latest.current.onDraftActiveChange?.(false);
  }, [clearVoice, finishPicker, releaseImage]);
  const openDraft = useCallback(() => {
    if (latest.current.disabled || request.current || openRef.current) return false;
    const mode = latest.current.voiceEnabled && latest.current.audio ? 'voice' : 'text';
    modeRef.current = mode; setQuestionMode(mode);
    openRef.current = true; setOpen(true); setError('');
    latest.current.onDraftActiveChange?.(true);
    return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; openRef.current = false; ++generation.current;
      request.current?.abort(); request.current = null; clearVoice(); releaseImage(); finishPicker();
      latest.current.onDraftActiveChange?.(false);
    };
  }, [clearVoice, finishPicker, releaseImage]);
  useEffect(() => { if (previousContext.current !== contextKey) { previousContext.current = contextKey; close(); } }, [contextKey, close]);
  useEffect(() => {
    if (!openRequest || openRequest === lastOpenRequest.current) return;
    if (openDraft()) lastOpenRequest.current = openRequest;
  }, [openRequest, disabled, openDraft]);
  useEffect(() => () => {
    if (session?.state !== 'idle') session?.cancel();
    if (previewActive.current) { previewActive.current = false; ++previewGeneration.current; audio?.stopPlayback(); }
  }, [session, audio]);
  useEffect(() => {
    if (disabled) { cancelVoice(); stopPreview(); }
    if ((!voiceEnabled || !audio) && modeRef.current === 'voice') {
      clearVoice(); modeRef.current = 'text'; setQuestionMode('text');
    }
  }, [disabled, voiceEnabled, audio, cancelVoice, clearVoice, stopPreview]);
  useEffect(() => {
    const inputs = [cameraInput.current, albumInput.current];
    inputs.forEach(node => node?.addEventListener('cancel', finishPicker));
    return () => inputs.forEach(node => node?.removeEventListener('cancel', finishPicker));
  }, [open, finishPicker]);
  useEffect(() => {
    const leave = () => close();
    const hidden = () => {
      if (!document.hidden) return;
      if (pickerActive.current) { pickerWasHidden.current = true; return; }
      if (openRef.current) close();
    };
    const returned = () => { if (pickerActive.current && pickerWasHidden.current && !document.hidden) finishPicker(); };
    window.addEventListener('pagehide', leave); window.addEventListener('offline', leave); window.addEventListener('focus', returned); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', leave); window.removeEventListener('offline', leave); window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', hidden); };
  }, [close, finishPicker]);
  useEffect(() => {
    if (voicePhase !== 'recording') return;
    const started = performance.now(); setSeconds(0);
    const timer = window.setInterval(() => setSeconds(Math.min(30, Math.floor((performance.now() - started) / 1000))), 250);
    return () => window.clearInterval(timer);
  }, [voicePhase]);

  const openPicker = (source: 'camera' | 'album') => {
    const input = source === 'camera' ? cameraInput.current : albumInput.current;
    if (disabled || request.current || voicePhaseRef.current !== 'idle' || !input) return;
    stopPreview(); finishPicker(); pickerActive.current = true; latest.current.onPickerActiveChange?.(true);
    pickerTimer.current = window.setTimeout(finishPicker, 30_000);
    input.click();
  };
  const pick = async (file: File | undefined) => {
    finishPicker();
    if (!file || disabled || request.current || voicePhaseRef.current !== 'idle' || !openRef.current) return;
    const controller = new AbortController(); request.current = controller; const epoch = ++generation.current;
    const current = () => mounted.current && openRef.current && epoch === generation.current && !controller.signal.aborted;
    clearVoice(); setQuestion(''); releaseImage(); setImage(null); setError(''); setPhase('preparing');
    try {
      const prepared = await prepareImage(file, controller.signal);
      if (!current()) return;
      const draft = { ...prepared, previewUrl: URL.createObjectURL(prepared.image) };
      draftRef.current = draft; setImage(draft);
    } catch (failure) { if (current()) setError(messageOf(failure)); }
    finally { if (current()) { request.current = null; setPhase('idle'); } }
  };
  const switchQuestion = (mode: QuestionMode) => {
    if (request.current || mode === modeRef.current || mode === 'voice' && (!voiceEnabled || !audio)) return;
    ++generation.current; clearVoice(); setQuestion(''); setError('');
    modeRef.current = mode; setQuestionMode(mode);
  };
  const pressVoice = () => {
    if (!session || disabled || !voiceEnabled || !draftRef.current || request.current || document.hidden || modeRef.current !== 'voice' || session.state !== 'idle') return;
    stopPreview(); voiceRef.current = null; setVoice(null); setError('');
    const epoch = ++generation.current;
    const current = () => mounted.current && openRef.current && epoch === generation.current && modeRef.current === 'voice';
    session.press({
      outputFormat: audioInputFormat, maxDurationMs: 30_000,
      onLevel: value => { if (current()) setLevel(value); },
      onUtterance: blob => {
        if (!current()) return;
        const type = blob.type.split(';')[0]!.toLowerCase();
        if (!blob.size || blob.size > MAX_RECORDING_BYTES || !audioTypes.has(type) || audioInputFormat === 'wav' && type !== 'audio/wav') {
          setError('这段声音没有准备好，请按住重新说，或改用文字。'); return;
        }
        voiceRef.current = blob; setVoice(blob);
      },
      onSilence: () => { if (current()) setError('这次没听到声音，请再按住说一句。'); },
      onError: failure => { if (current()) setError(messageOf(failure)); },
    });
  };
  const releaseVoice = () => {
    if (voicePhaseRef.current === 'starting') setError('麦克风还没开始收音，请重新按住，等“正在听”再说。');
    session?.release();
  };
  const preview = async () => {
    if (!audio || !voiceRef.current || disabled || request.current || voicePhaseRef.current !== 'idle') return;
    const epoch = ++previewGeneration.current; previewActive.current = true; setPreviewing(true); setError('');
    try { await audio.playBlob(voiceRef.current, { startTimeoutMs: 8000 }); }
    catch (failure) { if (mounted.current && epoch === previewGeneration.current) setError(messageOf(failure)); }
    finally { if (mounted.current && epoch === previewGeneration.current) { previewActive.current = false; setPreviewing(false); } }
  };
  const send = async () => {
    if (!draftRef.current || disabled || request.current || voicePhaseRef.current !== 'idle' || question.length > 600) return;
    stopPreview();
    const payload: ImageTurnPayload = { image: draftRef.current.image, question: modeRef.current === 'text' ? question.trim() : '' };
    if (modeRef.current === 'voice' && voiceRef.current) payload.audio = voiceRef.current;
    const controller = new AbortController(); request.current = controller; const epoch = ++generation.current;
    const current = () => mounted.current && openRef.current && epoch === generation.current && !controller.signal.aborted;
    setPhase('sending'); setError('');
    try { await latest.current.onSend(payload, controller.signal); if (current()) close(); }
    catch (failure) { if (current()) setError(messageOf(failure)); }
    finally { if (current()) { request.current = null; setPhase('idle'); } }
  };
  const busy = phase !== 'idle';
  const recordingBusy = voicePhase !== 'idle';
  const holding = voicePhase === 'starting' || voicePhase === 'recording';
  return <>
    <button type="button" className="child-composer-choice image-turn-entry" disabled={disabled} onClick={openDraft} aria-label="给宝妍看照片"><ImagePlus size={26}/><span>照片</span></button>
    {open ? <Modal title="给宝妍看照片" onClose={close}>
      <div className="image-turn-draft">
        <p className="helper">先拍照，或从相册选一张。</p>
        <input ref={cameraInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="image-turn-file" disabled={disabled || busy || recordingBusy} aria-label="拍一张照片" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void pick(file); }}/>
        <input ref={albumInput} type="file" accept="image/jpeg,image/png,image/webp" className="image-turn-file" disabled={disabled || busy || recordingBusy} aria-label="从相册选一张照片" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void pick(file); }}/>
        <div className="image-source-choices"><button type="button" className="image-source-choice" disabled={disabled || busy || recordingBusy} onClick={() => openPicker('camera')}><Camera size={36}/><strong>拍照</strong></button><button type="button" className="image-source-choice" disabled={disabled || busy || recordingBusy} onClick={() => openPicker('album')}><Images size={36}/><strong>相册</strong></button></div>
        {image ? <figure className="image-turn-preview"><img src={image.previewUrl} alt="准备发送的照片"/><figcaption>照片先留在这里，点发送才交给宝妍。</figcaption></figure> : <div className="image-turn-empty"><ImagePlus size={32}/><p>一次一张，原图不超过5 MB。</p></div>}
        {image ? <>
          <div className="image-turn-actions"><button type="button" className="button ghost" disabled={busy || recordingBusy} onClick={() => { ++generation.current; clearVoice(); setQuestion(''); releaseImage(); setImage(null); setError(''); }}><Trash2 size={18}/>移除照片</button></div>
          <div className="image-question-modes" role="group" aria-label="照片问题怎么说"><button type="button" className={`child-composer-choice ${questionMode === 'voice' ? 'selected' : ''}`} aria-pressed={questionMode === 'voice'} disabled={busy || !voiceEnabled || !audio} onClick={() => switchQuestion('voice')}><Mic size={23}/><span>说一句</span></button><button type="button" className={`child-composer-choice ${questionMode === 'text' ? 'selected' : ''}`} aria-pressed={questionMode === 'text'} disabled={busy} onClick={() => switchQuestion('text')}><Keyboard size={23}/><span>写一句</span></button></div>
          {questionMode === 'voice' && audio ? <div className="image-voice-draft">
            <button ref={holdButton} type="button" className={`button primary full image-voice-hold ${holding ? 'is-held' : ''}`} disabled={disabled || busy || voicePhase === 'finishing'} aria-pressed={holding} aria-label="按住说照片问题，松手留在草稿" aria-describedby="photo-voice-instructions"
              onPointerDown={event => { if (event.button !== 0 || !event.isPrimary || pointer.current !== null || key.current !== null) return; event.preventDefault(); event.currentTarget.focus(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; } pointer.current = event.pointerId; pressBounds.current = event.currentTarget.getBoundingClientRect(); pressVoice(); }}
              onPointerUp={event => { if (pointer.current !== event.pointerId) return; event.preventDefault(); const bounds = pressBounds.current ?? event.currentTarget.getBoundingClientRect(); const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom; releasePointer(); if (inside) releaseVoice(); else cancelVoice(); }}
              onPointerCancel={event => { if (pointer.current === event.pointerId) cancelVoice(); }} onLostPointerCapture={event => { if (pointer.current === event.pointerId) cancelVoice(); }}
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancelVoice(); return; } if (event.key !== ' ' && event.key !== 'Enter') return; event.preventDefault(); if (event.repeat || key.current !== null || pointer.current !== null) return; key.current = event.key; pressVoice(); }}
              onKeyUp={event => { if (key.current !== event.key) return; event.preventDefault(); key.current = null; releaseVoice(); }} onBlur={() => { if (pointer.current !== null || key.current !== null) cancelVoice(); }} onContextMenu={event => event.preventDefault()}>
              <Mic size={25}/>{voicePhase === 'starting' ? '正在打开麦克风…' : voicePhase === 'recording' ? `正在听 ${seconds}秒 · 松手完成` : voicePhase === 'finishing' ? '正在整理声音…' : voice ? '按住重录' : '按住说，松手完成'}
            </button>
            {voicePhase === 'recording' ? <div className="sound-meter" aria-label={`录音音量 ${Math.min(100, Math.round(level * 400))}%`}><span style={{ width: `${Math.min(100, level * 400)}%` }}/></div> : null}
            <p className="image-voice-status" role="status">{voice ? '声音已留在本机，点发送才交给宝妍。' : '直接说就好，松手先留在这里；没听清时宝妍会再问。'}</p>
            <p id="photo-voice-instructions" className="sr-only">每次最多30秒，移到按钮外松手或按Esc取消；按住空格或回车也能说，松手完成草稿。</p>{voice ? <div className="image-voice-actions"><button type="button" className="button secondary" disabled={disabled || busy || recordingBusy} onClick={() => previewing ? stopPreview() : void preview()}>{previewing ? <Square size={18}/> : <Play size={18}/>} {previewing ? '停止试听' : '听一听'}</button><button type="button" className="button ghost" disabled={busy || recordingBusy} onClick={clearVoice}><Trash2 size={18}/>删除声音</button></div> : null}
          </div> : <label className="field">想说什么 <span>选填</span><textarea value={question} maxLength={600} rows={2} disabled={disabled || busy} onChange={event => setQuestion(event.target.value)} placeholder="这是我画的小屋，你觉得哪里有意思？"/></label>}
        </> : null}
        <details className="image-turn-privacy"><summary>照片和声音怎么用？</summary><p>点发送后，照片与这一句一起交给宝妍；不保存原图。照片会缩小并去除拍摄位置等信息。请使用物品、画作等体验素材，不发真实儿童信息。</p></details>
        {phase === 'preparing' ? <p role="status" className="helper">正在整理照片…</p> : null}
        {phase === 'sending' ? <p role="status" className="helper">宝妍正在看照片…</p> : null}
        {error ? <p className="error-note" role="alert">{error}</p> : null}
        <div className="image-turn-actions"><button type="button" className="button primary" disabled={disabled || busy || recordingBusy || !image} onClick={() => void send()}><Send size={21}/>{phase === 'sending' ? '正在发送…' : '发给宝妍'}</button><button type="button" className="button ghost" onClick={close}>{busy || recordingBusy ? '取消本次' : '暂时不发'}</button></div>
      </div>
    </Modal> : null}
  </>;
}
