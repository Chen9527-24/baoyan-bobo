import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Mic } from 'lucide-react';
import { PressToTalkSession, type PressToTalkState } from '../lib/pressToTalk';
import { VoiceInput } from './VoiceInput';

type Props = ComponentProps<typeof VoiceInput> & { onHoldingChange?: (holding: boolean) => void };

export function HoldToTalkInput(props: Props) {
  const latest = useRef(props); latest.current = props;
  const [phase, setPhase] = useState<PressToTalkState>('idle');
  const pointer = useRef<number | null>(null);
  const pressBounds = useRef<DOMRect | null>(null);
  const key = useRef<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const instructions = useId();
  const session = useMemo(() => new PressToTalkSession(props.audio, state => {
    setPhase(state);
    latest.current.onReady(state === 'recording');
    latest.current.onHoldingChange?.(state === 'starting' || state === 'recording');
    if (state !== 'recording') latest.current.onLevel?.(0);
  }), [props.audio]);

  const releasePointer = () => {
    const id = pointer.current; pointer.current = null; pressBounds.current = null;
    if (id !== null && button.current?.hasPointerCapture(id)) button.current.releasePointerCapture(id);
  };
  const cancel = () => {
    key.current = null;
    releasePointer();
    session.cancel();
    latest.current.onProcessing(false);
  };
  const press = () => {
    const input = latest.current;
    if (!input.active || document.hidden || phase === 'finishing') return;
    session.press({
      outputFormat: input.outputFormat,
      onLevel: level => latest.current.onLevel?.(level),
      onSpeechStart: () => latest.current.onSpeechStart?.(),
      onProcessing: () => latest.current.onProcessing(true),
      onUtterance: blob => { latest.current.onProcessing(false); latest.current.onAudio(blob); },
      onSilence: () => {
        latest.current.onProcessing(false);
        latest.current.onError('这次没有听到声音，请再按住说一句。');
      },
      onError: error => { latest.current.onProcessing(false); latest.current.onError(error.message); },
    });
  };

  useEffect(() => {
    const stop = () => {
      key.current = null;
      const id = pointer.current; pointer.current = null; pressBounds.current = null;
      if (id !== null && button.current?.hasPointerCapture(id)) button.current.releasePointerCapture(id);
      session.cancel(); latest.current.onProcessing(false);
    };
    if (!props.active) stop();
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener('blur', stop);
    window.addEventListener('pagehide', stop);
    window.addEventListener('offline', stop);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', stop);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('offline', stop);
      document.removeEventListener('visibilitychange', hidden);
      stop();
    };
  }, [props.active, props.outputFormat, session]);

  const holding = phase === 'starting' || phase === 'recording';
  return <div className="hold-to-talk">
    <button ref={button} type="button" className={`button primary full hold-to-talk-button ${holding ? 'is-held' : ''}`}
      disabled={!props.active || phase === 'finishing'} aria-pressed={holding} aria-describedby={instructions}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || pointer.current !== null || key.current !== null) return;
        event.preventDefault();
        event.currentTarget.focus();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
        pointer.current = event.pointerId;
        pressBounds.current = event.currentTarget.getBoundingClientRect();
        press();
      }}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return;
        event.preventDefault();
        // Feedback may reflow on a small screen; judge intentional movement from the
        // area the user actually pressed, so a stationary release cannot be discarded.
        const bounds = pressBounds.current ?? event.currentTarget.getBoundingClientRect();
        const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        releasePointer();
        if (inside) session.release(); else cancel();
      }}
      onPointerCancel={event => { if (pointer.current === event.pointerId) cancel(); }}
      onLostPointerCapture={event => { if (pointer.current === event.pointerId) cancel(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (event.repeat || key.current !== null || pointer.current !== null) return;
        key.current = event.key; press();
      }}
      onKeyUp={event => {
        if (key.current !== event.key) return;
        event.preventDefault(); key.current = null; session.release();
      }}
      onBlur={() => { if (pointer.current !== null || key.current !== null) cancel(); }}
      onContextMenu={event => event.preventDefault()}>
      <span className="hold-button-icon" aria-hidden="true"><Mic size={30}/></span><span className="hold-button-copy"><strong>{phase === 'starting' ? '麦克风准备中' : phase === 'recording' ? '正在听你说' : phase === 'finishing' ? '整理声音中' : '按住说话'}</strong><small>{phase === 'starting' ? '等一下再说' : phase === 'recording' ? '松手发送' : phase === 'finishing' ? '马上就好' : '松手就发送'}</small></span>
    </button>
    <p id={instructions} className="hold-instructions">鼠标或手指按住；键盘按住空格或回车，松开发送。移到按钮外松手或按 Esc 取消。每次最多 30 秒，超时这段不会发送。</p>
  </div>;
}
