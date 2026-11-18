import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { ApiError } from './provider-errors.js';

// Official V3 binary protocol and the 2026-09-25 nostream Python example:
// https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI?lang=zh
// https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-automatic-speech-recognition-websocket?lang=zh
const URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
// The public configuration selects ASR 2.0 (seedasr). Both versions share this
// endpoint and binary protocol; keep explicit 1.0 configurations compatible.
const RESOURCES = new Set([
  'volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent',
  'volc.bigasr.sauc.duration', 'volc.bigasr.sauc.concurrent',
]);
const MAX_PCM = 16_000 * 2 * 30;
const PACKET_BYTES = 6_400; // 200 ms of mono PCM16, sent every 100 ms (official range: 100–200 ms).
const MAX_RESPONSE = 256 * 1024;
const MAX_TOTAL_RESPONSE = 2 * 1024 * 1024;
const MAX_TEXT = 1_000;

export interface AsrLanguageDetection {
  kind: 'mandarin' | 'english' | 'chaoshan' | 'hakka' | 'cantonese' | 'other-dialect' | 'unknown';
  /** A validated provider code, never a guessed language or a confidence score. */
  code?: string;
}

export interface VolcAsrLanguageResult {
  text: string;
  /** Internal provider payload, retained for existing speaker recognition only. */
  payload: unknown;
  language: AsrLanguageDetection;
}

// LID is a routing hint, not evidence that the associated transcript is accurate.
// Keep documented labels explicit: Minnan must never be silently relabelled Chaoshan.
// The official LID label for spoken English is speech_en; en/speech_eng are not documented.
const ENGLISH_CODE = 'speech_en';
const DIALECT_CODES = new Set([
  'speech_dia_nan', 'speech_dia_wuu', 'speech_dia_xina', 'speech_dia_zgyu',
  'speech_dia_ql', 'speech_dia_hsn', 'speech_dia_jin', 'speech_dia_juai', 'speech_dia_lany',
  'speech_dia_dbiu', 'speech_dia_jliu', 'speech_dia_jlua', 'speech_dia_cdo', 'speech_dia_gan',
  'speech_dia_mnp', 'speech_dia_czh',
]);
const OTHER_LANGUAGE_CODES = new Set([
  'speech_hi', 'speech_ja', 'speech_ko', 'speech_th', 'speech_kk',
  'speech_bo', 'speech_ug', 'speech_mn',
  'singing_en', 'singing_mand', 'singing_dia_cant', 'singing_hi', 'singing_ja', 'singing_ko', 'singing_th',
]);
const LANGUAGE_ALIASES: Record<string, string> = {
  'zh-cn': 'speech_mand', cmn: 'speech_mand', hak: 'speech_dia_hak',
  'zh-hak': 'speech_dia_hak', 'yue-cn': 'speech_dia_cant', yue: 'speech_dia_cant',
  nan: 'speech_dia_nan', 'en-us': 'speech_en',
};
const LANGUAGE_FIELDS = ['lid_lang', 'lang_code', 'language_code'] as const;

function languageFromPayload(payload: unknown): { language: AsrLanguageDetection; validTag: boolean } {
  const codes = new Set<string>();
  let invalid = false;
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const collect = (value: unknown) => {
    const object = record(value);
    if (!object) return;
    for (const field of LANGUAGE_FIELDS) {
      const candidate = object[field];
      if (candidate === undefined || candidate === '') continue;
      if (typeof candidate !== 'string' || candidate.length > 64) { invalid = true; continue; }
      const normalized = candidate.trim().toLowerCase();
      if (!normalized) continue;
      const code = Object.hasOwn(LANGUAGE_ALIASES, normalized) ? LANGUAGE_ALIASES[normalized]! : normalized;
      if (code === 'speech_mand' || code === ENGLISH_CODE || code === 'speech_dia_chao' || code === 'speech_dia_hak' || code === 'speech_dia_cant'
          || DIALECT_CODES.has(code) || OTHER_LANGUAGE_CODES.has(code)) codes.add(code);
      else invalid = true;
    }
  };
  const additions = (value: unknown) => {
    if (value === undefined) return;
    if (typeof value === 'string') {
      if (value.length > 4_096) { invalid = true; return; }
      try { value = JSON.parse(value); } catch { invalid = true; return; }
    }
    if (!record(value)) { invalid = true; return; }
    collect(value);
  };
  const container = (value: unknown) => {
    const object = record(value);
    if (!object) return;
    collect(object);
    additions(object.additions);
  };
  const root = record(payload);
  const result = record(root?.result);
  container(root); container(result); container(root?.audio_info);
  if (Array.isArray(result?.utterances)) {
    // No recursive scan or unbounded interpretation of optional upstream metadata.
    if (result.utterances.length > 64) invalid = true;
    else for (const utterance of result.utterances) container(utterance);
  }
  if (invalid || codes.size !== 1) return { language: { kind: 'unknown' }, validTag: false };
  const code = [...codes][0]!;
  const kind: AsrLanguageDetection['kind'] = code === 'speech_mand' ? 'mandarin'
    : code === ENGLISH_CODE ? 'english' : code === 'speech_dia_chao' ? 'chaoshan' : code === 'speech_dia_hak' ? 'hakka' : code === 'speech_dia_cant' ? 'cantonese'
    : DIALECT_CODES.has(code) ? 'other-dialect' : 'unknown';
  return { language: { kind, code }, validTag: true };
}

