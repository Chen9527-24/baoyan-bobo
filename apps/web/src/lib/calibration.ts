import type { PromptLabAge, PromptLabChoice, PromptLabHistory, PromptLabMemory, PromptLabResult, PromptLabRun } from './promptLab';

export type CalibrationStatus = 'proposed' | 'accepted' | 'rejected';
export interface CalibrationDraft {
  question: string;
  actualReply: string;
  ageGroup: PromptLabAge;
  title?: string;
  category?: string;
  expectedReply?: string;
  guideline?: string;
  note?: string;
  testHistory?: PromptLabHistory[];
  testMemories?: PromptLabMemory[];
  sourceSampleId?: string;
  model?: string;
  personaVersion?: string;
  baselinePrompt?: string;
  experimentPrompt?: string;
  comparison?: CalibrationComparisonSnapshot;
  rewrite?: CalibrationRewrite;
}
export interface CalibrationRewrite {
  generationId: string;
  guideline: string;
  model: string;
  personaVersion: string;
  elapsedMs: number;
  generatedAt: string;
  confirmedAt: string;
  actualReplySource: 'user-provided' | 'not-provided';
  provenance: 'server-generated' | 'imported-unverified';
}
export interface CalibrationComparisonSnapshot {
  runId: string;
  choice: PromptLabChoice;
  rated?: boolean;
  baseline: PromptLabResult;
  experiment: PromptLabResult;
  displayOrder: ['baseline', 'experiment'] | ['experiment', 'baseline'];
}
export interface CalibrationSubmission extends CalibrationDraft {
  title: string;
  category: string;
  expectedReply: string;
  guideline: string;
  note: string;
  testHistory: PromptLabHistory[];
  testMemories: PromptLabMemory[];
  fictionalConfirmed: true;
}
export interface CalibrationReview {
  status: CalibrationStatus;
  previousStatus: CalibrationStatus;
  note: string;
  date: string;
}
export interface CalibrationCase extends CalibrationSubmission {
  id: string;
  revision: number;
  status: CalibrationStatus;
  createdAt: string;
  updatedAt: string;
  reviewNote: string;
  reviewHistory: CalibrationReview[];
  importedFrom?: CalibrationImportSource;
  importHistory?: CalibrationImportSource[];
}
export interface CalibrationImportSource {
  id?: string; revision?: number; status?: CalibrationStatus; createdAt?: string; updatedAt?: string;
  reviewNote: string; reviewHistory: CalibrationReview[]; importedAt: string;
}
export interface CalibrationSample {
  id: string;
  title: string;
  ageGroup: PromptLabAge;
  category: string;
  question: string;
  testHistory: PromptLabHistory[];
  testMemories: PromptLabMemory[];
  expectedReply: string;
  guideline: string;
  avoid: string[];
}
export interface CalibrationComparisonDraft {
  question: string;
  ageGroup: PromptLabAge;
  testHistory: PromptLabHistory[];
  testMemories: PromptLabMemory[];
  expectedReply: string;
  guideline: string;
  sourceSampleId?: string;
  model?: string;
}
export interface CalibrationExport {
  schemaVersion: 'baoyan-calibration-v1';
  exportedAt?: string;
  scope?: 'family-fictional-calibration';
  samplesVersion?: string;
  cases: CalibrationCase[];
}
export const calibrationStatusLabels: Record<CalibrationStatus, string> = {
  proposed: '待确认', accepted: '已确认的参考', rejected: '暂不采用',
};
export interface CalibrationWorkflow {
  scope: 'family' | 'debug';
  automaticApplication: false;
  formalPersonaVersion: string;
  formalModel: string;
  applicationMode: 'reference-only';
  caseReleaseReceipt: 'not-recorded';
}
/** Confirmation is a reference decision, not a release or a model-training action. */
export function calibrationProgress(status: CalibrationStatus) {
  if (status === 'accepted') return {
    title: '满意场景已保存，还未用于聊天',
    detail: '你确认的接法已留在场景库。保存不会自动改变日常聊天；可以在下方选择希望采用的接话方向。',
    next: '先比较几种场景的新旧回答，确认后再采用这个方向。保存不会自动开始校准；不满意时可以撤回采用。',
    referenceConfirmed: true,
  };
  if (status === 'rejected') return {
    title: '这条接法暂不采用',
    detail: '原记录仍保留，不作为已确认的参考。',
    next: '可以换个方向试答，满意后保存新场景；也可以重新确认这条建议。',
    referenceConfirmed: false,
  };
  return {
    title: '建议已保存，等你确认',
    detail: '这条还不是已确认的满意场景。导入的场景也需要重新确认。',
    next: '先试答看看，满意后保存；已有期望接法时，也可以确认它作为校准参考。',
    referenceConfirmed: false,
  };
}
export const calibrationImportByteLimit = 2 * 1024 * 1024;
export const calibrationImportCaseLimit = 200;
/** Leave room for the request wrapper and bounded operation metadata. */
export const calibrationExportPartByteLimit = Math.floor(1.8 * 1024 * 1024);

