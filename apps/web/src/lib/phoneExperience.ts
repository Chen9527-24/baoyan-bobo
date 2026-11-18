import { ApiError } from './api';

export const PHONE_EXPERIENCE_ENVIRONMENTS = ['iphone-wechat', 'iphone-safari', 'android-wechat', 'android-chrome', 'other-phone'] as const;
export type PhoneExperienceEnvironment = typeof PHONE_EXPERIENCE_ENVIRONMENTS[number];
export const PHONE_EXPERIENCE_TAGS = ['voice-delay', 'voice-flat', 'voice-unclear', 'playback-failed', 'too-formal', 'too-many-questions', 'wrong-memory', 'natural', 'other'] as const;
export type PhoneExperienceTag = typeof PHONE_EXPERIENCE_TAGS[number];
export const PHONE_EXPERIENCE_SCORE_KEYS = ['voiceClarity', 'voiceFeeling', 'replyNaturalness', 'continuity', 'overall'] as const;
export type PhoneExperienceScoreKey = typeof PHONE_EXPERIENCE_SCORE_KEYS[number];
export type PhoneExperienceScores = Record<PhoneExperienceScoreKey, number>;
export const PHONE_OBSERVATION_RESULTS = ['smooth', 'problem', 'uncertain'] as const;
export type PhoneObservationResult = typeof PHONE_OBSERVATION_RESULTS[number];
export const PHONE_OBSERVATION_STAGES = ['recording', 'recognition', 'understanding', 'reply', 'voice', 'memory', 'interruption', 'other'] as const;
export type PhoneObservationStage = typeof PHONE_OBSERVATION_STAGES[number];
export const PHONE_OBSERVATION_LANGUAGES = ['mandarin', 'english', 'chaoshan', 'hakka', 'cantonese', 'mixed', 'other', 'uncertain'] as const;
export type PhoneObservationLanguage = typeof PHONE_OBSERVATION_LANGUAGES[number];
export const PHONE_OBSERVATION_NETWORKS = ['wifi', 'mobile', 'uncertain'] as const;
export interface PhoneExperienceObservation {
  result: PhoneObservationResult;
  stages: PhoneObservationStage[];
  language: PhoneObservationLanguage;
  intendedMeaning: string;
  recognizedText: string;
  deviceModel: string;
  network: typeof PHONE_OBSERVATION_NETWORKS[number];
}
export interface PhoneExperienceDraft {
  operationId: string;
  adultFictionalConfirmed: true;
  phoneUsedConfirmed: true;
  environment: PhoneExperienceEnvironment;
  scores: PhoneExperienceScores;
  tags: PhoneExperienceTag[];
  note: string;
  observation?: PhoneExperienceObservation;
}
export interface PhoneExperienceRecord {
  id: string;
  day: string;
  createdAt: string;
  scores: PhoneExperienceScores;
  tags: PhoneExperienceTag[];
  note: string;
  environment: PhoneExperienceEnvironment;
  parentUsedPhoneConfirmed: true;
  observation?: PhoneExperienceObservation;
}
export interface PhoneExperienceState {
  startedAt: string | null;
  today: string;
  records: PhoneExperienceRecord[];
  completedDays: number;
}

export const PHONE_ENVIRONMENT_LABELS: Record<PhoneExperienceEnvironment, string> = {
  'iphone-wechat': 'iPhone · 微信', 'iphone-safari': 'iPhone · Safari',
  'android-wechat': '安卓 · 微信', 'android-chrome': '安卓 · Chrome', 'other-phone': '其他手机浏览器',
};
export const PHONE_TAG_LABELS: Record<PhoneExperienceTag, string> = {
  'voice-delay': '声音等得久', 'voice-flat': '语气太平', 'voice-unclear': '听不清', 'playback-failed': '声音没播放',
  'too-formal': '回复太正式', 'too-many-questions': '追问太多', 'wrong-memory': '记忆接错了', 'natural': '接话自然', 'other': '其他',
};
export const PHONE_SCORE_LABELS: Record<PhoneExperienceScoreKey, string> = {
  voiceClarity: '声音听得清吗', voiceFeeling: '语气贴合这句话吗', replyNaturalness: '回复像自然聊天吗',
  continuity: '能接住前文和旧话题吗', overall: '今天整体聊得顺吗',
};
export const PHONE_OBSERVATION_RESULT_LABELS: Record<PhoneObservationResult, string> = { smooth: '聊得顺畅', problem: '遇到了问题', uncertain: '还说不准' };
export const PHONE_OBSERVATION_STAGE_LABELS: Record<PhoneObservationStage, string> = {
  recording: '录不到声音', recognition: '页面文字听错了', understanding: '文字对了，意思没懂', reply: '回答不合适',
  voice: '声音慢、太平或没播放', memory: '记忆没接上或接错', interruption: '锁屏、来电或断网后异常', other: '其他问题',
};
export const PHONE_OBSERVATION_LANGUAGE_LABELS: Record<PhoneObservationLanguage, string> = {
  mandarin: '普通话', english: '英语', chaoshan: '潮汕话', hakka: '客家话', cantonese: '粤语', mixed: '几种语言混着说', other: '其他语言', uncertain: '不确定',
};
export const PHONE_OBSERVATION_NETWORK_LABELS = { wifi: 'Wi-Fi', mobile: '手机流量', uncertain: '不确定' } as const;