export interface VolcAsrOptions {
  env?: Record<string, string | undefined>;
  /** Test transport only. Production always connects to the validated official WSS endpoint. */
  connect?: (url: string, options: ClientOptions) => WebSocket;
  /** May shorten the 25-second total limit for tests; never lengthens it. */
  timeoutMs?: number;
}

function protocolError(): ApiError {
  return new ApiError(502, '语音识别返回了无法处理的数据，请重新说一句。', 'ASR_PROTOCOL_ERROR');
}

function serviceError(code?: number): ApiError {
  if (code === 45000002) return new ApiError(422, '没有听清这句话，请靠近麦克风重新说。', 'ASR_EMPTY');
  if (code === 45000151) return new ApiError(400, '语音格式不正确，请重新录音。', 'ASR_AUDIO_INVALID');
  if (code === 45000081) return new ApiError(504, '语音识别等待超时，请重新说一句。', 'ASR_TIMEOUT');
  if (code === 55000031) return new ApiError(503, '语音识别服务暂时忙，请稍后再试。', 'ASR_BUSY');
  return new ApiError(502, '语音识别暂时失败，请重新说一句。', 'ASR_UPSTREAM_FAILED');
}

function credential(value: string | undefined): string | undefined {
  // Do not forward line breaks, header whitespace, or invalid bytes from configuration.
  if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) return undefined;
  return value;
}

export function pcmFromWav(buffer: Buffer, mime: string): Buffer {
  const invalid = () => new ApiError(400, '请上传 16kHz、单声道、16 位 PCM 格式的 WAV 语音。', 'ASR_AUDIO_INVALID');
  if (!Buffer.isBuffer(buffer) || !/^audio\/(?:wav|wave|x-wav)$/i.test(mime.trim())) throw invalid();
  if (buffer.length > MAX_PCM + 44) throw new ApiError(413, '每句话最多录制 30 秒。', 'ASR_AUDIO_TOO_LONG');
  // Deliberately accept the canonical 44-byte PCM WAV emitted by our browser encoder only.
  // No untrusted metadata chunks, compressed WAV, raw MIME claims, or server-side transcoding.
  if (buffer.length < 46 || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WAVE'
      || buffer.readUInt32LE(4) !== buffer.length - 8
      || buffer.toString('ascii', 12, 16) !== 'fmt ' || buffer.readUInt32LE(16) !== 16
      || buffer.readUInt16LE(20) !== 1 || buffer.readUInt16LE(22) !== 1
      || buffer.readUInt32LE(24) !== 16_000 || buffer.readUInt32LE(28) !== 32_000
      || buffer.readUInt16LE(32) !== 2 || buffer.readUInt16LE(34) !== 16
      || buffer.toString('ascii', 36, 40) !== 'data'
      || buffer.readUInt32LE(40) !== buffer.length - 44 || (buffer.length - 44) % 2) throw invalid();
  return buffer.subarray(44);
}

function requestFrame(type: 1 | 2, sequence: number, data: Buffer): Buffer {
  const compressed = gzipSync(data);
  const prefix = Buffer.alloc(12);
  // Audio has no serialization; full requests are JSON. Both payloads use gzip.
  prefix.set([0x11, (type << 4) | (sequence < 0 ? 3 : 1), type === 1 ? 0x11 : 0x01, 0]);
  prefix.writeInt32BE(sequence, 4);
  prefix.writeUInt32BE(compressed.length, 8);
  return Buffer.concat([prefix, compressed]);
}

