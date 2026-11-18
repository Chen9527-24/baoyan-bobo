import { ApiError } from './api';

export type RealtimeEvent =
 | { type: 'ready' }
 | { type: 'interrupted' }
 | { type: 'speech-start'; utteranceId: string; responseId: string; interrupted: boolean }
 | { type: 'input-ended'; inputId: string; reason: 'vad' | 'manual' }
 | { type: 'transcript'; text: string; final: boolean; utteranceId?: string }
 | { type: 'reply-text'; text: string; final: boolean; responseId: string }
 | { type: 'audio'; audioBase64: string; sampleRate: 24000; responseId: string }
 | { type: 'reply-end'; responseId: string }
 | { type: 'error'; code?: string }
 | { type: 'ended'; reason?: string };

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
export function parseRealtimeEvent(raw: string): RealtimeEvent | undefined {
 if (raw.length > 260000) throw new Error('实时语音消息过大。');
 const data: unknown = JSON.parse(raw);
 if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('实时语音消息不完整。');
 const value = data as Record<string, unknown>;
 if (value.type === 'ready' || value.type === 'interrupted') return { type: value.type };
 if (value.type === 'speech-start') {
  if (!identifier(value.utteranceId) || !identifier(value.responseId) || typeof value.interrupted !== 'boolean') throw new Error('实时说话标识不完整。');
  return { type: 'speech-start', utteranceId: value.utteranceId, responseId: value.responseId, interrupted: value.interrupted };
 }
 if (value.type === 'input-ended') {
  if (!identifier(value.inputId) || !['vad', 'manual'].includes(String(value.reason))) throw new Error('实时收音标识不完整。');
  return { type: 'input-ended', inputId: value.inputId, reason: value.reason as 'vad' | 'manual' };
 }
 if (value.type === 'ended') return { type: 'ended', reason: identifier(value.reason) ? value.reason : undefined };
 if (value.type === 'error') return { type: 'error', code: identifier(value.code) ? value.code : undefined };
 if (value.type === 'transcript' || value.type === 'reply-text') {
  if (typeof value.text !== 'string' || value.text.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text) || typeof value.final !== 'boolean') throw new Error('实时字幕不完整。');
  if (value.type === 'transcript') return { type: 'transcript', text: value.text, final: value.final, utteranceId: identifier(value.utteranceId) ? value.utteranceId : undefined };
  if (!identifier(value.responseId)) throw new Error('实时回复标识不完整。');
  return { type: 'reply-text', text: value.text, final: value.final, responseId: value.responseId };
 }
 if (value.type === 'audio') {
  if (!identifier(value.responseId) || typeof value.audioBase64 !== 'string' || !value.audioBase64.length || value.audioBase64.length > 256000 || value.sampleRate !== 24000) throw new Error('实时声音不完整。');
  return { type: 'audio', audioBase64: value.audioBase64, sampleRate: 24000, responseId: value.responseId };
 }
 if (value.type === 'reply-end') {
  if (!identifier(value.responseId)) throw new Error('实时回复标识不完整。');
  return { type: 'reply-end', responseId: value.responseId };
 }
 return undefined;
}

/** Captions cannot appear before the audio clock starts; cancelled response IDs stay cancelled. */
export class RealtimeReplyGate {
 private id?: string;
 private text = '';
 private audible = false;
 private finished = false;
 private acknowledged = false;
 private blocked = new Set<string>();
 private expected?: string;
 accept(id: string): boolean {
  if (this.expected && this.expected !== id) return false;
  if (this.blocked.has(id)) return false;
  if (this.id && this.id !== id) this.blocked.add(this.id);
  if (this.id !== id) { this.id = id; this.text = ''; this.audible = false; this.finished = false; this.acknowledged = false; }
  if (this.blocked.size > 100) throw new Error('这次实时聊天先结束，休息后再开始。');
  return true;
 }
 update(id: string, text: string): string | undefined { if (!this.accept(id)) return undefined; this.text = text; return this.audible ? text : undefined; }
 played(id: string): string | undefined { if (id !== this.id || this.blocked.has(id)) return undefined; this.audible = true; return this.text; }
 done(id: string) { if (!this.accept(id)) return false; this.finished = true; return true; }
 get ended() { return this.finished; }
 get hasAudioStarted() { return this.audible; }
 takeHeardAcknowledgement(playbackPending: boolean): string | undefined {
  if (!this.id || !this.finished || !this.audible || playbackPending || this.acknowledged) return undefined;
  this.acknowledged = true; return this.id;
 }
 beginTurn(id: string) { this.interrupt(); this.expected = id; }
 interrupt() { if (this.id) this.blocked.add(this.id); this.id = undefined; this.expected = undefined; this.text = ''; this.audible = false; this.finished = false; this.acknowledged = false; }
}

export function realtimeFailureMessage(error: unknown): string {
 if (error instanceof ApiError) {
  if (error.code === 'REALTIME_SAFETY') return '这件事先请身边的大人一起帮忙。实时体验已停止，可以回到普通聊天。';
  if (error.code === 'REALTIME_PRIVACY') return '私人的信息先别说出来哦。这次体验已停止，可以回到普通聊天。';
  if (error.code === 'REALTIME_MEMORY_ACTION') return '要修改或删除记忆，请回到记忆小本。这次体验已停止。';
  if (error.code === 'ACCOUNT_REPLACED') return '账号已在另一台设备登录，这里的收音和播放已停止。';
  if (error.code === 'TRIAL_EXPIRED') return '这次内测已结束，收音和播放已停止。';
  if (error.code === 'CALL_EXPIRED') return '这次聊天时间到了，和家人一起休息一下吧。';
  if (error.status === 401) return '账号登录已失效，收音和播放已停止，请重新登录。';
  if (error.code === 'DAILY_LIMIT') return '今天的聊天时间用完啦，明天再来。';
  if (error.code === 'CALL_ACTIVE') return '另一次聊天还在进行，请结束后再来体验。';
  if (error.code === 'REALTIME_NOT_CONFIGURED' || error.code === 'REALTIME_UNAVAILABLE') return '实时语音服务还没有准备好，可以先回到普通聊天。';
  if (error.status === 403) return '当前账号或家庭暂时无法使用，请返回查看状态。';
 }
 return '实时语音这次没有接通，请重新开始，或回到普通聊天。';
}

export function realtimeEndedMessage(reason?: string): string {
 if (reason === 'account-replaced') return '账号已在另一台设备登录，这里的收音和播放已停止。';
 if (reason === 'account-logout') return '账号已退出，收音和播放已停止。';
 if (reason === 'trial-expired') return '这次内测已结束，收音和播放已停止。';
 if (reason === 'expired') return '这次聊天时间到了，和家人一起休息一下吧。';
 return '这次实时连接已结束，收音和播放已停止。';
}

export function estimateRealtimeAudioCost(inputSeconds?: number, outputSeconds?: number): number | undefined {
 if (inputSeconds === undefined && outputSeconds === undefined) return undefined;
 return (inputSeconds ?? 0) * 6.25 * 80 / 1_000_000 + (outputSeconds ?? 0) * 25 * 300 / 1_000_000;
}

/** A released recording may still be uploading when the user leaves. Never commit that stale turn. */
export async function finishRealtimeUpload(flush: () => Promise<void>, isCurrent: () => boolean, onSubmitted: () => void, commit: () => Promise<unknown>): Promise<boolean> {
 await flush();
 if (!isCurrent()) return false;
 onSubmitted();
 await commit();
 return isCurrent();
}

export const canInterruptRealtime = (phase: string) => phase === 'thinking' || phase === 'speaking';