const ages = ['3-5', '6-8', '9-12', '13-14'] as const;
const cleanText = (value: unknown, name: string, max: number, required = false): string => {
  if (typeof value !== 'string') {
    if (value === undefined && !required) return '';
    throw new Error(`${name}需要填写文字。`);
  }
  const result = value.trim();
  if ((required && !result) || result.length > max) throw new Error(`${name}${required ? '须填写 1 至' : '不能超过'} ${max} 字。`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new Error(`${name}包含不支持的控制字符。`);
  return result;
};

/** Shared by the suggestion form and local import preview. No personal data is stored in the browser. */
export function prepareCalibrationSubmission(draft: CalibrationDraft, fictionalConfirmed: boolean, requireAdvice = true): CalibrationSubmission {
  if (fictionalConfirmed !== true) throw new Error('请先把内容改成虚构或脱敏示例，并确认不含真实儿童和家庭隐私。');
  if (!ages.includes(draft.ageGroup)) throw new Error('请选择模拟年龄段。');
  const question = cleanText(draft.question, '测试问题', 1200, true);
  const actualReply = cleanText(draft.actualReply, '需要调整的原回复', 1200);
  const expectedReply = cleanText(draft.expectedReply, '期望回复', 1200);
  const guideline = cleanText(draft.guideline, '调整建议', 1000);
  if (requireAdvice && !expectedReply && !guideline) throw new Error('请写一句期望回复，或说明希望怎样调整。');
  const title = cleanText(draft.title || question.slice(0, 40), '标题', 80, true);
  const category = cleanText(draft.category ?? '接话调整', '场景类别', 40);
  const note = cleanText(draft.note, '补充说明', 1000);
  if (draft.testHistory !== undefined && !Array.isArray(draft.testHistory)) throw new Error('测试前文需要是对话列表。');
  if (draft.testMemories !== undefined && !Array.isArray(draft.testMemories)) throw new Error('测试记忆需要是记忆列表。');
  const testHistory = (draft.testHistory ?? []).map((message, index) => ({ role: message.role, content: cleanText(message.content, `前文第 ${index + 1} 句`, 600, true) }));
  if (testHistory.length > 8 || testHistory.length % 2 !== 0 || testHistory.some((message, index) => message.role !== (index % 2 === 0 ? 'user' : 'assistant'))) throw new Error('测试前文最多 4 轮，按用户和宝妍交替填写。');
  const testMemories = (draft.testMemories ?? []).map(memory => ({ key: memory.key, content: cleanText(memory.content, '测试记忆', 60, true), kind: memory.kind }));
  if (testMemories.length > 3 || testMemories.some(memory => !/^test\.[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(memory.key) || !['preference', 'event', 'imaginary', 'plan'].includes(memory.kind))) throw new Error('测试记忆最多 3 条，标识需以 test. 开头，类型从测试记忆选项中选择。');
  if (new Set(testMemories.map(memory => memory.key)).size !== testMemories.length) throw new Error('测试记忆标识不能重复。');
  const result: CalibrationSubmission = { ageGroup: draft.ageGroup, title, category, question, actualReply, expectedReply, guideline, note, testHistory, testMemories, fictionalConfirmed: true };
  for (const key of ['sourceSampleId', 'model', 'personaVersion'] as const) {
    if (draft[key]) result[key] = cleanText(draft[key], key === 'sourceSampleId' ? '样本标识' : key === 'model' ? '模型标识' : '人设版本', key === 'model' ? 120 : 80);
  }
  for (const key of ['baselinePrompt', 'experimentPrompt'] as const) if (draft[key]) result[key] = cleanText(draft[key], '提示词快照', 6000);
  if (draft.comparison) result.comparison = draft.comparison;
  return result;
}

/** Imports are always reviewed again by the server; old accepted status never activates a rule. */
export function parseCalibrationImport(text: string): { schemaVersion: 'baoyan-calibration-v1'; cases: (CalibrationSubmission & Record<string, unknown>)[] } {
  if (new TextEncoder().encode(text).byteLength > calibrationImportByteLimit) throw new Error('记录文件不能超过 2 MiB。');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('无法读取这份 JSON 文件，请使用调优库导出的记录。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('记录文件格式不正确。');
  const document = parsed as { schemaVersion?: unknown; cases?: unknown };
  if (document.schemaVersion !== 'baoyan-calibration-v1') throw new Error('记录版本不支持，请使用 baoyan-calibration-v1 的导出文件。');
  if (!Array.isArray(document.cases) || document.cases.length < 1 || document.cases.length > calibrationImportCaseLimit) throw new Error(`每次导入须有 1 至 ${calibrationImportCaseLimit} 条记录，可拆成多批。`);
  const cases = document.cases.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 条记录格式不正确。`);
    if ((item as { fictionalConfirmed?: unknown }).fictionalConfirmed !== true) throw new Error(`第 ${index + 1} 条没有标记为虚构测试资料，请先核对原记录。`);
    // Keep the exported review and model provenance. The server strictly validates these
    // fields and resets active review status; the preview does not silently strip history.
    try { return { ...item, ...prepareCalibrationSubmission(item as CalibrationDraft, true, false) }; }
    catch (cause) { throw new Error(`第 ${index + 1} 条：${cause instanceof Error ? cause.message : '格式不正确。'}`); }
  });
  return { schemaVersion: 'baoyan-calibration-v1', cases };
}

/** Every part is an independently importable document, retaining all case provenance. */
export function splitCalibrationExport(document: CalibrationExport, byteLimit = calibrationExportPartByteLimit, caseLimit = calibrationImportCaseLimit): CalibrationExport[] {
  if (document.schemaVersion !== 'baoyan-calibration-v1' || !Array.isArray(document.cases)) throw new Error('导出记录的版本或格式不正确。');
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > calibrationExportPartByteLimit || !Number.isSafeInteger(caseLimit) || caseLimit < 1 || caseLimit > calibrationImportCaseLimit) throw new Error('分卷大小设置不正确。');
  const byteLength = (value: CalibrationExport) => new TextEncoder().encode(JSON.stringify(value, null, 2)).byteLength;
  const base = { ...document, cases: [] as CalibrationCase[] };
  if (byteLength(base) > byteLimit) throw new Error('导出资料的说明超过单卷大小限制。');
  const parts: CalibrationExport[] = [];
  let current: CalibrationExport = { ...base, cases: [] };
  for (const item of document.cases) {
    const candidate = { ...base, cases: [...current.cases, item] };
    if (candidate.cases.length > caseLimit || byteLength(candidate) > byteLimit) {
      if (current.cases.length === 0) throw new Error('有一条记录超过单卷大小限制，请联系开发者检查。');
      parts.push(current); current = { ...base, cases: [item] };
      if (byteLength(current) > byteLimit) throw new Error('有一条记录超过单卷大小限制，请联系开发者检查。');
    } else current = candidate;
  }
  if (current.cases.length || parts.length === 0) parts.push(current);
  return parts;
}

/** Reference examples are kept separate from the literal instructions they illustrate. */
export function calibrationExperimentPrompt(baseline: string, draft: CalibrationComparisonDraft): string {
  const reference = [
    draft.guideline ? `本次接话调整参考：\n${draft.guideline}` : '',
    draft.expectedReply ? `本次理想接法示例（仅参考语气与分寸，结合当前问题回答，不照搬）：\n${draft.expectedReply}` : '',
  ].filter(Boolean).join('\n\n');
  const result = reference ? `${baseline}\n\n${reference}` : baseline;
  if (result.length > 6000) throw new Error('当前人设与参考内容合计超过 6000 字。请缩短建议，或在 B 编辑区手动调整。');
  return result;
}

export function calibrationComparison(item: CalibrationSample | CalibrationCase): CalibrationComparisonDraft {
  return { question: item.question, ageGroup: item.ageGroup, testHistory: item.testHistory.map(message => ({ ...message })), testMemories: item.testMemories.map(memory => ({ ...memory })), expectedReply: item.expectedReply, guideline: item.guideline, sourceSampleId: 'revision' in item ? item.sourceSampleId : item.id, model: 'revision' in item ? item.model : undefined };
}

export function calibrationRunDraft(run: PromptLabRun, side: 'baseline' | 'experiment', expectedReply = '', note = '', sourceSampleId?: string, choice?: PromptLabChoice): CalibrationDraft {
  const displayOrder: CalibrationComparisonSnapshot['displayOrder'] = run.displayOrder?.[0] === 'experiment' && run.displayOrder[1] === 'baseline' ? ['experiment', 'baseline'] : ['baseline', 'experiment'];
  return { title: run.question.slice(0, 40), category: '同题比较', ageGroup: run.ageGroup, question: run.question, actualReply: run[side].reply ?? '', expectedReply, note, testHistory: (run.testHistory ?? []).map(message => ({ ...message })), testMemories: (run.testMemories ?? []).map(memory => ({ ...memory })), sourceSampleId, model: run.model, personaVersion: run.personaVersion, baselinePrompt: run.baselinePrompt, experimentPrompt: run.experimentPrompt, comparison: { runId: run.id, choice: choice ?? 'neither', rated: !!choice, baseline: { ...run.baseline }, experiment: { ...run.experiment }, displayOrder } };
}

export function calibrationSnapshotChoiceLabel(snapshot: CalibrationComparisonSnapshot): string {
  if (snapshot.rated === false) return '未评价（仅保存两版结果）';
  if (snapshot.rated !== true) return '原记录未标明评分状态';
  if (snapshot.choice === 'tie') return '差不多';
  if (snapshot.choice === 'neither') return '都不满意';
  const position = snapshot.displayOrder.indexOf(snapshot.choice) + 1;
  return `回复 ${position} 更好（${snapshot.choice === 'baseline' ? '原 A 人设' : '原 B 实验'}）`;
}