function readResponse(data: Buffer): { final: boolean; text?: string; payload?: unknown } {
  if (data.length < 8 || data.length > MAX_RESPONSE) throw protocolError();
  const headerSize = (data[0] & 15) * 4;
  const type = data[1] >> 4;
  const flags = data[1] & 15;
  const serialization = data[2] >> 4;
  const compression = data[2] & 15;
  if (data[0] >> 4 !== 1 || headerSize < 4 || headerSize > data.length
      || (type !== 9 && type !== 15) || flags > 7 || compression > 1
      || (serialization !== 1 && !(type === 15 && serialization === 0))) throw protocolError();
  let position = headerSize;
  const integer = () => {
    if (position + 4 > data.length) throw protocolError();
    const value = data.readUInt32BE(position); position += 4; return value;
  };
  if (flags & 1) integer(); // Signed sequence is optional; the final bit is authoritative.
  if (flags & 4) integer(); // The current official parser supports this optional event field.
  const code = type === 15 ? integer() : undefined;
  const payloadSize = integer();
  if (payloadSize !== data.length - position || payloadSize > MAX_RESPONSE) throw protocolError();
  let payload = data.subarray(position);
  if (compression === 1) {
    try { payload = gunzipSync(payload, { maxOutputLength: MAX_RESPONSE }); }
    catch { throw protocolError(); }
  }
  // Provider error payloads may contain credentials or raw audio diagnostics: never expose them.
  if (type === 15) throw serviceError(code);
  let result: unknown;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
  catch { throw protocolError(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw protocolError();
  const object = result as { code?: unknown; result?: unknown };
  // V3 full responses normally contain audio_info/result without a business code.
  if (object.code !== undefined && object.code !== 0 && object.code !== 20_000_000) {
    throw serviceError(typeof object.code === 'number' ? object.code : undefined);
  }
  let text: string | undefined;
  if (object.result !== undefined) {
    if (!object.result || typeof object.result !== 'object' || Array.isArray(object.result)) throw protocolError();
    const rawText = (object.result as { text?: unknown }).text;
    if (rawText !== undefined) {
      if (typeof rawText !== 'string' || rawText.length > MAX_TEXT) throw protocolError();
      text = rawText.trim();
    }
  }
  return { final: !!(flags & 2), text, payload:object };
}

export function createVolcAsr(options: VolcAsrOptions = {}): {
  configured: boolean;
  transcribe(buffer: Buffer, mime: string, signal?: AbortSignal): Promise<string>;
  transcribeDetailed(buffer:Buffer,mime:string,signal?:AbortSignal,speakerParameters?:Record<string,unknown>):Promise<{text:string;payload:unknown}>;
  transcribeWithLanguage(buffer: Buffer, mime: string, signal?: AbortSignal, speakerParameters?: Record<string, unknown>): Promise<VolcAsrLanguageResult>;
} {
  const env = options.env ?? process.env;
  const apiKey = credential(env.VOLC_SPEECH_API_KEY);
  const appId = credential(env.VOLC_SPEECH_APP_ID);
  const accessToken = credential(env.VOLC_SPEECH_ACCESS_TOKEN);
  const resource = env.VOLC_ASR_RESOURCE_ID?.trim();
  // No default URL, redirects, alternate hosts, query credentials, or Ark key fallback.
  const configured = env.VOLC_ASR_URL?.trim() === URL && !!resource && RESOURCES.has(resource)
    && (env.VOLC_SPEECH_API_KEY ? !!apiKey : !!appId && !!accessToken);
  const connect = options.connect ?? ((url, settings) => new WebSocket(url, settings));
  const timeoutMs = Math.min(25_000, Math.max(1, options.timeoutMs ?? 25_000));

  const transcribeInternal=async(buffer:Buffer,mime:string,signal?:AbortSignal,speakerParameters?:Record<string,unknown>,detectLanguage=false):Promise<VolcAsrLanguageResult>=>{
      if (signal?.aborted) throw new ApiError(499, '这次语音识别已取消。', 'ASR_CANCELLED');
      if (!configured) throw new ApiError(503, '语音识别尚未配置完成，请先使用文字。', 'ASR_NOT_CONFIGURED');
      const pcm = pcmFromWav(buffer, mime);
      const requestId = randomUUID();
      const headers: Record<string, string> = {
        'X-Api-Resource-Id': resource!, 'X-Api-Request-Id': requestId,
        ...(apiKey ? { 'X-Api-Key': apiKey } : { 'X-Api-App-Key': appId!, 'X-Api-Access-Key': accessToken! }),
      };
      return new Promise<VolcAsrLanguageResult>((resolve, reject) => {
        let socket: WebSocket | undefined;
        let finished = false;
        let acknowledged = false;
        let finalSent = false;
        let responseCount = 0;
        let responseBytes = 0;
        let sequence = 2;
        let offset = 0;
        let paceTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => finish(new ApiError(504, '语音识别超时，请重新说一句。', 'ASR_TIMEOUT')), timeoutMs);
        const finish = (error?: ApiError, result?: VolcAsrLanguageResult) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          clearTimeout(paceTimer);
          signal?.removeEventListener('abort', abort);
          // terminate also aborts an unfinished handshake and removes queued audio immediately.
          // Keep guarded error listeners installed for late socket errors during shutdown.
          try { socket?.terminate(); } catch { /* No upstream exception escapes. */ }
          if (error) reject(error); else resolve(result!);
        };
        const abort = () => finish(new ApiError(499, '这次语音识别已取消。', 'ASR_CANCELLED'));
        const send = (frame: Buffer, next?: () => void) => {
          if (finished) return;
          if (socket?.readyState !== WebSocket.OPEN) { finish(serviceError()); return; }
          try {
            socket.send(frame, (error) => {
              if (finished) return;
              if (error) finish(serviceError()); else next?.();
            });
          } catch { finish(serviceError()); }
        };
        const sendAudio = () => {
          if (finished) return;
          const end = Math.min(offset + PACKET_BYTES, pcm.length);
          finalSent = end === pcm.length;
          const frame = requestFrame(2, finalSent ? -sequence : sequence, pcm.subarray(offset, end));
          sequence++; offset = end;
          send(frame, finalSent ? undefined : () => { paceTimer = setTimeout(sendAudio, 100); });
        };
        signal?.addEventListener('abort', abort, { once: true });
        // Registration also covers callers aborting between the initial check and socket creation.
        if (signal?.aborted) { abort(); return; }
        try {
          if(speakerParameters){const voices=speakerParameters.voiceprints;if(speakerParameters.enable_nonstream!==true||speakerParameters.enable_speaker_info!==true||speakerParameters.show_utterances!==true||speakerParameters.ssd_mode!==2||!Array.isArray(voices)||voices.length!==1||voices[0]?.id!==''||typeof voices[0]?.group_id!=='string'||!voices[0].group_id||voices[0].group_id.length>128)throw new ApiError(400,'声纹识别参数无效','VOICEPRINT_PARAMETERS_INVALID');}
          socket = connect(speakerParameters?'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async':URL, {
            headers, handshakeTimeout: Math.min(10_000, timeoutMs), maxPayload: MAX_RESPONSE,
            followRedirects: false, perMessageDeflate: false,
          });
          socket.on('error', () => finish(serviceError()));
          socket.on('close', () => finish(new ApiError(502, '语音识别连接提前结束，请重新说一句。', 'ASR_CONNECTION_CLOSED')));
          socket.on('unexpected-response', (request, response) => {
            const status = response.statusCode;
            response.destroy(); request.destroy();
            finish(status === 401 || status === 403
              ? new ApiError(503, '语音识别服务鉴权未通过，请联系管理员检查配置。', 'ASR_AUTH_FAILED')
              : status === 429 ? serviceError(55000031) : serviceError());
          });
          socket.on('open', () => {
            if (finished) return;
            send(requestFrame(1, 1, Buffer.from(JSON.stringify({
              user: { uid: requestId },
              audio: { format: 'pcm', codec: 'raw', rate: 16_000, bits: 16, channel: 1 },
              request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, result_type: 'full',...(speakerParameters??{}), ...(detectLanguage ? { enable_lid: true, show_utterances: true } : {}) },
            }))));
          });
          socket.on('message', (raw: RawData, isBinary: boolean) => {
            if (finished) return;
            try {
              if (!isBinary) throw protocolError();
              const data = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
              responseBytes += data.length;
              if (++responseCount > 512 || responseBytes > MAX_TOTAL_RESPONSE) throw protocolError();
              const result = readResponse(data);
              if (result.final) {
                if (!finalSent) throw protocolError();
                const detected = detectLanguage ? languageFromPayload(result.payload) : undefined;
                if (!result.text && !detected?.validTag) throw serviceError(45000002);
                finish(undefined, {text:result.text ?? '',payload:result.payload,language:detected?.language ?? { kind: 'unknown' }});
              } else if (!acknowledged) {
                acknowledged = true;
                sendAudio();
              }
            } catch (error) { finish(error instanceof ApiError ? error : protocolError()); }
          });
          // An injected connector can abort synchronously while establishing the transport.
          if (finished || signal?.aborted) { socket.terminate(); abort(); }
        } catch { finish(serviceError()); }
      });
  };
  return {
    configured,
    async transcribeDetailed(buffer,mime,signal,speakerParameters) {
      const { text, payload } = await transcribeInternal(buffer,mime,signal,speakerParameters);
      return { text, payload };
    },
    transcribeWithLanguage(buffer,mime,signal,speakerParameters) {
      return transcribeInternal(buffer,mime,signal,speakerParameters,true);
    },
    async transcribe(buffer,mime,signal) { return (await transcribeInternal(buffer,mime,signal)).text; },
  };
}
