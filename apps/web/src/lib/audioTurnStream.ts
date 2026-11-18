import { ApiError } from './api';
import type { AudioInputMetadata, Turn } from './types';
import { isLanguageClarification, LANGUAGE_QUESTION } from './languageClarification';
import { replySegmentsForTurn } from './replySegments';

const MAX_BYTES = 32 * 1024;
const MAX_LINE = 16 * 1024;
const encoder = new TextEncoder();
const protocolError = () => new ApiError('语音回复没有完整收到，请重新试一次。', 502, 'AUDIO_STREAM_INVALID');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function validInputMetadata(value: Record<string, unknown>): boolean {
  return (value.inputSource === undefined || value.inputSource === 'transcript' || value.inputSource === 'interpretation')
    && (value.detectedLanguage === undefined || value.detectedLanguage === 'mandarin' || value.detectedLanguage === 'chaoshan' || value.detectedLanguage === 'hakka' || value.detectedLanguage === 'cantonese' || value.detectedLanguage === 'english');
}

function validTurn(value: unknown, transcript: string | undefined, metadata?: AudioInputMetadata): value is Turn {
  if (!object(value) || !fields(value, ['reply', 'replyId', 'replySegments', 'mode', 'memoryRevision', 'globalRevision', 'speakerRevision', 'transcript', 'candidate', 'speaker', 'endCall','conversationMode','emotion','interpretedText','story','learning','inputKind','inputSource','detectedLanguage','languageClarification','audioReview'])
      || !text(value.reply, 600) || !uuid(value.replyId) || (value.mode !== 'demo' && value.mode !== 'live')
      || !revision(value.memoryRevision) || !revision(value.globalRevision) || !revision(value.speakerRevision)
      || value.transcript !== transcript || (value.endCall !== undefined && typeof value.endCall !== 'boolean')
      || (value.inputKind !== undefined && value.inputKind !== 'image')
      || !validInputMetadata(value) || value.inputSource !== metadata?.inputSource || value.detectedLanguage !== metadata?.detectedLanguage) return false;
  if(value.audioReview!==undefined){const review=value.audioReview;
    if(!object(review)||!fields(review,['replyId','expiresAt'])||review.replyId!==value.replyId||!uuid(review.replyId)||typeof review.expiresAt!=='string'||!Number.isFinite(Date.parse(review.expiresAt))||value.inputKind==='image'||value.endCall||value.languageClarification||!value.detectedLanguage)return false;
  }
  if (value.languageClarification !== undefined) {
    if (!isLanguageClarification(value.languageClarification) || value.reply !== LANGUAGE_QUESTION || transcript !== undefined
      || value.inputSource !== undefined || value.detectedLanguage !== undefined || value.interpretedText !== undefined
      || value.candidate !== undefined || value.story !== undefined || value.learning !== undefined || value.endCall !== undefined) return false;
  } else if (transcript === undefined) return false;
  if (value.candidate !== undefined) {
    const candidate = value.candidate;
    if (!object(candidate) || !fields(candidate, ['id', 'content', 'key', 'kind', 'action', 'memoryId'])
        || !uuid(candidate.id) || !text(candidate.content, 1000) || !text(candidate.key, 100)
        || typeof candidate.kind !== 'string' || !['preference', 'event', 'imaginary', 'plan'].includes(candidate.kind)
        || (candidate.action !== undefined && candidate.action !== 'save' && candidate.action !== 'forget')
        || (candidate.memoryId !== undefined && !uuid(candidate.memoryId))
        || (candidate.action === 'forget' && !uuid(candidate.memoryId))) return false;
  }
  if (value.speaker !== undefined) {
    const speaker = value.speaker;
    if (!object(speaker) || !fields(speaker, ['name', 'status']) || typeof speaker.status !== 'string' || !['known', 'unknown', 'demo'].includes(speaker.status)
        || (speaker.name !== undefined && !text(speaker.name, 16))) return false;
  }
  if(value.conversationMode!==undefined){const mode=value.conversationMode;
    if(!object(mode)||!fields(mode,['mode','dialect','behavior'])||(mode.mode!=='chat'&&mode.mode!=='auto'&&mode.mode!=='dialect')||(mode.dialect!==undefined&&mode.dialect!=='chaoshan'&&mode.dialect!=='hakka')||(mode.behavior!==undefined&&mode.behavior!=='understand'&&mode.behavior!=='translate'))return false;
    if(mode.mode==='dialect'&&(mode.dialect===undefined||mode.behavior===undefined))return false;
    if(mode.mode==='auto'&&(mode.dialect!==undefined||mode.behavior!==undefined))return false;
  }
  if(value.emotion!==undefined&&(typeof value.emotion!=='string'||!['warm','thoughtful','happy','calm'].includes(value.emotion)))return false;
  if(value.interpretedText!==undefined&&!text(value.interpretedText,1000))return false;
  if(value.story!==undefined){const story=value.story;
    if(!object(story)||!fields(story,['id','title','segment','total','status','endsAt','choices'])||!text(story.id,100)||!text(story.title,100)||!revision(story.segment)||!revision(story.total)||Number(story.segment)<1||Number(story.total)>100||Number(story.segment)>Number(story.total)||typeof story.status!=='string'||!['playing','paused','completed'].includes(story.status)||!text(story.endsAt,64)||!Number.isFinite(Date.parse(story.endsAt)))return false;
    if(story.choices!==undefined&&(!Array.isArray(story.choices)||story.choices.length>8||story.choices.some(choice=>!object(choice)||!fields(choice,['id','label'])||!text(choice.id,100)||!text(choice.label,120))))return false;
  }
  if(value.learning!==undefined){const learning=value.learning;
    if(!object(learning)||!fields(learning,['topic','stage','question','step','totalSteps','endsAt'])||typeof learning.topic!=='string'||!['arithmetic','units','chinese','english'].includes(learning.topic)||typeof learning.stage!=='string'||!['confirm','attempt','explain','finished','paused','stopped'].includes(learning.stage)||!text(learning.question,600)||!revision(learning.step)||!revision(learning.totalSteps)||Number(learning.totalSteps)>50||Number(learning.step)>Number(learning.totalSteps)||!Number.isSafeInteger(learning.endsAt)||Number(learning.endsAt)<=0)return false;
  }
  return true;
}

