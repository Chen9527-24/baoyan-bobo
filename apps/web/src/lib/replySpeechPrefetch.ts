import type { AudioController, PlaybackResult } from '../audio';
import { permitsTextFallback } from './replyPlayback';
import { MAX_SPEECH_AUDIO_BYTES } from './speechStream';
import type { ReplySegment } from './types';

export const MAX_BUFFERED_SPEECH_BYTES = MAX_SPEECH_AUDIO_BYTES;
// Initial short phrase-boundary targets, pending real-device listening. TTS
// punctuation remains responsible for pauses inside a phrase; no breath sounds.
export const REPLY_PHRASE_PAUSE_MS = { bright: 180, natural: 220, clear: 240, gentle: 280 } as const;
const abortError = () => new DOMException('Cancelled', 'AbortError');

/** One consumer, bounded bytes, and an independently cancellable network producer. */
class PcmBuffer implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private total = 0;
  private done = false;
  private error: unknown;
  private wake: (() => void) | undefined;
  private consumed = false;

  constructor(source: AsyncIterable<Uint8Array>, private readonly signal: AbortSignal,
    complete: () => void, failed: (cause: unknown) => void) {
    const abort = () => this.finish(abortError(), true);
    signal.addEventListener('abort', abort, { once: true });
    void (async () => {
      try {
        if (signal.aborted) throw abortError();
        for await (const chunk of source) {
          if (signal.aborted) throw abortError();
          if (!(chunk instanceof Uint8Array) || !chunk.byteLength) throw new Error('声音数据不完整。');
          this.total += chunk.byteLength;
          if (this.total > MAX_BUFFERED_SPEECH_BYTES || this.chunks.length >= 10_000) throw new Error('声音数据超过本轮限制。');
          this.chunks.push(chunk); this.notify();
        }
        if (signal.aborted) throw abortError();
        this.finish(); complete();
      } catch (cause) {
        this.finish(cause, true);
        if (!signal.aborted) failed(cause);
      } finally { signal.removeEventListener('abort', abort); }
    })();
  }
  private notify() { const wake = this.wake; this.wake = undefined; wake?.(); }
  private finish(error?: unknown, clear = false) {
    this.done = true; this.error = error;
    if (clear) this.chunks = [];
    this.notify();
  }
  clear() { this.finish(abortError(), true); }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    if (this.consumed) throw new Error('这段声音已播放，不能重复播放。');
    this.consumed = true;
    while (true) {
      if (this.signal.aborted) throw abortError();
      if (this.error) throw this.error;
      const chunk = this.chunks.shift();
      if (chunk) { yield chunk; continue; }
      if (this.done) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

interface SpeechPrefetchOptions {
  segmentCount: number;
  segments?: readonly ReplySegment[];
  now?: () => number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  streaming: boolean;
  audio: Pick<AudioController, 'playPcmStream' | 'playBlob' | 'stopPlayback'>;
  fetchPcm: (index: number, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  fetchBlob: (index: number, signal: AbortSignal) => Promise<Blob>;
  onActivityChange?: (active: boolean) => void;
}
type Resource = {
  index: number; controller: AbortController; networkComplete: boolean; started: boolean;
  pcm?: PcmBuffer; blob?: Promise<Blob>;
};

/** At most the current segment and one future segment; never overlap provider requests or retry. */
export function createReplySpeechPrefetch(options: SpeechPrefetchOptions) {
  if (!Number.isInteger(options.segmentCount) || options.segmentCount < 1 || options.segmentCount > 3) throw new Error('声音段落无效。');
  if (options.segments && options.segments.length !== options.segmentCount) throw new Error('声音段落无效。');
  const pauses = options.segments?.map(segment => REPLY_PHRASE_PAUSE_MS[segment.expression]);
  if (pauses?.some(value => !Number.isFinite(value))) throw new Error('声音段落无效。');
  const now = options.now ?? (() => performance.now());
  let disposed = false, playing = false, expectedIndex = 0, active: Resource | undefined, next: Resource | undefined;
  let previousEndedAt: number | undefined;
  let fatal: unknown;
  const resources = new Set<Resource>();
  const current = () => !disposed && !options.signal?.aborted && options.isCurrent();
  const release = (resource: Resource) => {
    resources.delete(resource); resource.controller.abort(); resource.pcm?.clear(); resource.pcm = undefined; resource.blob = undefined;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; options.signal?.removeEventListener('abort', abort);
    for (const resource of resources) release(resource);
    active = undefined; next = undefined;
  };
  const abort = () => { dispose(); options.audio.stopPlayback(); };
  options.signal?.addEventListener('abort', abort, { once: true });

  const failed = (cause: unknown) => {
    // A prefetched permission rejection must stop old speech before SSE arrives.
    if (current() && !permitsTextFallback(cause)) { fatal = cause; dispose(); options.audio.stopPlayback(); }
  };
  const prefetch = (resource: Resource) => {
    if (!current() || active !== resource || !resource.started || !resource.networkComplete || next || resource.index + 1 >= options.segmentCount) return;
    next = load(resource.index + 1);
  };
  const load = (index: number): Resource => {
    const resource: Resource = { index, controller: new AbortController(), networkComplete: false, started: false };
    resources.add(resource);
    const complete = () => { if (current()) { resource.networkComplete = true; prefetch(resource); } };
    if (options.streaming) resource.pcm = new PcmBuffer((async function* () {
      yield* options.fetchPcm(index, resource.controller.signal);
    })(), resource.controller.signal, complete, failed);
    else {
      resource.blob = Promise.resolve().then(() => {
        if (!current() || resource.controller.signal.aborted) throw abortError();
        return options.fetchBlob(index, resource.controller.signal);
      }).then(blob => {
        if (!current() || resource.controller.signal.aborted) throw abortError();
        if (!blob.size || blob.size > MAX_BUFFERED_SPEECH_BYTES) throw new Error('声音数据超过本轮限制。');
        complete(); return blob;
      });
      void resource.blob.catch(failed); // A future failure is consumed once at handoff, never an unhandled rejection.
    }
    return resource;
  };
  const play = async (index: number, onStart: () => void): Promise<PlaybackResult> => {
    if (!current()) { if (fatal) throw fatal; return 'cancelled'; }
    if (playing || index !== expectedIndex || index >= options.segmentCount) throw new Error('声音段落顺序无效，已停止播放。');
    expectedIndex++; playing = true;
    let resource = next;
    next = undefined;
    if (resource && resource.index !== index) throw new Error('声音段落顺序无效，已停止播放。');
    if (resource) active = resource;
    const began = () => {
      if (!current() || !resource || resource.started) return;
      resource.started = true; onStart();
      if (current()) prefetch(resource);
    };
    // One absolute boundary includes network preparation and the player's own
    // warm-up. AudioController applies max(warm-up, remaining gap), never a
    // fixed sleep after the next segment has arrived.
    const notBeforeMs = index > 0 && pauses && previousEndedAt !== undefined ? previousEndedAt + pauses[index - 1]! : undefined;
    // PCM's start includes transport time. A Blob is already fully downloaded
    // before playback, so only the existing eight-second browser start window applies.
    const playbackOptions = { onStart: began, onActivityChange: (value: boolean) => { if (current()) options.onActivityChange?.(value); }, startTimeoutMs: options.streaming ? 35000 : 8000,
      ...(notBeforeMs !== undefined ? { notBeforeMs } : {}) };
    try {
      let result: PlaybackResult;
      if (options.streaming) result = await options.audio.playPcmStream(mediaSignal => {
        // AudioController resumes the browser audio context before the first request.
        if (!current() || mediaSignal.aborted) throw abortError();
        resource ??= load(index); active = resource;
        const stop = () => resource!.controller.abort();
        mediaSignal.addEventListener('abort', stop, { once: true });
        const pcm = resource.pcm!;
        return (async function* () { try { yield* pcm; } finally { mediaSignal.removeEventListener('abort', stop); } })();
      }, playbackOptions);
      else {
        resource ??= load(index); active = resource;
        const blob = await resource.blob!;
        if (fatal) throw fatal;
        if (!current()) return 'cancelled';
        result = await options.audio.playBlob(blob, playbackOptions);
      }
      if (fatal) throw fatal;
      if (current() && result === 'ended') previousEndedAt = now();
      return current() ? result : 'cancelled';
    } finally {
      playing = false;
      if (resource) release(resource);
      if (active === resource) active = undefined;
    }
  };
  return { play, dispose, isReady: (index: number) => current() && next?.index === index && next.networkComplete };
}
