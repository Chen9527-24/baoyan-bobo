/** Real-time PCM transport is deliberately independent of the established chat audio controller. */
export const REALTIME_INPUT_RATE = 16000;
export const REALTIME_OUTPUT_RATE = 24000;
export const REALTIME_FRAME_SAMPLES = 1600; // 100 ms; the server paces this into provider 20 ms frames.

export class StreamingPcm16Encoder {
 private input: number[] = [];
 private position = 0;
 private samples: number[] = [];
 constructor(private readonly sourceRate: number) {
  if (!Number.isFinite(sourceRate) || sourceRate < 8000 || sourceRate > 192000) throw new Error('不支持这个录音采样率。');
 }
 push(source: Float32Array): Uint8Array[] {
  for (const sample of source) this.input.push(Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0);
  const ratio = this.sourceRate / REALTIME_INPUT_RATE;
  while (this.position + 1 < this.input.length) {
   const index = Math.floor(this.position), fraction = this.position - index;
   this.samples.push(this.input[index]! * (1 - fraction) + this.input[index + 1]! * fraction);
   this.position += ratio;
  }
  const consumed = Math.min(Math.floor(this.position), Math.max(0, this.input.length - 1));
  this.input.splice(0, consumed); this.position -= consumed;
  const chunks: Uint8Array[] = [];
  while (this.samples.length >= REALTIME_FRAME_SAMPLES) chunks.push(this.encode(this.samples.splice(0, REALTIME_FRAME_SAMPLES)));
  return chunks;
 }
 finish(): Uint8Array | undefined {
  const pending = this.samples.splice(0); this.input = []; this.position = 0;
  return pending.length ? this.encode(pending) : undefined;
 }
 private encode(values: number[]) {
  const result = new Uint8Array(values.length * 2), view = new DataView(result.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true));
  return result;
 }
}