function remoteError(value: unknown, status: number): ApiError {
  if (!object(value) || !fields(value, ['type', 'error', 'code']) || !text(value.error, 300)
      || (value.code !== undefined && (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)))) throw protocolError();
  const code = value.code as string | undefined;
  const streamStatus = code === 'CONTEXT_CHANGED' || code === 'LANGUAGE_CLARIFICATION_EXPIRED' ? 409 : code === 'CALL_EXPIRED' ? 410 : code === 'REQUEST_ABORTED' ? 499 : code === 'LANGUAGE_UNCERTAIN' ? 422 : 502;
  return new ApiError(value.error, status >= 400 ? status : streamStatus, code);
}

/** Receives only this request's transcript; the caller owns cancellation and UI epochs. */
export async function readAudioTurnStream(response: Response, onTranscript: (text: string, metadata?: AudioInputMetadata) => void): Promise<Turn> {
  if (!response.body) throw protocolError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let buffer = '';
  let transcript: string | undefined;
  let metadata: AudioInputMetadata | undefined;
  let turn: Turn | undefined;
  let complete = false;
  const consume = (line: string) => {
    if (!line || encoder.encode(line).byteLength > MAX_LINE || turn) throw protocolError();
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { throw protocolError(); }
    if (!object(frame)) throw protocolError();
    if (frame.type === 'error') throw remoteError(frame, response.status);
    if (frame.type === 'transcript') {
      if (transcript !== undefined || !fields(frame, ['type', 'text','inputSource','detectedLanguage']) || !text(frame.text, 1000) || !validInputMetadata(frame)) throw protocolError();
      transcript = frame.text;
      metadata = frame.inputSource === undefined && frame.detectedLanguage === undefined ? undefined : {
        ...(frame.inputSource === undefined ? {} : { inputSource: frame.inputSource as AudioInputMetadata['inputSource'] }),
        ...(frame.detectedLanguage === undefined ? {} : { detectedLanguage: frame.detectedLanguage as AudioInputMetadata['detectedLanguage'] }),
      };
      onTranscript(transcript, metadata);
    } else if (frame.type === 'turn') {
      if (!fields(frame, ['type', 'turn']) || !validTurn(frame.turn, transcript, metadata)) throw protocolError();
      // Bad optional plans cannot alter valid text or request arbitrary segments.
      const { replySegments: _plan, ...plainTurn } = frame.turn;
      const segments = replySegmentsForTurn(frame.turn);
      turn = segments ? { ...plainTurn, replySegments: segments } : plainTurn;
    } else throw protocolError();
  };
  try {
    const size = response.headers.get('content-length');
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) throw protocolError();
    if (response.ok && !/^application\/x-ndjson(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) throw protocolError();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw protocolError();
      try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { throw protocolError(); }
      if (!response.ok) continue;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        consume(line);
      }
      if (encoder.encode(buffer).byteLength > MAX_LINE) throw protocolError();
    }
    try { buffer += decoder.decode(); } catch { throw protocolError(); }
    if (!response.ok) {
      let error: unknown;
      try { error = JSON.parse(buffer); } catch { throw protocolError(); }
      throw remoteError(error, response.status);
    }
    // The final newline and clean EOF prove the last frame wasn't truncated.
    if (buffer || !turn) throw protocolError();
    complete = true;
    return turn;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
