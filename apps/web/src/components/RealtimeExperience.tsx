import { ArrowLeft, Mic, PhoneOff, Radio, Volume2 } from 'lucide-react';
import type { Bootstrap, CallState } from '../lib/types';
import { timeLabel } from '../lib/api';
import { Avatar } from './Avatar';
import { useRealtimeExperience } from '../hooks/useRealtimeExperience';
import { estimateRealtimeAudioCost } from '../lib/realtimeClient';
import './RealtimeExperience.css';

const titles = { idle: '来和宝妍自由聊聊', connecting: '正在连接宝妍', preparing: '麦克风准备中，等一下再说', listening: '正在听，你可以直接说', recording: '听你说呢', thinking: '宝妍正在想一想', speaking: '宝妍正在说 · 可以直接插话', ended: '这次先聊到这里' };
export function RealtimeExperience({ data, onClose, onFinished }: { data: Bootstrap; onClose: () => void; onFinished: () => void }) {
 const session = useRealtimeExperience(onFinished); const configured = data.realtime?.configured === true;
 const estimatedCost = estimateRealtimeAudioCost(session.metrics.inputSeconds, session.metrics.outputSeconds);
 const state: CallState = session.phase === 'speaking' && session.playback ? 'speaking' : session.phase === 'thinking' ? 'processing' : session.phase === 'connecting' ? 'connecting' : session.phase === 'ended' ? 'ended' : session.active ? 'listening' : 'idle';
 const close = () => { session.stop(); onClose(); };
 return <main className="realtime-experience" aria-label="实时语音体验">
  <header className="realtime-heading"><button type="button" className="button ghost small" onClick={close}><ArrowLeft size={19}/><span>回到普通聊天</span></button><span className="realtime-badge"><Radio size={15}/>实时语音 · 体验版</span></header>
  <section className="realtime-character"><div><p className="eyebrow">宝妍 bobo</p><h1>听你说，陪你聊</h1><p>豆包直接听声音、用声音回应</p></div><Avatar state={state} view="portrait" emotion="warm" playbackActive={session.playback} listeningActive={session.microphoneActive && !session.playback} suspended={session.phase === 'preparing'} segmentText={session.reply}/></section>
  <section className="realtime-card" aria-label="实时聊天">
   <div className="realtime-status"><strong role="status">{!configured ? '实时语音暂未准备好' : titles[session.phase]}</strong><span>{session.active ? timeLabel(session.remaining) : `单次 ${data.child?.sessionMinutes ?? 10} 分钟`}</span></div>
   {session.memoryAvailable === false ? <p className="realtime-memory-note">这次体验不读取或记录专属记忆</p> : null}
   <div className="realtime-transcript" tabIndex={0} aria-label="聊天字幕，可上下滚动">
    {!configured ? <p className="realtime-empty">这个体验通道还没有连接好。可以先回到普通聊天，准备好后再来听听。</p> : null}
    {configured && !session.transcript && !session.reply && !session.notice ? <p className="realtime-empty">{session.microphoneActive ? '直接和宝妍说话就好。想插一句时，开口说，她会停下来听你。' : session.active ? '正在准备麦克风。看到“麦克风已打开”后，就可以直接说话了。' : '点一次开始，就能一直聊。不用每句点按钮，宝妍说话时也可以直接插话。'}</p> : null}
    {session.transcript ? <div className="realtime-bubble user"><small><Mic size={14}/>你刚才说</small><p aria-live="polite">{session.transcript}</p></div> : null}
    {session.reply ? <div className="realtime-bubble assistant"><small><Volume2 size={14}/>宝妍姐姐</small><p aria-live="polite">{session.reply}</p></div> : null}
    {session.notice ? <p role="status" className="realtime-empty">{session.notice}</p> : null}
    {session.error ? <p role="alert" className="error-note">{session.error}</p> : null}
   </div>
   <div className="realtime-dock">
    {!session.active ? <button type="button" className="button primary full realtime-primary" disabled={!configured || data.remainingDailySeconds <= 0} onClick={() => void session.start()}><Radio size={26}/><span>{data.remainingDailySeconds <= 0 ? '今天的聊天时间用完啦' : '开始体验'}</span></button> : <>
     <div className={`realtime-live ${session.microphoneActive ? 'is-listening' : ''}`} role="status"><Mic size={23} aria-hidden="true"/><span><strong>{session.microphoneActive ? '麦克风已打开' : '正在准备声音…'}</strong><small>{session.microphoneActive ? '一直在听 · 随时开口' : '准备好后再说话'}</small></span></div>
     <button type="button" className="realtime-end" onClick={() => session.stop()}><PhoneOff size={21}/><span>结束聊天</span></button>
    </>}
   </div>
  </section>
  <footer className="realtime-help"><span>宝妍用普通话或英语回应</span><details><summary>本次对比与说明</summary><div className="realtime-detail-body">
   <dl><div><dt>最近一次判停到播放</dt><dd>{session.metrics.firstAudioMs === undefined ? '尚未测得' : `${(session.metrics.firstAudioMs / 1000).toFixed(2)} 秒`}</dd></div><div><dt>持续收音已送达</dt><dd>{session.metrics.inputSeconds === undefined ? '尚未统计' : `${session.metrics.inputSeconds.toFixed(1)} 秒`}</dd></div><div><dt>收到的宝妍语音</dt><dd>{session.metrics.outputSeconds === undefined ? '尚未统计' : `${session.metrics.outputSeconds.toFixed(1)} 秒`}</dd></div><div><dt>本次音频费用估算</dt><dd>{estimatedCost === undefined ? '尚未估算' : `约 ${estimatedCost.toFixed(4)} 元`}</dd></div></dl>
   <p>从页面收到完整识别文字开始计时，终点为浏览器实际首播。持续收音包含停顿和宝妍说话时的声音；仅音频估算，另计文本 / 历史，非账单。</p><p>开始后麦克风保持打开，宝妍听到你再次开口就会停下回应。也可试试方言，是否听准请以你的体验为准。</p><p>实时体验暂不使用已采用的场景调整。图片、打字和调优请回普通聊天。</p><p>离开页面或断网后停止收音和播放。费用参考约 2–4 元 / 10 分钟，实际以平台账单为准。</p>
  </div></details></footer>
 </main>;
}