export function pcmBase64(bytes: Uint8Array): string {
 let value = ''; for (const byte of bytes) value += String.fromCharCode(byte);
 return btoa(value);
}
export function pcmFromBase64(value: string): Uint8Array {
 if (!value.length || value.length > 256000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('这段声音没有完整收到。');
 const decoded = atob(value);
 if (decoded.length % 2 !== 0) throw new Error('这段声音没有完整收到。');
 return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

/** One ordered, bounded upload queue. stop() makes every completion stale and aborts in-flight work. */
export class RealtimeUploadQueue {
 private chunks: Uint8Array[] = [];
 private pendingBytes = 0;
 private pumping = false;
 private stopped = false;
 private nextSequence = 0;
 private controller = new AbortController();
 private waiters: { resolve: () => void; reject: (reason: Error) => void }[] = [];
 constructor(private readonly send: (bytes: Uint8Array, sequence: number, signal: AbortSignal) => Promise<void>, private readonly onError: (error: Error) => void) {}
 enqueue(bytes: Uint8Array): boolean {
  if (this.stopped) return false;
  if (!bytes.length || bytes.length > 3200 || bytes.length % 2 !== 0) { this.fail(new Error('录音格式不完整，请重新开始。')); return false; }
  if (this.pendingBytes + bytes.length > REALTIME_INPUT_RATE * 2 * 3) { this.fail(new Error('网络跟不上说话速度，已停止收音，请重新开始。')); return false; }
  this.pendingBytes += bytes.length; this.chunks.push(bytes.slice()); void this.pump(); return true;
 }
 async flush(): Promise<void> {
  if (this.stopped) throw new Error('这次收音已停止。');
  if (!this.pumping && !this.chunks.length) return;
  return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
 }
 stop() {
  this.stopped = true; this.controller.abort(); this.chunks = []; this.pendingBytes = 0;
  for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('这次收音已停止。'));
 }
 private fail(error: Error) { if (this.stopped) return; this.stop(); this.onError(error); }
 private async pump() {
  if (this.pumping || this.stopped) return;
  this.pumping = true;
  try {
   while (!this.stopped && this.chunks.length) {
    const parts: Uint8Array[] = []; let size = 0;
    while (this.chunks.length && size + this.chunks[0]!.length <= 16000) { const part = this.chunks.shift()!; parts.push(part); size += part.length; }
    const chunk = new Uint8Array(size); let offset = 0; for (const part of parts) { chunk.set(part, offset); offset += part.length; }
    await this.send(chunk, this.nextSequence++, this.controller.signal);
    if (!this.stopped) this.pendingBytes -= chunk.length;
   }
   if (!this.stopped) for (const waiter of this.waiters.splice(0)) waiter.resolve();
  } catch { this.fail(new Error('声音没有送达，已停止收音，请重新开始。')); }
  finally { this.pumping = false; }
 }
}

type ContextWindow = Window & { webkitAudioContext?: typeof AudioContext };
export class RealtimeAudio {
 private readonly context: AudioContext;
 private captureGeneration = 0;
 private media?: MediaStream;
 private source?: MediaStreamAudioSourceNode;
 private processor?: ScriptProcessorNode;
 private silent?: GainNode;
 private encoder?: StreamingPcm16Encoder;
 private onChunk?: (chunk: Uint8Array) => void;
 private sources = new Set<AudioBufferSourceNode>();
 private timers = new Set<ReturnType<typeof setTimeout>>();
 private playbackGeneration = 0;
 private nextStart = 0;
 private closed = false;
 private listening = false;
 constructor(private readonly onFailure: (message: string) => void, private readonly onPlayback: (active: boolean) => void) {
  const Context = window.AudioContext ?? (window as ContextWindow).webkitAudioContext;
  if (!Context) throw new Error('这个浏览器暂不支持实时声音，请换浏览器或回到普通聊天。');
  this.context = new Context();
  this.context.onstatechange = () => {
   if (this.closed) return;
   if (this.context.state !== 'running' && (this.sources.size || this.listening)) this.onFailure('声音被系统暂停了，请点开始重新连接。');
  };
 }
 async resume() { if (this.closed) throw new Error('声音已关闭。'); await this.context.resume(); if (this.context.state !== 'running') throw new Error('请点开始允许播放声音。'); }
 async startCapture(onChunk: (chunk: Uint8Array) => void): Promise<boolean> {
  this.stopCapture(false);
  const generation = ++this.captureGeneration;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  if (this.closed || generation !== this.captureGeneration || document.hidden) { for (const track of stream.getTracks()) track.stop(); return false; }
  this.media = stream; this.encoder = new StreamingPcm16Encoder(this.context.sampleRate); this.onChunk = onChunk;
  try {
   await this.resume();
   if (this.closed || generation !== this.captureGeneration) { for (const track of stream.getTracks()) track.stop(); return false; }
   this.source = this.context.createMediaStreamSource(stream);
   // ScriptProcessor retains compatibility with iPhone/WeChat WebViews without installing a worklet asset.
   this.processor = this.context.createScriptProcessor(2048, 1, 1);
   this.silent = this.context.createGain(); this.silent.gain.value = 0;
   this.processor.onaudioprocess = event => {
    if (!this.listening || generation !== this.captureGeneration || this.closed) return;
    for (const chunk of this.encoder!.push(event.inputBuffer.getChannelData(0))) onChunk(chunk);
   };
   this.source.connect(this.processor); this.processor.connect(this.silent); this.silent.connect(this.context.destination);
   this.listening = true;
   for (const track of stream.getTracks()) track.onended = () => { if (generation === this.captureGeneration && !this.closed) this.onFailure('麦克风已被系统关闭，请重新开始。'); };
   return true;
  } catch (error) { this.stopCapture(false); throw error; }
 }
 stopCapture(flush: boolean) {
  ++this.captureGeneration; this.listening = false;
  if (flush) { const chunk = this.encoder?.finish(); if (chunk) this.onChunk?.(chunk); }
  this.encoder = undefined; this.onChunk = undefined;
  if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); this.processor = undefined; }
  this.source?.disconnect(); this.source = undefined; this.silent?.disconnect(); this.silent = undefined;
  for (const track of this.media?.getTracks() ?? []) { track.onended = null; track.stop(); } this.media = undefined;
 }
 play(bytes: Uint8Array, onStart: () => void, onDrained: () => void) {
  if (this.closed || !bytes.length || bytes.length % 2) throw new Error('这段声音没有完整收到。');
  if (this.context.state !== 'running') throw new Error('声音被系统暂停了，请重新开始。');
  const generation = this.playbackGeneration;
  const duration = bytes.length / 2 / REALTIME_OUTPUT_RATE;
  const starts = Math.max(this.context.currentTime + 0.015, this.nextStart);
  if (starts + duration - this.context.currentTime > 20) throw new Error('声音等待太久，已暂停，请重新开始。');
  const buffer = this.context.createBuffer(1, bytes.length / 2, REALTIME_OUTPUT_RATE), channel = buffer.getChannelData(0), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination); this.sources.add(source);
  this.nextStart = starts + duration;
  let notified = false;
  const markStarted = () => { if (!notified && !this.closed && generation === this.playbackGeneration && this.context.state === 'running' && this.context.currentTime >= starts) { notified = true; this.onPlayback(true); onStart(); } };
  // A tiny final PCM chunk may finish between the clock checks. onended still proves it played.
  source.onended = () => { markStarted(); source.disconnect(); this.sources.delete(source); if (generation !== this.playbackGeneration || this.closed) return; if (!this.sources.size) { this.onPlayback(false); onDrained(); } };
  source.start(starts);
  const startedAt = Date.now();
  const notify = () => {
   if (this.closed || generation !== this.playbackGeneration || !this.sources.has(source)) return;
   if (this.context.state === 'running' && this.context.currentTime >= starts) { markStarted(); return; }
   if (Date.now() - startedAt > 8000) { this.onFailure('声音没有开始播放，请重新开始。'); return; }
   const timer = setTimeout(() => { this.timers.delete(timer); notify(); }, 15); this.timers.add(timer);
  };
  notify();
 }
 clearPlayback() {
  ++this.playbackGeneration; this.nextStart = 0;
  for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
  for (const source of this.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
  this.sources.clear(); this.onPlayback(false);
 }
 get hasPlayback() { return this.sources.size > 0; }
 close() { if (this.closed) return; this.closed = true; this.stopCapture(false); this.clearPlayback(); this.context.onstatechange = null; void this.context.close().catch(() => {}); }
}
