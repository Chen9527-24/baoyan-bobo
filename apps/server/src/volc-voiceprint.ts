import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiError } from './provider-errors.js';

type Env = Record<string, string | undefined>;
export const VOICEPRINT_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
// The live gateway canonicalizes /invoke to /invoke/ with HTTP 307.
// Send directly to its same-origin canonical route; keep other redirects disabled.
const ENDPOINT = 'https://openspeech.bytedance.com/api/proxy/invoke/';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const secret = (value: string | undefined) => !!value && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
const bad = () => new ApiError(502, '声音登记服务暂时不可用，请稍后核实登记状态', 'VOICEPRINT_PROVIDER_ERROR');
const cancelled = () => new ApiError(499, '这次声音登记已经取消', 'REQUEST_ABORTED');
// The live group response uses GroupID; the documentation uses GroupId.
// Keep only these bounded aliases (including the analogous template receipt),
// and reject conflicting fields rather than choosing an ambiguous cleanup ID.
function responseUuid(result: Record<string, unknown>, field: 'GroupId' | 'SpeakId'): string | undefined {
  const alias = field === 'GroupId' ? 'GroupID' : 'SpeakID';
  const documented = Object.hasOwn(result, field), compatible = Object.hasOwn(result, alias);
  if (!documented && !compatible) return;
  const left = result[field], right = result[alias];
  if ((documented && (typeof left !== 'string' || !UUID.test(left)))
    || (compatible && (typeof right !== 'string' || !UUID.test(right)))
    || (documented && compatible && left !== right)) return;
  return (documented ? left : right) as string;
}
type ManagementAction = 'CreateVoiceprintGroup' | 'UpdateVoiceprint' | 'ListVoiceprint';
type FailureCategory = 'permission' | 'invalid_request' | 'rate_limit' | 'service' | 'unknown' | 'redirect' | 'non_json' | 'response_too_large' | 'response_shape' | 'transport' | 'timeout';
function businessFailure(code: unknown, topCode: unknown): FailureCategory {
  const top = typeof topCode === 'string' ? topCode.toLowerCase() : '';
  if (code === 1002 || /permission|denied|unauth|auth|api.?key|token|access.?key/.test(top)) return 'permission';
  if (code === 1001 || /invalid|parameter|argument/.test(top)) return 'invalid_request';
  if ([1003, 1004].includes(Number(code)) || /limit|quota|qps/.test(top)) return 'rate_limit';
  if ([1020, 1021].includes(Number(code))) return 'timeout';
  if ([1005, 1006, 1022].includes(Number(code)) || /internal|service|busy|server/.test(top)) return 'service';
  return 'unknown';
}

/** Only an explicitly configured public origin can serve the short-lived audio URL. */
export function voiceprintAudioOrigin(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password
      || isIP(url.hostname) || !url.hostname.includes('.') || !/^[a-z\d.-]+$/.test(url.hostname)
      || /(^|\.)(localhost|local|internal|invalid|example|test)$/.test(url.hostname)) return;
    return url.origin;
  } catch { return; }
}

export type VoiceprintRegistration = { templateId: string };
export type VoiceprintProvider = {
  configured: boolean;
  audioOrigin?: string;
  createGroup(input: { groupName: string; signal?: AbortSignal }): Promise<string>;
  register(input: { speakerId: string; audioUrl: string; groupId: string; signal?: AbortSignal;
    onLateRegistration?: (result: VoiceprintRegistration) => void }): Promise<VoiceprintRegistration>;
  remove(input: { templateId: string; signal?: AbortSignal }): Promise<{ supplierDeletion: 'soft_deleted' }>;
  find(input: { speakerId: string; groupId: string; signal?: AbortSignal }): Promise<string | undefined>;
};

