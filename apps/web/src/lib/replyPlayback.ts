import type { PlaybackResult } from '../audio';
import { ApiError, responseApiError } from './api';
import type { ReplySegment } from './types';
import { speechRequestBody } from './replySegments';
import { MAX_SPEECH_AUDIO_BYTES } from './speechStream';

export type ReplyReveal = 'speech' | 'text-only';
interface ReplyPlaybackInterruption {
  epoch: { current: number };
  request: { current: AbortController | null };
  clearActivity: () => void;
  cancelAudio: () => void;
}

/** Invalidate before aborting: even synchronous cancellation callbacks are stale. */
export function interruptReplyPlayback(options: ReplyPlaybackInterruption): { previousGeneration: number; generation: number } {
  const previousGeneration = options.epoch.current, generation = ++options.epoch.current;
  options.request.current?.abort(); options.clearActivity(); options.cancelAudio();
  return { previousGeneration, generation };
}

interface ReplyPlaybackOptions {
  isCurrent: () => boolean;
  playback?: (onStart: () => void) => Promise<PlaybackResult>;
  preparing: () => void;
  reveal: (mode: ReplyReveal) => void;
  speaking: () => void;
  ready: () => void;
  failed: (error: unknown) => void;
}

/** A rejected context is not a voice failure: it must never reveal a withheld old reply. */
export function permitsTextFallback(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (error instanceof ApiError && ([401, 403, 404, 409, 410, 499].includes(error.status)
    || ['CONTEXT_CHANGED', 'REPLY_EXPIRED', 'CALL_EXPIRED', 'DEVICE_REQUIRED', 'TRIAL_EXPIRED', 'REQUEST_ABORTED'].includes(error.code ?? ''))) return false;
  return true;
}

/** Publish reply and candidate together only once playback truly starts, or on a safe text fallback. */
export async function presentReplyWithPlayback(options: ReplyPlaybackOptions): Promise<void> {
  if (!options.isCurrent()) return;
  let revealed: ReplyReveal | undefined;
  let settled = false;
  const reveal = (mode: ReplyReveal) => {
    if (!options.isCurrent() || revealed === mode) return;
    revealed = mode; options.reveal(mode);
  };
  if (!options.playback) { reveal('text-only'); if (options.isCurrent()) options.ready(); return; }
  options.preparing();
  if (!options.isCurrent()) return;
  try {
    const result = await options.playback(() => {
      if (settled || revealed || !options.isCurrent()) return;
      reveal('speech'); if (options.isCurrent()) options.speaking();
    });
    if (!options.isCurrent() || result === 'cancelled') return;
    if (!revealed) throw new Error('声音没有开始播放。');
    options.ready();
  } catch (error) {
    if (!options.isCurrent()) return;
    if (permitsTextFallback(error)) reveal('text-only');
    if (options.isCurrent()) options.failed(error);
  } finally { settled = true; }
}

interface SegmentedReplyPlaybackOptions {
  isCurrent: () => boolean;
  reply: string;
  segments: readonly ReplySegment[];
  playback?: (segment: ReplySegment, index: number, onStart: () => void) => Promise<PlaybackResult>;
  preparing: (index: number) => void;
  reveal: (text: string, mode: ReplyReveal, segment?: ReplySegment) => void;
  speaking: (index: number) => void;
  ready: () => void;
  failed: (error: unknown, afterStart: boolean) => void;
}

/** Serial audible delivery; a playback implementation may buffer one future segment without revealing it. */
export async function presentReplySegmentsWithPlayback(options: SegmentedReplyPlaybackOptions): Promise<void> {
  if (!options.isCurrent()) return;
  if (!options.playback) {
    options.reveal(options.reply, 'text-only');
    if (options.isCurrent()) options.ready();
    return;
  }
  let anyStarted = false;
  for (let index = 0; index < options.segments.length; index++) {
    if (!options.isCurrent()) return;
    const segment = options.segments[index]!;
    let started = false, settled = false;
    options.preparing(index);
    if (!options.isCurrent()) return;
    try {
      const result = await options.playback(segment, index, () => {
        if (settled || started || !options.isCurrent()) return;
        started = true; anyStarted = true;
        options.reveal(options.segments.slice(0, index + 1).map(item => item.text).join('\n\n'), 'speech', segment);
        if (options.isCurrent()) options.speaking(index);
      });
      if (!options.isCurrent() || result === 'cancelled') return;
      if (!started) throw new Error('声音没有开始播放。');
    } catch (error) {
      if (!options.isCurrent()) return;
      // A mid-reply failure makes the rest readable; it never replays old audio.
      if (permitsTextFallback(error)) options.reveal(options.reply, 'text-only');
      if (options.isCurrent()) options.failed(error, anyStarted);
      return;
    } finally { settled = true; }
  }
  if (options.isCurrent()) options.ready();
}

/** Bound the wait for TTS and its download without converting a user cancellation into fallback. */
export async function fetchReplySpeech(callId: string, replyId: string, signal?: AbortSignal,
  timeoutMs = 35_000, request: typeof fetch = fetch, endpoint?: string, segmentIndex?: number): Promise<Blob> {
  const body = speechRequestBody(replyId, segmentIndex);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const pending = request(endpoint ?? `/api/calls/${callId}/speech`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
    const response = await cancellableSpeechRead(pending, controller.signal);
    if (!response.ok) throw await responseApiError(response, '声音暂时不可用。');
    const blob = await boundedSpeechBlob(response, controller.signal);
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return blob;
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new Error('声音准备超时。');
    throw error;
  } finally { globalThis.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function cancellableSpeechRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(new DOMException('Cancelled', 'AbortError')); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, cause => { signal.removeEventListener('abort', abort); reject(cause); });
  });
}

/** A future Blob cannot grow without limit while the preceding segment is speaking. */
async function boundedSpeechBlob(response: Response, signal: AbortSignal): Promise<Blob> {
  if (Number(response.headers.get('content-length')) > MAX_SPEECH_AUDIO_BYTES) { void response.body?.cancel().catch(() => {}); throw new Error('声音数据超过本轮限制。'); }
  if (!response.body) throw new Error('声音数据不完整。');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0, complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const part = await cancellableSpeechRead(reader.read(), signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_SPEECH_AUDIO_BYTES) throw new Error('声音数据超过本轮限制。');
      chunks.push(part.value as Uint8Array<ArrayBuffer>);
    }
    if (!total) throw new Error('声音数据不完整。');
    complete = true;
    return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Pending cancellation owns the reader. */ }
  }
}
