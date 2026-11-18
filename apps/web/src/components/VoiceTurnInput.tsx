import { useId, useState, type ComponentProps } from 'react';
import { AudioLines, Check, Hand, Mic, MicOff, Pause, PhoneOff, Repeat2 } from 'lucide-react';
import { VoiceInput } from './VoiceInput';
import { HoldToTalkInput } from './HoldToTalkInput';

export type VoiceMode = 'hold' | 'auto';

// Keep rapid microphone-level updates here, away from the avatar and the call hook.
export function VoiceTurnInput({showModeSelector=true,compact=false,modeSwitchDisabled=false,ready,preparing,mode,onModeChange,onHoldingChange,control,onEnd,...input}: ComponentProps<typeof VoiceInput> & {
  showModeSelector?:boolean;
  compact?:boolean;
  modeSwitchDisabled?:boolean;
  ready:boolean;
  preparing:boolean;
  mode:VoiceMode;
  onModeChange:(mode:VoiceMode)=>void;
  onHoldingChange:(holding:boolean)=>void;
  onEnd?:()=>void;
  control?:{kind:'resume'|'pause'|'interrupt';label:string;disabled:boolean;onClick:()=>void};
}) {
  const [level,setLevel]=useState(0);
  const [heard,setHeard]=useState(false);
  const [holding,setHolding]=useState(false);
  const helpId=useId();
  const strength=Math.min(100,Math.round(Math.max(0,level)*1400));
  const capturing=input.active&&ready;
  const switchingDisabled=holding||preparing||modeSwitchDisabled;
  const callbacks={onLevel:setLevel,onSpeechStart:()=>setHeard(true),onReady:(value:boolean)=>{
    if(!value){setLevel(0);setHeard(false);}
    input.onReady(value);
  }};
  const help=capturing?(mode==='hold'?'请继续按住说话，停顿不会发送；松手发送，移出按钮后松手取消。':'说话时音量条会动；说完停顿一会儿，或点“说完了，发送”。'):mode==='hold'?(!holding?'按住说话，松手发送。未按住时不收音。':'请允许麦克风，并等显示“正在听你说”后再说。松手会取消本次准备。'):'先点“开始说话”，允许麦克风后，等显示“正在听你说”再说。';
  return <div className={`voice-turn-input ${compact?'compact':''}`}>
    {showModeSelector?<div className="voice-mode-compact"><span>{mode==='hold'?<Hand size={16} aria-hidden="true"/>:<AudioLines size={16} aria-hidden="true"/>}{mode==='hold'?'按住说 · 松手发送':'自由说 · 停顿发送'}</span><button type="button" className="text-button voice-mode-toggle" disabled={switchingDisabled} onClick={()=>onModeChange(mode==='hold'?'auto':'hold')}><Repeat2 size={16} aria-hidden="true"/>{mode==='hold'?'换成自由说':'换成按住说'}</button>{onEnd?<button type="button" className="voice-end-action" aria-label="结束聊天" onClick={onEnd}><PhoneOff size={16} aria-hidden="true"/><span>结束</span></button>:null}</div>:null}
    {mode==='auto'?<VoiceInput {...input} {...callbacks}/>:null}
    {/* Keep the press session mounted while conversion completes; hiding a disabled control must not cancel that conversion. */}
    {mode==='hold'?<div hidden={!!control}><HoldToTalkInput {...input} {...callbacks} onHoldingChange={value=>{setHolding(value);onHoldingChange(value);}}/></div>:null}
    {control?<button type="button" className={`button primary full voice-primary-action action-${control.kind}`} aria-label={control.label} disabled={control.disabled} onClick={control.onClick}>{control.kind==='pause'?<Pause size={24} aria-hidden="true"/>:control.kind==='interrupt'?<Hand size={24} aria-hidden="true"/>:<Mic size={24} aria-hidden="true"/>}<span>{control.label}</span></button>:null}
    {!preparing&&(input.active||!compact)?<div className={`listening-feedback ${capturing?'is-ready':''}`} aria-describedby={helpId}>
      <div className={compact?'sr-only':'listening-feedback-top'}>{capturing?<Mic size={18} aria-hidden="true"/>:<MicOff size={18} aria-hidden="true"/>}<strong>{capturing?(heard?'听到你啦':'正在听你说'):holding?'麦克风准备中':'麦克风没打开'}</strong>{!compact?<span>{capturing?'正在收音':'尚未收音'}</span>:null}</div>
      <div className="input-level" role="meter" aria-label="麦克风输入音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={capturing?strength:0}><span style={{width:`${capturing?strength:0}%`}}/></div>
      <p id={helpId} className={compact?'sr-only':'voice-input-help'}>{help}{mode==='hold'?'每次最多30秒；按住空格或回车也能说话，松开发送，按 Esc 取消。超时这段不会发送。':''}说完后显示识别文字，暂不逐字显示。</p>
      {mode==='auto'&&input.active&&(!control||capturing&&heard)?<button type="button" className={control?'text-button voice-send-now':'button primary full finish-utterance'} disabled={!capturing} onClick={()=>input.audio.finishUtterance()}><Check size={18} aria-hidden="true"/>说完了，发送</button>:null}
      {!compact?<span className="transcription-hint">说完后显示识别文字，暂不逐字显示</span>:null}
    </div>:null}
  </div>;
}