export function preparePhoneObservation(input: PhoneExperienceObservation): PhoneExperienceObservation {
  if (!PHONE_OBSERVATION_RESULTS.includes(input.result)) throw new Error('请选择这次聊得怎么样。');
  if (!Array.isArray(input.stages) || input.stages.length > 4 || new Set(input.stages).size !== input.stages.length || input.stages.some(stage => !PHONE_OBSERVATION_STAGES.includes(stage))) throw new Error('问题环节最多选择 4 个。');
  if (input.result === 'problem' && !input.stages.length) throw new Error('请选择遇到问题的环节；不确定时可选其他问题。');
  if (input.result === 'smooth' && input.stages.length) throw new Error('聊得顺畅时不用选择问题环节。');
  if (!PHONE_OBSERVATION_LANGUAGES.includes(input.language)) throw new Error('请选择实际说的语言，不确定时可选不确定。');
  if (!PHONE_OBSERVATION_NETWORKS.includes(input.network)) throw new Error('请选择网络情况。');
  const boundedText = (value: string, limit: number, label: string) => {
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}最多 ${limit} 字，请写成一句话。`);
    return value.trim();
  };
  return { result: input.result, stages: [...input.stages], language: input.language,
    intendedMeaning: boundedText(input.intendedMeaning, 200, '原本想说的意思'), recognizedText: boundedText(input.recognizedText, 200, '页面识别的文字'),
    deviceModel: boundedText(input.deviceModel, 60, '手机型号'), network: input.network };
}

export function preparePhoneExperienceDraft(input: {
  operationId: string; adultFictionalConfirmed: boolean; phoneUsedConfirmed: boolean;
  environment: string; scores: PhoneExperienceScores; tags: string[]; note: string; observation?: PhoneExperienceObservation;
}): PhoneExperienceDraft {
  if (!input.adultFictionalConfirmed || !input.phoneUsedConfirmed) throw new Error('请先确认成年虚构资料体验，并已在手机上完成语音体验。');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)) throw new Error('这次记录编号无效，请重新打开。');
  if (!PHONE_EXPERIENCE_ENVIRONMENTS.includes(input.environment as PhoneExperienceEnvironment)) throw new Error('请选择实际体验的手机浏览器。');
  const scores = {} as PhoneExperienceScores;
  for (const key of PHONE_EXPERIENCE_SCORE_KEYS) {
    const score = input.scores[key];
    if (!Number.isInteger(score) || score < 0 || score > 5) throw new Error('每项请选择 1 至 5 分，或选择未体验。');
    scores[key] = score;
  }
  const observation = input.observation === undefined ? undefined : preparePhoneObservation(input.observation);
  if (!observation && !PHONE_EXPERIENCE_SCORE_KEYS.some(key => scores[key] >= 1)) throw new Error('请至少记录一项实际体验。');
  if (!Array.isArray(input.tags) || input.tags.length > 5 || new Set(input.tags).size !== input.tags.length || input.tags.some(tag => !PHONE_EXPERIENCE_TAGS.includes(tag as PhoneExperienceTag))) throw new Error('体验标签最多选择 5 个。');
  if (input.note.length > 500) throw new Error('补充内容最多 500 字。');
  if (/[\u0000-\u001f\u007f]/.test(input.note)) throw new Error('补充内容请写成一句话，不使用换行或其他控制字符。');
  const note = input.note.trim();
  return {
    operationId: input.operationId, adultFictionalConfirmed: true, phoneUsedConfirmed: true,
    environment: input.environment as PhoneExperienceEnvironment, scores, tags: [...input.tags] as PhoneExperienceTag[], note,
    ...(observation ? { observation } : {}),
  };
}

export function phoneExperienceProgress(state: PhoneExperienceState): { completed: number; todayRecorded: boolean; nextDay: 1 | 2 | 3; allDaysRecorded: boolean } {
  const days = new Set(state.records.map(record => record.day));
  const completed = Math.max(0, Math.min(3, state.completedDays));
  return { completed, todayRecorded: days.has(state.today), nextDay: (Math.min(3, completed + 1) as 1 | 2 | 3), allDaysRecorded: completed >= 3 };
}

/** Scope failures revoke this page's cached household data; transport and ordinary
 * submission conflicts are recoverable and must not silently discard a draft. */
export function phoneExperienceScopeInvalid(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403
    || error.status === 409 && error.code === 'CONTEXT_CHANGED'
    || error.status === 404 && error.code === 'PHONE_EXPERIENCE_SCOPE');
}