/** Management API is separate from ASR and never guesses account entitlements. */
export function createVolcVoiceprint(options: { env: Env; fetch?: typeof fetch; timeoutMs?: number }): VoiceprintProvider {
  const { env } = options;
  const fetcher = options.fetch ?? fetch;
  const audioOrigin = voiceprintAudioOrigin(env.VOLC_VOICEPRINT_AUDIO_ORIGIN);
  const apiKey = env.VOLC_VOICEPRINT_API_KEY;
  const appId = env.VOLC_VOICEPRINT_APP_ID;
  const accessKey = env.VOLC_VOICEPRINT_ACCESS_KEY;
  const credentials: Record<string, string> | undefined = secret(apiKey) ? { 'X-Api-Key': apiKey! }
    : !apiKey && secret(appId) && secret(accessKey) ? { 'X-Api-App-Id': appId!, 'X-Api-Access-Key': accessKey! } : undefined;
  const configured = env.VOLC_VOICEPRINT_ENABLED === 'true' && !!credentials && !!audioOrigin;
  const timeoutMs = Math.min(60_000, Math.max(1, options.timeoutMs ?? 20_000));

  async function invoke(action: ManagementAction, body: Record<string, unknown>, signal?: AbortSignal,
    late?: (result: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    if (!configured) throw new ApiError(503, '真实识人服务尚未配置或开通，普通聊天仍可使用', 'VOICEPRINT_NOT_CONFIGURED');
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();
    let settled = false;
    let diagnosed = false;
    let status: number | null = null;
    const diagnose = (category: FailureCategory, businessCode?: unknown) => {
      if (diagnosed) return; diagnosed = true;
      // Trusted stderr only: no request, upstream strings, IDs, URLs, headers or embeddings.
      console.warn(JSON.stringify({ type: 'voiceprint_provider_failure', action, httpStatus: status,
        businessCode: typeof businessCode === 'number' && Number.isSafeInteger(businessCode) && Math.abs(businessCode) <= 1_000_000_000 ? businessCode : null, category }));
    };
    let stop!: (error: ApiError) => void;
    const stopped = new Promise<never>((_resolve, reject) => { stop = error => { controller.abort(error); reject(error); }; });
    const abort = () => stop(cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { diagnose('timeout'); stop(new ApiError(504, '声音登记超时，已停止激活并等待清理结果', 'VOICEPRINT_TIMEOUT')); }, timeoutMs);
    const task = (async () => {
      try {
        const response = await fetcher(`${ENDPOINT}?Action=${action}`, { method: 'POST', redirect: 'manual',
          headers: { 'Content-Type': 'application/json', ...credentials, 'X-Api-Request-Id': randomUUID() },
          body: JSON.stringify(body), signal: controller.signal });
        status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
          diagnose(response.status >= 300 && response.status < 400 ? 'redirect' : [401, 403].includes(response.status) ? 'permission'
            : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'service' : response.ok ? 'non_json' : 'unknown');
          await response.body?.cancel(); throw bad();
        }
        // No vendor error strings, signed audio URLs or vectors enter application errors.
        const reader = response.body?.getReader();
        if (!reader) { diagnose('response_shape'); throw bad(); }
        let size = 0; const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength; if (size > 256 * 1024) { diagnose('response_too_large'); await reader.cancel(); throw bad(); }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
        let payload: any; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { diagnose('non_json'); throw bad(); }
        if (payload?.ResponseMetadata?.Error || payload?.Result?.Code !== 1000 || typeof payload.Result !== 'object') {
          diagnose(businessFailure(payload?.Result?.Code, payload?.ResponseMetadata?.Error?.Code), payload?.Result?.Code); throw bad();
        }
        const returnedId = action === 'CreateVoiceprintGroup' ? responseUuid(payload.Result, 'GroupId')
          : action === 'UpdateVoiceprint' && body.Action === 0 ? responseUuid(payload.Result, 'SpeakId') : undefined;
        if (((action === 'CreateVoiceprintGroup' || (action === 'UpdateVoiceprint' && body.Action === 0)) && (typeof returnedId !== 'string' || !UUID.test(returnedId)))
          || (action === 'ListVoiceprint' && (!Array.isArray(payload.Result.AudioEmbedding) || payload.Result.AudioEmbedding.length > 50))) {
          diagnose('response_shape', payload.Result.Code); throw bad();
        }
        if (settled || controller.signal.aborted) {
          // Some transports ignore abort after the vendor accepted a creation request.
          // Its receipt is cleanup-only; it can never activate a template.
          try { late?.(payload.Result); } catch { /* cleanup persistence belongs to caller */ }
          throw cancelled();
        }
        return payload.Result as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (controller.signal.aborted) throw cancelled();
        diagnose('transport');
        throw bad();
      }
    })();
    try { return await Promise.race([task, stopped]); }
    finally { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  function id(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw bad(); return value; }
  return {
    configured, audioOrigin,
    async createGroup({ groupName, signal }) {
      // Groups use random tokens, not family names or actual household identifiers.
      if (!UUID.test(groupName)) throw new ApiError(400, '登记参数无效', 'INVALID_INPUT');
      return id(responseUuid(await invoke('CreateVoiceprintGroup', { GroupName: groupName }, signal), 'GroupId'));
    },
    async register({ speakerId, audioUrl, groupId, signal, onLateRegistration }) {
      let url: URL; try { url = new URL(audioUrl); } catch { throw new ApiError(400, '临时音频地址无效', 'INVALID_INPUT'); }
      if (!UUID.test(speakerId) || !UUID.test(groupId) || url.origin !== audioOrigin || url.username || url.password
        || url.hash || !/^\/api\/voiceprint\/audio\/[a-f\d-]{36}$/.test(url.pathname)
        || [...url.searchParams.keys()].sort().join(',') !== 'expires,signature'
        || !/^\d{10,16}$/.test(url.searchParams.get('expires') ?? '')
        || !/^[a-f\d]{64}$/.test(url.searchParams.get('signature') ?? '')) throw new ApiError(400, '临时音频地址无效', 'INVALID_INPUT');
      const result = await invoke('UpdateVoiceprint', { Action: 0, AudioUrl: url.href, SpeakerName: speakerId, GroupId: groupId }, signal,
        response => { const templateId = responseUuid(response, 'SpeakId'); if (templateId) onLateRegistration?.({ templateId }); });
      return { templateId: id(responseUuid(result, 'SpeakId')) };
    },
    async remove({ templateId, signal }) {
      if (!UUID.test(templateId)) throw new ApiError(400, '登记参数无效', 'INVALID_INPUT');
      await invoke('UpdateVoiceprint', { Action: 2, SpeakId: templateId }, signal);
      return { supplierDeletion: 'soft_deleted' as const };
    },
    async find({ speakerId, groupId, signal }) {
      if (!UUID.test(speakerId) || !UUID.test(groupId)) throw new ApiError(400, '登记参数无效', 'INVALID_INPUT');
      // One family group is capped at 50 by the supplier. Never list all account records.
      const response = await invoke('ListVoiceprint', { GroupId: groupId, Limit: 50, Offset: 0 }, signal);
      if (!Array.isArray(response.AudioEmbedding) || response.AudioEmbedding.length > 50) throw bad();
      const matching = response.AudioEmbedding.filter((entry: any) => entry?.SpeakerName === speakerId && entry.Status === 1);
      if (matching.length > 1) throw bad();
      return matching.length ? id(responseUuid(matching[0] as Record<string, unknown>, 'SpeakId')) : undefined;
    },
  };
}

/** This is an ASR request fragment, not an invented standalone recognize API. */
export function voiceprintAsrParameters(groupId: string) {
  if (!UUID.test(groupId)) throw new ApiError(400, '登记参数无效', 'INVALID_INPUT');
  return { enable_nonstream: true, enable_speaker_info: true, show_utterances: true, ssd_mode: 2,
    voiceprints: [{ id: '', group_id: groupId }] } as const;
}

/** Unknown tokens, missing/overlapping/multiple speakers remain unknown. No score is fabricated. */
export function parseVoiceprintSpeaker(payload: unknown): string | undefined {
  const result = (payload as any)?.result ?? payload;
  const utterances = (result as any)?.utterances;
  if (!Array.isArray(utterances) || !utterances.length || utterances.length > 1000) return;
  const speakers = new Set<string>();
  for (const entry of utterances) {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) continue;
    const speaker = entry.additions?.speaker_id ?? entry.speaker_id;
    if (typeof speaker !== 'string' || !UUID.test(speaker) || entry.additions?.overlap === true || entry.overlap === true) return;
    speakers.add(speaker);
  }
  return speakers.size === 1 ? [...speakers][0] : undefined;
}
