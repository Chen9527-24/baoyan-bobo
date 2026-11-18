import { ApiError, messageOf } from './api';
import type { Child } from './types';

export type PromptLabAge = Child['ageGroup'];
export type PromptLabChoice = 'baseline' | 'experiment' | 'tie' | 'neither';
export interface PromptLabLimits { promptChars: number; questionChars: number; noteChars: number; maxSaved: number; historyMessages?: number; historyChars?: number; testMemories?: number; memoryChars?: number }
export interface PromptLabConfig {
  model: string; personaVersion: string; ageGroup: PromptLabAge; baselinePrompt: string;
  configured: boolean; limits: PromptLabLimits;
}
export interface PromptLabHistory { role: 'user' | 'assistant'; content: string }
export interface PromptLabMemory { key: string; content: string; kind: 'preference' | 'event' | 'imaginary' | 'plan' }
export interface PromptLabDraft { ageGroup: PromptLabAge; question: string; experimentPrompt: string; testHistory?: PromptLabHistory[]; testMemories?: PromptLabMemory[]; fictionalConfirmed?: boolean }
export interface PromptLabResult { reply?: string; error?: string; elapsedMs: number }
export interface PromptLabRun extends PromptLabDraft {
  id: string; createdAt: string; model: string; personaVersion: string; baselinePrompt: string;
  baseline: PromptLabResult; experiment: PromptLabResult; expiresAt: string;
  displayOrder?: ['baseline', 'experiment'] | ['experiment', 'baseline'];
}
export interface PromptLabRecord extends PromptLabRun {
  choice: PromptLabChoice; note: string; expectedReply: string; savedAt: string;
}
export const promptLabChoices: { value: PromptLabChoice; label: string }[] = [
  { value: 'baseline', label: 'A 更好' }, { value: 'experiment', label: 'B 更好' },
  { value: 'tie', label: '差不多' }, { value: 'neither', label: '都不满意' },
];
export const promptLabDefaultLimits: PromptLabLimits = { promptChars: 6000, questionChars: 1200, noteChars: 1000, maxSaved: 50, historyMessages: 8, historyChars: 600, testMemories: 3, memoryChars: 60 };

export function preparePromptLabDraft(draft: PromptLabDraft, limits: PromptLabLimits): PromptLabDraft {
  const question = draft.question.trim();
  const experimentPrompt = draft.experimentPrompt.trim();
  if (!question) throw new Error('先填写一个想比较的问题。');
  if (question.length > limits.questionChars) throw new Error(`问题不能超过 ${limits.questionChars} 字。`);
  if (!experimentPrompt) throw new Error('B 版提示词不能为空，可以恢复为 A 版后修改。');
  if (experimentPrompt.length > limits.promptChars) throw new Error(`提示词不能超过 ${limits.promptChars} 字。`);
  const testHistory = (draft.testHistory ?? []).map(message => ({ role: message.role, content: message.content.trim() }));
  const testMemories = (draft.testMemories ?? []).map(memory => ({ key: memory.key.trim(), content: memory.content.trim(), kind: memory.kind }));
  const historyChars = limits.historyChars ?? 600;
  if (testHistory.length > (limits.historyMessages ?? 8) || testHistory.length % 2 !== 0 || testHistory.some((message, index) => message.role !== (index % 2 === 0 ? 'user' : 'assistant'))) throw new Error('测试前文最多 4 轮，按用户和宝妍交替填写。');
  if (testHistory.some(message => !message.content || message.content.length > historyChars)) throw new Error(`每句前文须填写 1 至 ${historyChars} 字；空轮次可以删除。`);
  if (testMemories.length > (limits.testMemories ?? 3)) throw new Error('测试记忆最多 3 条。');
  if (testMemories.some(memory => !/^test\.[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(memory.key) || !['preference', 'event', 'imaginary', 'plan'].includes(memory.kind))) throw new Error('测试记忆标识须为 test. 开头的英文或数字，类型须从选项中选择。');
  if (new Set(testMemories.map(memory => memory.key)).size !== testMemories.length) throw new Error('测试记忆标识不能重复。');
  if (testMemories.some(memory => !memory.content || memory.content.length > (limits.memoryChars ?? 60))) throw new Error(`每条测试记忆须填写 1 至 ${limits.memoryChars ?? 60} 字。`);
  if ((testHistory.length || testMemories.length) && draft.fictionalConfirmed !== true) throw new Error('请确认前文和测试记忆均为虚构内容。');
  const result: PromptLabDraft = { ageGroup: draft.ageGroup, question, experimentPrompt };
  if (draft.testHistory !== undefined || draft.testMemories !== undefined || draft.fictionalConfirmed !== undefined) Object.assign(result, { testHistory, testMemories, fictionalConfirmed: draft.fictionalConfirmed === true });
  return result;
}

/** Results always belong to their generated snapshot, never the current editable fields. */
export function promptLabDraftMatches(run: PromptLabRun, draft: PromptLabDraft): boolean {
  return run.ageGroup === draft.ageGroup && run.question === draft.question.trim()
    && run.experimentPrompt === draft.experimentPrompt.trim()
    && JSON.stringify(run.testHistory ?? []) === JSON.stringify((draft.testHistory ?? []).map(message => ({ role: message.role, content: message.content.trim() })))
    && JSON.stringify(run.testMemories ?? []) === JSON.stringify((draft.testMemories ?? []).map(memory => ({ key: memory.key.trim(), content: memory.content.trim(), kind: memory.kind })))
    && ((!draft.testHistory?.length && !draft.testMemories?.length) || run.fictionalConfirmed === draft.fictionalConfirmed);
}

/** Legacy records predate blind display and retain their original A/B order. */
export function promptLabDisplayOrder(run: PromptLabRun): ['baseline', 'experiment'] | ['experiment', 'baseline'] {
  return run.displayOrder?.[0] === 'experiment' && run.displayOrder[1] === 'baseline' ? ['experiment', 'baseline'] : ['baseline', 'experiment'];
}

export function promptLabChoiceLabel(run: PromptLabRun, choice: PromptLabChoice): string {
  if (choice === 'tie') return '差不多';
  if (choice === 'neither') return '都不满意';
  const position = promptLabDisplayOrder(run).indexOf(choice) + 1;
  return `回复 ${position} 更好（${choice === 'baseline' ? '当前人设参考' : '实验提示词'}）`;
}

export function promptLabAuthorizationExpired(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function promptLabError(error: unknown): string {
  if (promptLabAuthorizationExpired(error)) return '家长验证已失效，请退出后重新进入家长空间。本页临时内容已清除。';
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return '连接中断或等待超时，未自动重试；本次可能已消耗模型额度。保存或删除的结果不确定时，请刷新已保存记录核对。';
  }
  return messageOf(error);
}

export function promptLabElapsed(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(2)} 秒`;
}

export function promptLabExport(record: PromptLabRecord): string {
  return JSON.stringify({ format: 'baoyan-prompt-lab-v2', scope: '文字提示词对比，可含显式虚构前文和测试记忆；不含语音、真实家庭记忆或正式聊天固定分支', record }, null, 2);
}
