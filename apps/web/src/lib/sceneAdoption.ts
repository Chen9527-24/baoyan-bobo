import type { CalibrationCase } from './calibration';
export type AdoptionPreference = 'concise' | 'listen-first' | 'fewer-questions';
export type AdoptionIntent = 'sharing' | 'help' | 'knowledge';
export interface ReplyDirection { version: '1'; steps: string[] }
export interface DirectionStep { id: string; label: string; description: string }
export interface DirectionPreview {
  id: string; operationId: string; caseId: string; caseRevision: number; ageGroup: CalibrationCase['ageGroup']; intent: AdoptionIntent;
  sourceText: string; direction: ReplyDirection; steps: DirectionStep[]; warnings: string[];
  model: string; personaVersion: string; replyPlanVersion: string; conversationPolicyVersion: string; policyVersion: string;
  createdAt: string; expiresAt: string; scope: 'family' | 'debug';
}
export interface SceneRetest {
  id: string; operationId: string; status: 'pending' | 'completed' | 'cancelled' | 'failed'; completed: number; total: number;
  createdAt: string; completedAt: string; baseVersion: number; model: string; personaVersion: string; replyPlanVersion: string;
  conversationPolicyVersion: string; policyVersion: string; scope: 'family' | 'debug'; cases: { id: string; revision: number }[]; error?: string;
  rows: { caseId: string; caseRevision: number; title: string; question: string; ageGroup: CalibrationCase['ageGroup']; expectedReply: string; reply?: string; error?: string; elapsedMs: number; adopted: boolean }[];
}
export type AdoptionChoice = 'candidate' | 'baseline' | 'tie' | 'neither';
export interface AdoptionReceipt {
  id: string; version: number; comparisonId: string; caseId: string; caseRevision: number;
  ageGroup: CalibrationCase['ageGroup']; intent: AdoptionIntent; preferences: AdoptionPreference[];
  model: string; personaVersion: string; replyPlanVersion: string; policyVersion: string; conversationPolicyVersion?: string;
  direction?: ReplyDirection; directionId?: string; appliedAt: string; scope: 'family' | 'debug'; choices?: AdoptionChoice[];
}
export interface AdoptionState { version: number; active?: AdoptionReceipt; lastChange?: { at: string; reason: string; previousId?: string } }
export interface AdoptionComparison {
  id: string; caseId: string; caseRevision: number; baseVersion: number; ageGroup: CalibrationCase['ageGroup']; intent: AdoptionIntent;
  preferences: AdoptionPreference[]; model: string; personaVersion: string; replyPlanVersion: string; policyVersion: string;
  createdAt: string; completedAt: string; expiresAt: string; scope: 'family' | 'debug'; operationId: string;
  direction?: ReplyDirection; directionId?: string; status: 'pending' | 'completed' | 'cancelled' | 'failed'; completedPairs: number; total: number; error?: string;
  rows: { id: string; label: string; question: string; ageGroup: CalibrationCase['ageGroup']; baseline: { reply?: string; error?: string; elapsedMs: number }; candidate: { reply?: string; error?: string; elapsedMs: number } }[];
}
export interface AdoptionOverview {
  scope: 'family' | 'debug'; state: AdoptionState; configured: boolean; policyVersion: string;
  model?: string; personaVersion?: string; replyPlanVersion?: string; conversationPolicyVersion?: string;
  preferences: { id: AdoptionPreference; label: string; description: string }[];
  intents: { id: AdoptionIntent; label: string }[]; reports: AdoptionComparison[];
  directionSteps?: DirectionStep[]; directionExamples?: string[]; directions?: DirectionPreview[]; retests?: SceneRetest[];
}
export function adoptionCanApply(report: AdoptionComparison | null, choices: (AdoptionChoice | '')[], state: AdoptionState | undefined, item: Pick<CalibrationCase, 'id' | 'revision' | 'status'>, now = Date.now()) {
  return !!report && item.status === 'accepted' && report.caseId === item.id && report.caseRevision === item.revision
    && report.status === 'completed' && report.baseVersion === state?.version && Date.parse(report.expiresAt) > now
    && report.rows.length === 3 && report.rows.every(row => !!row.baseline.reply && !!row.candidate.reply && !row.baseline.error && !row.candidate.error)
    && choices.length === 3 && choices.every(choice => choice === 'candidate' || choice === 'tie') && choices.slice(0, 2).includes('candidate');
}
export const adoptionPreferenceLabels: Record<AdoptionPreference, string> = { concise: '说短一点', 'listen-first': '先接住我的话', 'fewer-questions': '少一点追问' };
export const adoptionIntentLabels: Record<AdoptionIntent, string> = { sharing: '分享心情和日常', help: '请宝妍帮忙想办法', knowledge: '问知识和原因' };
export const adoptionScopeLabel = (scope: 'family' | 'debug') => scope === 'debug' ? '仅内测调试' : '仅本家庭';

export function directionMatches(preview: DirectionPreview | null, item: Pick<CalibrationCase, 'id' | 'revision' | 'status'>, text: string, intent: AdoptionIntent, scope: 'family' | 'debug', now = Date.now()) {
  return !!preview && item.status === 'accepted' && preview.caseId === item.id && preview.caseRevision === item.revision
    && preview.sourceText === text.trim() && preview.intent === intent && preview.scope === scope
    && preview.direction.version === '1' && preview.direction.steps.length > 0 && Date.parse(preview.expiresAt) > now;
}
export function directionLabel(value: { preferences: AdoptionPreference[]; direction?: ReplyDirection }, catalog: DirectionStep[] = []) {
  return value.direction?.steps.length ? value.direction.steps.map(id => catalog.find(step => step.id === id)?.label ?? '已确认的接话步骤').join(' → ')
    : value.preferences.map(id => adoptionPreferenceLabels[id]).join('、');
}
export function retestSelection(cases: CalibrationCase[], selected: string[]) {
  const ids = new Set(selected);
  if (ids.size !== selected.length || ids.size < 3 || ids.size > 5) return null;
  const found = cases.filter(item => ids.has(item.id));
  return found.length === ids.size && found.every(item => item.status === 'accepted' && !!item.expectedReply?.trim()) ? found.map(item => ({ id: item.id, revision: item.revision })) : null;
}
