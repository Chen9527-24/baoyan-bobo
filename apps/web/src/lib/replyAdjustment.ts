import { prepareCalibrationSubmission, type CalibrationDraft } from './calibration';
import type { PromptLabAge, PromptLabHistory, PromptLabMemory } from './promptLab';

export interface ReplyAdjustmentInput {
  ageGroup: PromptLabAge;
  question: string;
  actualReply: string;
  guideline: string;
  testHistory: PromptLabHistory[];
  testMemories: PromptLabMemory[];
  fictionalConfirmed: true;
}
export interface ReplyAdjustmentRun extends ReplyAdjustmentInput {
  id: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  reply: string;
  elapsedMs: number;
  model: string;
  personaVersion: string;
  baselinePrompt: string;
  experimentPrompt: string;
}
export interface ReplyAdjustmentConfirmation {
  operationId: string;
  runId: string;
  title: string;
  fictionalConfirmed: true;
  satisfied: true;
}
export function prepareReplyAdjustment(draft: CalibrationDraft, confirmed: boolean): ReplyAdjustmentInput {
  // Old comparison snapshots and ideal answers must not silently become instructions.
  const input = prepareCalibrationSubmission({ ...draft, expectedReply: '', title: undefined, note: '' }, confirmed);
  if (!input.guideline) throw new Error('告诉宝妍你希望怎么回答，写一句方向就可以。');
  return { ageGroup: input.ageGroup, question: input.question, actualReply: input.actualReply,
    guideline: input.guideline, testHistory: input.testHistory, testMemories: input.testMemories, fictionalConfirmed: true };
}
export function replyAdjustmentMatches(run: ReplyAdjustmentRun, draft: CalibrationDraft, confirmed: boolean): boolean {
  try {
    const input = prepareReplyAdjustment(draft, confirmed);
    return (['ageGroup', 'question', 'actualReply', 'guideline', 'testHistory', 'testMemories'] as const)
      .every(key => JSON.stringify(input[key]) === JSON.stringify(run[key]));
  } catch { return false; }
}
export function replyAdjustmentConfirmation(run: ReplyAdjustmentRun, id: string, title: string): ReplyAdjustmentConfirmation {
  const cleaned = title.trim() || run.question.slice(0, 40);
  if (cleaned.length > 80) throw new Error('场景名字不能超过 80 字。');
  return { operationId: id, runId: run.id, title: cleaned, fictionalConfirmed: true, satisfied: true };
}
