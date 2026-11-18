import { useEffect, useRef, useState } from 'react';
import { CalibrationLibrary } from './CalibrationLibrary';
import { ReplyAdjustment } from './ReplyAdjustment';
import type { CalibrationDraft } from '../lib/calibration';
import './PromptLabContext.css';

/** Natural-language reply coaching and the household's saved scenes. */
export function PromptLab({ onBusyChange, initialCalibrationDraft, onCalibrationDraftConsumed, childId }: {
  onBusyChange: (busy: boolean) => void;
  initialCalibrationDraft?: CalibrationDraft;
  onCalibrationDraftConsumed?: () => void;
  childId: string;
}) {
  const [mode, setMode] = useState<'adjust' | 'library'>('adjust');
  const [draft, setDraft] = useState<CalibrationDraft | undefined>(initialCalibrationDraft);
  const [selectedScene, setSelectedScene] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const consumed = useRef<CalibrationDraft | undefined>(undefined);
  const onConsumedRef = useRef(onCalibrationDraftConsumed); onConsumedRef.current = onCalibrationDraftConsumed;
  const notifyBusy = (value: boolean) => { setBusy(value); onBusyChange(value); };
  const expire = () => { setExpired(true); setDraft(undefined); setSelectedScene(undefined); notifyBusy(false); };
  useEffect(() => {
    if (!initialCalibrationDraft || consumed.current === initialCalibrationDraft || expired) return;
    consumed.current = initialCalibrationDraft; setDraft({ ...initialCalibrationDraft }); setMode('adjust');
    onConsumedRef.current?.();
  }, [initialCalibrationDraft, expired]);
  const adjust = (value: CalibrationDraft) => {
    if (busy || expired) return;
    setDraft({ ...value }); setMode('adjust');
  };
  return <div className="reply-workbench">
    <nav className="reply-workbench-tabs" aria-label="回答调整工具">
      {([{ id: 'adjust', label: '改回答' }, { id: 'library', label: '我的场景库' }] as const).map(item =>
        <button type="button" key={item.id} disabled={busy || expired} className={mode === item.id ? 'selected' : ''} aria-current={mode === item.id ? 'page' : undefined} onClick={() => setMode(item.id)}>{item.label}</button>)}
    </nav>
    {expired ? <p className="error-note" role="alert">家长验证或体验对象已变化，本页资料已清除。请回到宝妍，再进入家长管理。</p> : mode === 'adjust' ?
      <ReplyAdjustment initialDraft={draft} childId={childId} onBusyChange={notifyBusy} onAuthorizationExpired={expire} onDraftChange={setDraft} onSaved={item => { setSelectedScene(item.id); setMode('library'); }}/>
      : <CalibrationLibrary childId={childId} onBusyChange={notifyBusy} initialTab="cases" initialSelectedId={selectedScene} onAdjustCase={adjust} onAuthorizationExpired={expire}/>}
  </div>;
}
