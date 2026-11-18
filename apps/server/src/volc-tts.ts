import { randomUUID } from 'node:crypto';
import { ApiError } from './provider-errors.js';
import { speechDirection, type SpeechExpression } from './reply-expression.js';

/**
 * Seed TTS 2.0, V3 SSE only. Protocol checked against the provider documentation
 * on 2026-09-28: https://www.volcengine.com/docs/6561/1598757
 * Sections 2.1 / 2.2 / 2.3 / 3.4: X-Api-Key (or documented legacy headers),
 * base64 audio in event 352/code 0, terminal event 152/code 20000000.
 * No real credential or production voice entitlement has been exercised here.
 */
export type VolcTtsOptions = {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
};

const TIMEOUT_MS = 25_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_BYTES = 12 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const SUCCESS_CODE = 20_000_000;

function invalidResponse(): ApiError {
  return new ApiError(502, '字节语音服务返回了无效或不完整的音频流', 'PROVIDER_ERROR');
}

function safeHeader(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.length <= 4096 && !/[\u0000-\u001f\u007f-\uffff]/.test(trimmed) ? trimmed : '';
}

function configuredUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
    // Do not parse HTTP Chunked/V1 responses with the SSE parser.
    if (url.pathname !== '/api/v3/tts/unidirectional/sse') return undefined;
    return url.href;
  } catch { return undefined; }
}

function abortError(timedOut: boolean): ApiError {
  return timedOut
    ? new ApiError(504, '字节语音合成超时，请稍后重新发起', 'PROVIDER_TIMEOUT')
    : new ApiError(499, '语音合成已取消', 'REQUEST_ABORTED');
}

