import type { ReplyExpression, ReplySegment, Turn } from './types';

const expressions = new Set<ReplyExpression>(['natural', 'bright', 'gentle', 'clear']);

/** A plan cannot change the registered reply, inject controls, or add unbounded work. */
export function validateReplySegments(reply: string, value: unknown): ReplySegment[] | undefined {
  if (typeof reply !== 'string' || !reply.trim() || reply.length > 600
    || !Array.isArray(value) || value.length < 1 || value.length > 3) return undefined;
  const result: ReplySegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => key !== 'text' && key !== 'expression')) return undefined;
    const segment = item as Record<string, unknown>;
    if (typeof segment.text !== 'string' || !segment.text.trim() || segment.text !== segment.text.trim()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(segment.text)
      || !expressions.has(segment.expression as ReplyExpression)) return undefined;
    result.push({ text: segment.text, expression: segment.expression as ReplyExpression });
  }
  return result.map(segment => segment.text).join('\n\n') === reply ? result : undefined;
}

/** Activities and language confirmations keep their existing one-audio lifecycle. */
export function replySegmentsForTurn(turn: Turn): ReplySegment[] | undefined {
  if (turn.story || turn.learning || turn.languageClarification
    || (turn.conversationMode?.mode === 'dialect' && turn.conversationMode.behavior === 'translate')) return undefined;
  return validateReplySegments(turn.reply, turn.replySegments);
}

export function replySegmentEmotion(expression: ReplyExpression): NonNullable<Turn['emotion']> {
  return ({ natural: 'warm', bright: 'happy', gentle: 'calm', clear: 'thoughtful' } as const)[expression];
}

/** The server chooses registered text and delivery; the client sends only an index. */
export function speechRequestBody(replyId: string, segmentIndex?: number): string {
  if (segmentIndex !== undefined && (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 2)) {
    throw new Error('声音段落无效，请重新试一次。');
  }
  return JSON.stringify({ replyId, ...(segmentIndex === undefined ? {} : { segmentIndex }) });
}
