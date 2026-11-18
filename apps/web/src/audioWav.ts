/** Browser-only conversion. No microphone, network or speaker output is opened here. */
export const WAV_SAMPLE_RATE = 16_000;
export const MAX_RECORDING_MS = 30_000;
export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
export const MAX_WAV_BYTES = 44 + WAV_SAMPLE_RATE * (MAX_RECORDING_MS / 1000) * 2;
const ENCODER_TAIL_MS = 250;
const CONVERSION_TIMEOUT_MS = 12_000;

export class AudioConversionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AudioConversionError';
  }
}
export interface WavConversionOptions {
  signal?: AbortSignal;
  maxDurationMs?: number;
}
export interface WavConversionDependencies {
  createDecoder?: () => AudioContext;
  createRenderer?: (length: number, sampleRate: number) => OfflineAudioContext;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}
function browserDependencies(): WavConversionDependencies {
  const browser = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Decoder = browser.AudioContext ?? browser.webkitAudioContext;
  const Renderer = browser.OfflineAudioContext ?? browser.webkitOfflineAudioContext;
  return {
    createDecoder: Decoder ? () => new Decoder() : undefined,
    createRenderer: Renderer ? (length, rate) => new Renderer(1, length, rate) : undefined,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}
function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('声音处理已取消。', 'AbortError');
}
function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw aborted(signal);
}
/** Browser decoding cannot always be interrupted natively; its late result is never consumed. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(aborted(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(aborted(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(aborted(signal));
      else resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/** A fixed RIFF/WAVE PCM16 mono encoder; NaN/Infinity become silence, finite samples are clipped. */
export function encodePcm16Wav(samples: Float32Array, sampleRate = WAV_SAMPLE_RATE): Blob {
  if (sampleRate !== WAV_SAMPLE_RATE || !samples.length || samples.length > WAV_SAMPLE_RATE * (MAX_RECORDING_MS / 1000)) {
    throw new AudioConversionError('这段声音长度不合适，请缩短后再说一次。', 'wav_bounds');
  }
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function convertRecordingToWav(
  blob: Blob,
  options: WavConversionOptions = {},
  dependencies: Partial<WavConversionDependencies> = {},
): Promise<Blob> {
  const deps = { ...browserDependencies(), ...dependencies };
  if (options.signal?.aborted) throw aborted(options.signal);
  if (!blob.size) throw new AudioConversionError('这次没有录到声音，请重新说一次。', 'empty_recording');
  if (blob.size > MAX_RECORDING_BYTES) throw new AudioConversionError('这段声音太大，请缩短后再说一次。', 'recording_too_large');
  if (!deps.createDecoder || !deps.createRenderer) throw new AudioConversionError('当前浏览器不能处理这段声音，请换个浏览器，或先用文字聊天。', 'conversion_unsupported');
  const maximumMs = Number.isFinite(options.maxDurationMs)
    ? Math.min(MAX_RECORDING_MS, Math.max(1000, options.maxDurationMs!)) : MAX_RECORDING_MS;
  const cancellation = new AbortController();
  const onAbort = () => cancellation.abort(new DOMException('声音处理已取消。', 'AbortError'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let decoder: AudioContext | undefined;
  let renderer: OfflineAudioContext | undefined;
  let source: AudioBufferSourceNode | undefined;
  let decoded: AudioBuffer | undefined;
  let rendered: AudioBuffer | undefined;
  let decoderClosed = false;
  let sourceStopped = false;
  const closeDecoder = () => {
    if (!decoder || decoderClosed) return;
    decoderClosed = true;
    if (decoder.state !== 'closed') void decoder.close().catch(() => {});
  };
  const stopRenderer = () => {
    if (!source || sourceStopped) return;
    sourceStopped = true;
    try { source.stop(); } catch { /* It may not have started yet. */ }
    try { source.disconnect(); } catch { /* No connections remain after completion. */ }
    try { source.buffer = null; } catch { /* Some engines retain their bounded render until completion. */ }
  };
  const cleanup = () => { stopRenderer(); closeDecoder(); };
  cancellation.signal.addEventListener('abort', cleanup, { once: true });
  const timeout = deps.setTimeout(() => cancellation.abort(new AudioConversionError('处理声音花了太久，这次已停止。请缩短后再说，或使用文字。', 'conversion_timeout')), CONVERSION_TIMEOUT_MS);
  try {
    const encoded = await abortable(blob.arrayBuffer(), cancellation.signal);
    ensureActive(cancellation.signal);
    decoder = deps.createDecoder();
    decoded = await abortable(decoder.decodeAudioData(encoded), cancellation.signal);
    ensureActive(cancellation.signal);
    closeDecoder();
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration * 1000 > maximumMs + ENCODER_TAIL_MS
      || !Number.isFinite(decoded.sampleRate) || decoded.sampleRate < 8000 || decoded.sampleRate > 192000
      || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2
      || decoded.length * decoded.numberOfChannels > 12_000_000) {
      throw new AudioConversionError('这段声音太长或格式不合适，请在 30 秒内重新说一次，或使用文字。', 'decoded_bounds');
    }
    // Browser encoders may append a short tail; never upload beyond the approved 30-second turn.
    const frames = Math.max(1, Math.min(Math.round(decoded.duration * WAV_SAMPLE_RATE), Math.floor(maximumMs * WAV_SAMPLE_RATE / 1000)));
    renderer = deps.createRenderer(frames, WAV_SAMPLE_RATE);
    source = renderer.createBufferSource();
    source.buffer = decoded;
    source.channelCount = 1;
    source.channelCountMode = 'explicit';
    source.channelInterpretation = 'speakers';
    source.connect(renderer.destination);
    source.start(0);
    rendered = await abortable(renderer.startRendering(), cancellation.signal);
    ensureActive(cancellation.signal);
    if (rendered.numberOfChannels !== 1 || rendered.sampleRate !== WAV_SAMPLE_RATE || rendered.length !== frames) {
      throw new AudioConversionError('这次声音没有处理好，请重新说一次，或使用文字。', 'render_format');
    }
    const wav = encodePcm16Wav(rendered.getChannelData(0));
    ensureActive(cancellation.signal);
    return wav;
  } catch (error) {
    if (cancellation.signal.aborted) throw aborted(cancellation.signal);
    if (error instanceof AudioConversionError) throw error;
    throw new AudioConversionError('这个浏览器暂时无法处理录音，请换个浏览器，或先用文字聊天。', 'decode_failed');
  } finally {
    deps.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    cancellation.signal.removeEventListener('abort', cleanup);
    cleanup();
    // OfflineAudioContext has no close() API. Its bounded render is disconnected and all local references are released.
    source = undefined; renderer = undefined; decoded = undefined; rendered = undefined; decoder = undefined;
  }
}
