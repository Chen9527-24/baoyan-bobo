import { ApiError, api, operationId } from './api';
import type { CallState } from './types';

export const FEEDBACK_RECORDING_SECONDS = 25;
export type FeedbackPage = 'setup' | 'home' | 'call' | 'parent' | 'connection' | 'expired';
export interface FeedbackContext { page: FeedbackPage; callState: CallState; appVersion: string }
export interface FeedbackReceipt { id: string; createdAt: string }
interface FeedbackRequest { operationId: string; text: string; audio: Blob | null; context: FeedbackContext }

/** Keep the same operation key for retries of the same draft. Never persist private drafts. */
export class FeedbackAttempt {
  private previous?: FeedbackRequest;
  constructor(private readonly newId: () => string = operationId) {}
  prepare(text: string, audio: Blob | null, context: FeedbackContext): FeedbackRequest {
    const cleaned = text.trim();
    if (!cleaned && !audio) throw new Error('写几个字，或者录一段语音，就可以提交。');
    if (text.length > 2000) throw new Error('文字最多 2000 字，请缩短一点。');
    if (audio && (audio.type !== 'audio/wav' || audio.size <= 44 || audio.size > 1_000_000)) throw new Error('录音格式不正确或过大，请重新录一段。');
    const same = this.previous && this.previous.text === cleaned && this.previous.audio === audio
      && this.previous.context.page === context.page && this.previous.context.callState === context.callState
      && this.previous.context.appVersion === context.appVersion;
    if (!same) this.previous = { operationId: this.newId(), text: cleaned, audio,
      context: { page: context.page, callState: context.callState, appVersion: context.appVersion } };
    return this.previous!;
  }
}

export async function submitFeedback(request: FeedbackRequest, signal: AbortSignal): Promise<FeedbackReceipt> {
  // Establish the anonymous HttpOnly cookie before the upload; do not request a model or transcription.
  await api<{ ok: true }>('/feedback/context', { signal });
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const form = new FormData();
  form.set('operationId', request.operationId);
  form.set('text', request.text);
  form.set('context', JSON.stringify(request.context));
  if (request.audio) form.set('audio', request.audio, 'feedback.wav');
  const result = await api<FeedbackReceipt>('/feedback', { method: 'POST', body: form, signal });
  if (!result || typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(result.id)
    || typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt))) {
    throw new ApiError('提交结果尚未确认。', 502, 'FEEDBACK_RESULT_UNCONFIRMED');
  }
  return { id: result.id, createdAt: result.createdAt };
}

export function feedbackError(error: unknown): string {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return error.message;
  return '暂时无法确认是否提交成功，内容已保留。请稍后用相同内容重试，会核对并避免重复报告。';
}