/** Also bounds injected transports which do not themselves observe AbortSignal. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal, error: () => ApiError): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(error()); }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(error()); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, failure => { cleanup(); reject(failure); });
  });
}

class SseAudioParser {
  constructor(private readonly incremental = false) {}
  takeChunks(): Uint8Array[] { const chunks = this.audio; this.audio = []; return chunks; }
  private line = '';
  private event = '';
  private data: string[] = [];
  private eventChars = 0;
  private previousCR = false;
  private events = 0;
  private finished = false;
  private byteLength = 0;
  private audio: Uint8Array[] = [];

  push(text: string): void {
    // Keep TCP/fetch chunk boundaries independent from SSE line boundaries,
    // including a CR/LF split across two network chunks.
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (this.previousCR) {
        this.previousCR = false;
        if (char === '\n') { start = index + 1; continue; }
      }
      if (char !== '\r' && char !== '\n') continue;
      this.line += text.slice(start, index);
      if (this.line.length + this.eventChars > MAX_WIRE_BYTES) throw invalidResponse();
      this.processLine(this.line);
      this.line = '';
      this.previousCR = char === '\r';
      start = index + 1;
    }
    this.line += text.slice(start);
    if (this.line.length + this.eventChars > MAX_WIRE_BYTES) throw invalidResponse();
  }

  private processLine(line: string): void {
    if (line === '') {
      if (this.data.length) this.processEvent();
      else if (this.event) throw invalidResponse();
      this.event = ''; this.data = []; this.eventChars = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') { this.data.push(value); this.eventChars += value.length + 1; }
    else if (field !== 'id' && field !== 'retry') throw invalidResponse();
  }

  private processEvent(): void {
    if (++this.events > MAX_EVENTS || this.finished) throw invalidResponse();
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(this.data.join('\n'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidResponse();
      frame = parsed as Record<string, unknown>;
    } catch { throw invalidResponse(); }
    if (!Number.isInteger(frame.code)) throw invalidResponse();
    if (this.event === '151' || this.event === '153') {
      throw new ApiError(502, '字节语音服务未完成本次合成', 'PROVIDER_ERROR');
    }
    if (frame.code === SUCCESS_CODE) {
      if (this.event !== '152' || (frame.data !== null && frame.data !== undefined)) throw invalidResponse();
      this.finished = true;
      return;
    }
    if (frame.code !== 0) throw new ApiError(502, '字节语音服务拒绝了本次合成，请检查服务配置或稍后再试', 'PROVIDER_ERROR');
    if (this.event === '152' || !/^\d+$/.test(this.event)) throw invalidResponse();
    // Sentence/subtitle/control metadata is deliberately not retained.
    if (frame.data === null || frame.data === undefined) return;
    if (this.event !== '352' || typeof frame.data !== 'string') throw invalidResponse();
    const encoded = frame.data;
    if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw invalidResponse();
    const decodedLength = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (decodedLength <= 0 || decodedLength > MAX_AUDIO_BYTES - this.byteLength) {
      throw new ApiError(502, '字节语音合成响应超过本轮大小限制', 'PROVIDER_ERROR');
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== decodedLength || decoded.toString('base64') !== encoded) throw invalidResponse();
    this.audio.push(decoded); this.byteLength += decoded.length;
  }

  complete(): Uint8Array {
    // A partially received last event is truncation, not a successful EOF.
    if (this.line || this.event || this.data.length || !this.finished || this.byteLength === 0) throw invalidResponse();
    if (this.incremental) return new Uint8Array();
    const bytes = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.audio) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
}

export function createVolcTts(options: VolcTtsOptions = {}) {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = configuredUrl(env.VOLC_TTS_URL);
  const apiKey = safeHeader(env.VOLC_SPEECH_API_KEY);
  const appId = safeHeader(env.VOLC_SPEECH_APP_ID);
  const accessToken = safeHeader(env.VOLC_SPEECH_ACCESS_TOKEN);
  const voice = env.VOLC_TTS_VOICE_ID?.trim() ?? '';
  const resource = env.VOLC_TTS_RESOURCE_ID?.trim() || 'seed-tts-2.0';
  const rate = env.VOLC_TTS_SPEECH_RATE?.trim() ? Number(env.VOLC_TTS_SPEECH_RATE) : 0;
  const requestedNewAuth = Boolean(env.VOLC_SPEECH_API_KEY?.trim());
  const validAuth = requestedNewAuth ? Boolean(apiKey) : Boolean(appId && accessToken);
  const configured = Boolean(url && validAuth && /^[A-Za-z0-9_.:-]{1,160}$/.test(voice) && resource === 'seed-tts-2.0' && Number.isInteger(rate) && rate >= -50 && rate <= 100);

  async function synthesize(input: string, format: 'mp3' | 'pcm', signal?: AbortSignal, onChunk?: (chunk: Uint8Array) => Promise<void>, expression: SpeechExpression = 'natural'): Promise<{ bytes: Uint8Array; contentType: string }> {
      if (!configured) throw new ApiError(503, '字节 Seed TTS 2.0 尚未完整配置，请检查专属语音凭证、SSE 地址和音色', 'NOT_CONFIGURED');
      if (typeof input !== 'string' || !input.trim() || input.length > 600) throw new ApiError(400, '语音合成仅接受 1–600 字符的已审核短回复', 'INVALID_INPUT');
      if (signal?.aborted) throw abortError(false);
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
      timer.unref();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      let completed = false;
      const errorOnAbort = () => abortError(timedOut);
      const cancelReader = () => { void reader?.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-Api-Resource-Id': resource,
          'X-Api-Request-Id': randomUUID(),
          ...(requestedNewAuth ? { 'X-Api-Key': apiKey } : { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessToken }),
        };
        const request = fetcher(url!, {
          method: 'POST', headers, redirect: 'manual', signal: controller.signal,
          body: JSON.stringify({
            user: { uid: randomUUID() },
            req_params: {
              text: input,
              speaker: voice,
              audio_params: { format, sample_rate: 24000, speech_rate: rate, loudness_rate: 0 },
              additions: JSON.stringify({ context_texts: [speechDirection(expression)], cache_config: { text_type: 1, use_cache: false } }),
            },
          }),
        });
        // A mocked/uncooperative transport may resolve after cancellation.
        void request.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
        response = await withAbort(request, controller.signal, errorOnAbort);
        if (response.redirected || !response.ok || !response.body) throw new ApiError(502, '字节语音服务请求未成功，未跟随重定向或自动重试', 'PROVIDER_ERROR');
        if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) throw invalidResponse();
        const declared = response.headers.get('content-length');
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_WIRE_BYTES)) throw invalidResponse();
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const parser = new SseAudioParser(Boolean(onChunk));
        let wireBytes = 0;
        while (true) {
          const part = await withAbort(reader.read(), controller.signal, errorOnAbort);
          if (part.done) break;
          wireBytes += part.value.byteLength;
          if (wireBytes > MAX_WIRE_BYTES) throw new ApiError(502, '字节语音合成响应超过本轮大小限制', 'PROVIDER_ERROR');
          parser.push(decoder.decode(part.value, { stream: true }));
          if (onChunk) for (const chunk of parser.takeChunks()) {
            if (controller.signal.aborted) throw errorOnAbort();
            await withAbort(onChunk(chunk), controller.signal, errorOnAbort);
          }
        }
        if (controller.signal.aborted) throw errorOnAbort();
        parser.push(decoder.decode());
        const bytes = parser.complete();
        completed = true;
        return { bytes, contentType: format === 'mp3' ? 'audio/mpeg' : 'audio/pcm' };
      } catch (error) {
        if (controller.signal.aborted) throw errorOnAbort();
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, '字节语音服务连接或流读取失败，请稍后重新发起', 'PROVIDER_ERROR');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelReader);
        if (!completed) {
          controller.abort();
          // Cleanup must not let an uncooperative transport extend the total deadline.
          if (reader) { void reader.cancel().catch(() => {}); }
          else { void response?.body?.cancel().catch(() => {}); }
        }
        try { reader?.releaseLock(); } catch { /* Pending cancellation owns this reader. */ }
      }
  }
  return {
    configured,
    speech: (input: string, signal?: AbortSignal, expression: SpeechExpression = 'natural') => synthesize(input, 'mp3', signal, undefined, expression),
    streamSpeech: async (input: string, onChunk: (chunk: Uint8Array) => Promise<void>, signal?: AbortSignal, expression: SpeechExpression = 'natural'): Promise<void> => {
      await synthesize(input, 'pcm', signal, onChunk, expression);
    },
  };
}
