import type { LanguageClarification, SpeechLanguage } from './types';
import { ApiError } from './api';

export const LANGUAGE_QUESTION = '你刚才说的是什么语言？';
export const LANGUAGE_EXPIRED = '刚才那段语音已经过期，请重新说一次。';
export const speechLanguages: ReadonlyArray<{ value: SpeechLanguage; label: string }> = [
  { value: 'mandarin', label: '普通话' },
  { value: 'hakka', label: '客家话' },
  { value: 'chaoshan', label: '潮汕话' },
  { value: 'cantonese', label: '粤语' },
  { value: 'english', label: '英语' },
];

export function isLanguageClarification(value: unknown): value is LanguageClarification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => key === 'id' || key === 'expiresAt')
    && typeof record.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)
    && typeof record.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(record.expiresAt)
    && Number.isFinite(Date.parse(record.expiresAt));
}

/** Capture at send/release, not microphone press, so a long recording cannot revive an expired question. */
export function languageAnswerContext(clarification: LanguageClarification | undefined, expired = false, now = Date.now()) {
  if (!clarification) return;
  if (expired || Date.parse(clarification.expiresAt) <= now) throw new ApiError(`${LANGUAGE_EXPIRED} 先点“我来说”取消这一句，再说原来的话。`, 409, 'LANGUAGE_CLARIFICATION_EXPIRED');
  return { clarificationId: clarification.id };
}

export function recoverExpiredLanguageQuestion(error: unknown,
  context: { question: LanguageClarification; callId: string; generation: number } | undefined,
  current: { callId: string | undefined; generation: number }) {
  if (context && context.callId === current.callId && context.generation === current.generation
    && error instanceof ApiError && error.status === 409 && error.code === 'LANGUAGE_CLARIFICATION_EXPIRED') return context.question;
}

/** A confirmation belongs to one audio question, call and UI generation, and can be claimed once. */
export class LanguageClarificationSession {
  private pending?: { clarification: LanguageClarification; callId: string; generation: number };
  offer(clarification: LanguageClarification, callId: string, generation: number) {
    this.pending = { clarification, callId, generation };
  }
  clear() { this.pending = undefined; }
  matches(id: string, callId: string, generation: number) {
    return this.pending?.clarification.id === id && this.pending.callId === callId && this.pending.generation === generation;
  }
  take(id: string, language: SpeechLanguage, callId: string, generation: number, now = Date.now()) {
    const pending = this.pending;
    if (!pending || pending.clarification.id !== id || pending.callId !== callId || pending.generation !== generation
      || !speechLanguages.some(option => option.value === language)) return;
    if (Date.parse(pending.clarification.expiresAt) <= now) { this.clear(); return; }
    this.clear();
    return { clarificationId: id, language };
  }
}
