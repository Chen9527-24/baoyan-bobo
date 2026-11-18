import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, operationId, post } from '../lib/api';
import type { Call } from '../lib/types';
import { pcmBase64, pcmFromBase64, RealtimeAudio, RealtimeUploadQueue } from '../lib/realtimeAudio';
import { parseRealtimeEvent, realtimeFailureMessage, realtimeEndedMessage, RealtimeReplyGate } from '../lib/realtimeClient';

type Phase = 'idle' | 'connecting' | 'preparing' | 'listening' | 'recording' | 'thinking' | 'speaking' | 'ended';
interface Session { sessionId: string; mode: 'continuous'; memoryAvailable: boolean; input: { sampleRate: number; channels: number; encoding: string }; output: { sampleRate: number; channels: number; encoding: string } }
interface Metrics { inputSeconds?: number; outputSeconds?: number; firstAudioMs?: number }

export function useRealtimeExperience(onFinished: () => void) {
 const [phase, setPhase] = useState<Phase>('idle'); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
 const [memoryAvailable, setMemoryAvailable] = useState<boolean | undefined>(undefined); const [microphoneActive, setMicrophoneActive] = useState(false);
 const [metrics, setMetrics] = useState<Metrics>({});
 const metricsRef = useRef<Metrics>({}); const submittedAt = useRef<number | undefined>(undefined); const utterance = useRef<string | undefined>(undefined);
 const [transcript, setTranscript] = useState(''); const [reply, setReply] = useState(''); const [remaining, setRemaining] = useState(0); const [playback, setPlayback] = useState(false);
 const currentPhase = useRef<Phase>('idle'); const epoch = useRef(0); const mounted = useRef(true); const starting = useRef(false);
 const active = useRef<Call | undefined>(undefined); const session = useRef<Session | undefined>(undefined); const audio = useRef<RealtimeAudio | undefined>(undefined); const stream = useRef<EventSource | undefined>(undefined); const upload = useRef<RealtimeUploadQueue | undefined>(undefined);
 const deadline = useRef(0); const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined); const heartbeat = useRef<ReturnType<typeof setInterval> | undefined>(undefined); const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 const gate = useRef(new RealtimeReplyGate()); const finished = useRef(onFinished); finished.current = onFinished;
 const changePhase = useCallback((next: Phase) => { currentPhase.current = next; if (mounted.current) setPhase(next); }, []);
 const stop = useCallback((message = '这次体验结束啦，收音和播放已停止。', failed = false, normal = true) => {
  ++epoch.current; starting.current = false; utterance.current = undefined;
  clearInterval(tick.current); clearInterval(heartbeat.current); clearTimeout(watchdog.current);
  const events = stream.current; stream.current = undefined; if (!normal || failed) events?.close(); upload.current?.stop(); upload.current = undefined;
  audio.current?.close(); audio.current = undefined; session.current = undefined; gate.current.interrupt();
  const call = active.current; active.current = undefined;
  if (mounted.current) { setMetrics({ ...metricsRef.current }); setMicrophoneActive(false); setPlayback(false); setRemaining(0); setNotice(failed ? '' : message); setError(failed ? message : ''); changePhase('ended'); }
  const closeTimer = events ? setTimeout(() => events.close(), 3000) : undefined;
  if (call) void api(`/calls/${call.id}/end`, { method: 'POST', body: JSON.stringify({ reason: normal && !failed ? '实时语音体验结束' : 'realtime-abandoned' }), keepalive: true }).catch(() => {}).finally(() => { clearTimeout(closeTimer); events?.close(); if (mounted.current) finished.current(); });
  else { clearTimeout(closeTimer); events?.close(); }
 }, [changePhase]);
 const arm = useCallback((generation: number, delay = 35000) => { clearTimeout(watchdog.current); watchdog.current = setTimeout(() => { if (generation === epoch.current) stop('等待声音太久，已停止连接，请重新开始。', true); }, delay); }, [stop]);
 const markDrained = useCallback(() => {
  if (!gate.current.ended || audio.current?.hasPlayback || !['speaking', 'thinking'].includes(currentPhase.current)) return;
  clearTimeout(watchdog.current); changePhase('listening');
  const responseId = gate.current.takeHeardAcknowledgement(Boolean(audio.current?.hasPlayback)), call = active.current, connected = session.current, generation = epoch.current;
  if (!responseId || !call || !connected) return;
  // Only the complete, actually played response may enter the remembered conversation.
  void post(`/calls/${call.id}/realtime/heard`, { sessionId: connected.sessionId, responseId }).catch(cause => {
   if (generation !== epoch.current) return;
   if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { window.dispatchEvent(new Event('baoyan:account-recheck')); stop(realtimeFailureMessage(cause), true); }
   else if (connected.memoryAvailable && mounted.current) setNotice('这轮聊天的记忆状态暂未确认，仍可以继续聊。');
  });
 }, [changePhase, stop]);
 const start = useCallback(async () => {
  if (starting.current || active.current || document.hidden) return;
  const generation = ++epoch.current; starting.current = true; metricsRef.current = {}; setMetrics({}); setMemoryAvailable(undefined); setMicrophoneActive(false); submittedAt.current = undefined; utterance.current = undefined; gate.current = new RealtimeReplyGate(); setError(''); setNotice(''); setReply(''); setTranscript(''); changePhase('connecting');
  const isCurrent = () => generation === epoch.current && mounted.current && !document.hidden;
  try {
   const sound = new RealtimeAudio(message => { if (isCurrent()) stop(message, true); }, value => { if (isCurrent()) setPlayback(value); });
   audio.current = sound; await sound.resume();
   if (!isCurrent()) return;
   const call = await post<Call>('/calls', { operationId: operationId(), voiceprintParticipation: false });
   if (!isCurrent()) { void post(`/calls/${call.id}/end`, { reason: 'realtime-abandoned' }).catch(() => {}); return; }
   active.current = call; deadline.current = Date.now() + call.remainingSeconds * 1000; setRemaining(call.remainingSeconds); arm(generation);
   tick.current = setInterval(() => { if (!isCurrent()) return; const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)); setRemaining(left); setMetrics({ ...metricsRef.current }); if (!left) stop('这次聊天时间到了，和家人一起休息一下吧。', false, false); }, 1000);
   let heartbeatPending = false;
   heartbeat.current = setInterval(() => { if (!isCurrent() || heartbeatPending) return; heartbeatPending = true; void post<{ remainingSeconds: number }>(`/calls/${call.id}/heartbeat`).then(value => { if (isCurrent()) { deadline.current = Date.now() + value.remainingSeconds * 1000; setRemaining(value.remainingSeconds); } }).catch(() => { if (isCurrent()) stop('连接中断，收音和播放已停止，请重新开始。', true); }).finally(() => { heartbeatPending = false; }); }, 20000);
   const connected = await post<Session>(`/calls/${call.id}/realtime/start`, { mode: 'continuous' });
   if (!isCurrent()) return;
   if (connected.mode !== 'continuous' || !/^[a-f0-9-]{36}$/i.test(connected.sessionId) || connected.input.sampleRate !== 16000 || connected.input.channels !== 1 || connected.input.encoding !== 'pcm_s16le' || connected.output.sampleRate !== 24000 || connected.output.channels !== 1 || connected.output.encoding !== 'pcm_s16le') throw new Error('不支持实时声音格式。');
   session.current = connected; setMemoryAvailable(connected.memoryAvailable === true);
   // One queue and sequence live for the whole call, including silence and the assistant's reply.
   upload.current = new RealtimeUploadQueue(async (bytes, sequence, signal) => {
    const result = await api<{ discarded?: boolean }>(`/calls/${call.id}/realtime/audio`, { method: 'POST', body: JSON.stringify({ sessionId: connected.sessionId, sequence, audioBase64: pcmBase64(bytes) }), signal });
    if (isCurrent() && !result.discarded) metricsRef.current.inputSeconds = (metricsRef.current.inputSeconds ?? 0) + bytes.length / 32000;
   }, message => { if (isCurrent()) stop(message.message, true); });
   let captureRequested = false;
   const beginCapture = async () => {
    if (!isCurrent() || captureRequested) return;
    captureRequested = true; changePhase('preparing'); arm(generation);
    try {
     const ready = await sound.startCapture(chunk => { if (isCurrent()) upload.current?.enqueue(chunk); });
     if (!isCurrent()) return;
     if (!ready) { stop('麦克风已停止，请重新开始。', false, false); return; }
     // A ready server does not mean the microphone is open; only the acquired stream does.
     setMicrophoneActive(true); clearTimeout(watchdog.current); changePhase('listening');
    } catch { if (isCurrent()) stop('麦克风没有打开，请允许录音后重新开始。', true); }
   };
   const events = new EventSource(`/api/calls/${call.id}/realtime/events?sessionId=${encodeURIComponent(connected.sessionId)}`); stream.current = events;
   events.addEventListener('realtime', (event: MessageEvent) => {
    if (!isCurrent()) return;
    try {
     const data = parseRealtimeEvent(event.data); if (!data) return;
     if (data.type === 'ready') { void beginCapture(); return; }
     if (data.type === 'error') { if (data.code === 'ACCOUNT_REPLACED') window.dispatchEvent(new Event('baoyan:account-recheck')); stop(realtimeFailureMessage(new ApiError('', 0, data.code)), true); return; }
     if (data.type === 'ended') { if (['account-replaced', 'account-logout'].includes(data.reason ?? '')) window.dispatchEvent(new Event('baoyan:account-recheck')); stop(realtimeEndedMessage(data.reason), false, false); return; }
     if (data.type === 'speech-start') {
      if (utterance.current === data.utteranceId) return;
      sound.clearPlayback(); gate.current.beginTurn(data.responseId); utterance.current = data.utteranceId;
      submittedAt.current = undefined; metricsRef.current.firstAudioMs = undefined; setMetrics({ ...metricsRef.current }); setTranscript(''); setReply(''); clearTimeout(watchdog.current); changePhase('recording'); return;
     }
     // These events belong to the older, one-utterance mode and must not close this microphone.
     if (data.type === 'input-ended' || data.type === 'interrupted') return;
     if (data.type === 'transcript') {
      if (data.utteranceId !== utterance.current) return;
      setTranscript(data.text);
      if (data.final) { if (submittedAt.current === undefined && !gate.current.hasAudioStarted) submittedAt.current = performance.now(); if (currentPhase.current !== 'speaking') changePhase('thinking'); arm(generation); }
      return;
     }
     if (!gate.current.accept(data.responseId)) return;
     if (data.type === 'reply-text') { const visible = gate.current.update(data.responseId, data.text); if (visible !== undefined) setReply(visible); arm(generation); return; }
     if (data.type === 'audio') {
      arm(generation);
      const bytes = pcmFromBase64(data.audioBase64); metricsRef.current.outputSeconds = (metricsRef.current.outputSeconds ?? 0) + bytes.length / 48000;
      sound.play(bytes, () => { if (!isCurrent()) return; const visible = gate.current.played(data.responseId); if (visible !== undefined) { if (submittedAt.current !== undefined) { metricsRef.current.firstAudioMs = Math.max(0, performance.now() - submittedAt.current); submittedAt.current = undefined; setMetrics({ ...metricsRef.current }); } setReply(visible); changePhase('speaking'); } }, () => { if (isCurrent()) markDrained(); });
      return;
     }
     if (data.type === 'reply-end') { gate.current.done(data.responseId); markDrained(); }
    } catch { stop('实时声音没有完整收到，已停止播放，请重新开始。', true); }
   });
   events.onerror = () => { if (isCurrent()) { events.close(); window.dispatchEvent(new Event('baoyan:account-recheck')); stop('连接断开了，收音和播放已停止，请重新开始。', true); } };
  } catch (cause) { if (isCurrent()) stop(realtimeFailureMessage(cause), true); }
  finally { if (generation === epoch.current) starting.current = false; }
 }, [arm, changePhase, markDrained, stop]);
 useEffect(() => {
  mounted.current = true;
  const hidden = () => { if (document.hidden && (active.current || starting.current)) stop('离开页面后，收音和播放已停止。', false, false); };
  const offline = () => { if (active.current || starting.current) stop('网络断开了，收音和播放已停止。', true); };
  const leave = () => { if (active.current || starting.current) stop('离开页面后，收音和播放已停止。', false, false); };
  document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', leave); window.addEventListener('offline', offline);
  return () => { mounted.current = false; document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leave); window.removeEventListener('offline', offline); stop('', false, false); };
 }, [stop]);
 return { phase, error, notice, transcript, reply, remaining, playback, microphoneActive, metrics, memoryAvailable, active: !['idle', 'ended'].includes(phase), start, stop };
}
