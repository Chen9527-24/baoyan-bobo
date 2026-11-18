import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneExperienceProgress, preparePhoneExperienceDraft, phoneExperienceScopeInvalid, type PhoneExperienceState, type PhoneExperienceObservation } from '../apps/web/src/lib/phoneExperience.ts';
import { ApiError } from '../apps/web/src/lib/api.ts';

const valid = () => ({ operationId: '12345678-1234-4123-8123-123456789abc', adultFictionalConfirmed: true, phoneUsedConfirmed: true, environment: 'iphone-wechat', scores: { voiceClarity: 4, voiceFeeling: 3, replyNaturalness: 4, continuity: 0, overall: 4 }, tags: ['voice-flat'], note: '  今天语气有一点平。  ' });
const observation = (): PhoneExperienceObservation => ({ result: 'problem', stages: ['recognition'], language: 'chaoshan', intendedMeaning: '  晚上十点回家。  ', recognizedText: '晚上八点回家。', deviceModel: 'iPhone 15', network: 'wifi' });

test('explicit phone reports keep only self-entered bounded ratings and descriptions, not unknown context', () => {
  const source = { ...valid(), conversation: 'private text', audio: 'private bytes', ua: 'private device', pin: 'secret' };
  const result = preparePhoneExperienceDraft(source);
  assert.deepEqual(Object.keys(result), ['operationId', 'adultFictionalConfirmed', 'phoneUsedConfirmed', 'environment', 'scores', 'tags', 'note']);
  assert.equal(result.note, '今天语气有一点平。'); assert.equal(result.scores.continuity, 0);
  source.scores.overall = 1; source.tags.push('natural');
  assert.equal(result.scores.overall, 4); assert.deepEqual(result.tags, ['voice-flat']);
});

test('unexperienced items stay zero and do not require invented ratings, while an entirely untested report is rejected', () => {
  assert.doesNotThrow(() => preparePhoneExperienceDraft({ ...valid(), scores: { voiceClarity: 0, voiceFeeling: 0, replyNaturalness: 0, continuity: 0, overall: 1 }, tags: ['playback-failed'] }));
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), scores: { voiceClarity: 0, voiceFeeling: 0, replyNaturalness: 0, continuity: 0, overall: 0 } }), /至少/);
  for (const score of [-1, 6, 1.5, NaN]) assert.throws(() => preparePhoneExperienceDraft({ ...valid(), scores: { ...valid().scores, overall: score } }), /每项/);
});

test('reports require both adult-fictional and actual-phone confirmations plus a supported browser category', () => {
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), adultFictionalConfirmed: false }), /先确认/);
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), phoneUsedConfirmed: false }), /先确认/);
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), environment: 'desktop' }), /请选择/);
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), operationId: '<script>' }), /编号/);
});

test('too many, duplicate or unsupported tags and long descriptions are rejected', () => {
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), tags: ['natural', 'other', 'voice-delay', 'voice-flat', 'voice-unclear', 'playback-failed'] }), /最多/);
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), tags: ['natural', 'natural'] }), /最多/);
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), tags: ['secret-label'] }), /最多/);
  assert.throws(() => preparePhoneExperienceDraft({ ...valid(), note: '字'.repeat(501) }), /500/);
  for (const note of ['第一行\n第二行', '内容\u0000', '内容\u007f']) assert.throws(() => preparePhoneExperienceDraft({ ...valid(), note }), /控制字符/);
});

test('progress follows service-provided natural dates and never promotes three self-reports into acceptance', () => {
  const record = { ...preparePhoneExperienceDraft(valid()), id: 'row', day: '2026-10-02', createdAt: '2026-10-02T05:30:00Z', parentUsedPhoneConfirmed: true as const };
  const state: PhoneExperienceState = { startedAt: '2026-10-02T05:30:00Z', today: '2026-10-02', records: [record], completedDays: 1 };
  assert.deepEqual(phoneExperienceProgress(state), { completed: 1, todayRecorded: true, nextDay: 2, allDaysRecorded: false });
  assert.deepEqual(phoneExperienceProgress({ ...state, today: '2026-10-03' }), { completed: 1, todayRecorded: false, nextDay: 2, allDaysRecorded: false });
  assert.deepEqual(phoneExperienceProgress({ ...state, completedDays: 3 }), { completed: 3, todayRecorded: true, nextDay: 3, allDaysRecorded: true });
  assert.equal(Object.hasOwn(phoneExperienceProgress({ ...state, completedDays: 3 }), 'accepted'), false);
});

test('new phone observations need no rating and only copy volunteered bounded fields', () => {
  const source = { ...valid(), scores: { voiceClarity: 0, voiceFeeling: 0, replyNaturalness: 0, continuity: 0, overall: 0 }, tags: [], observation: { ...observation(), audio: 'excluded', conversation: 'excluded', userAgent: 'excluded' } };
  const result = preparePhoneExperienceDraft(source);
  assert.equal(result.observation!.intendedMeaning, '晚上十点回家。');
  assert.equal(result.scores.overall, 0);
  assert.deepEqual(Object.keys(result.observation!), ['result', 'stages', 'language', 'intendedMeaning', 'recognizedText', 'deviceModel', 'network']);
  source.observation.stages.push('reply'); assert.deepEqual(result.observation!.stages, ['recognition']);
  assert.doesNotThrow(() => preparePhoneExperienceDraft({ ...source, observation: { ...observation(), result: 'smooth', stages: [] } }));
  assert.doesNotThrow(() => preparePhoneExperienceDraft({ ...source, observation: { ...observation(), result: 'uncertain', stages: [], language: 'mixed' } }));
});

test('phone observation validates problem stages and all dialect, device and text fields before submission', () => {
  const source = { ...valid(), observation: observation() };
  for (const overrides of [
    { result: 'problem', stages: [] }, { result: 'smooth', stages: ['recognition'] }, { result: 'passed' },
    { stages: ['recognition', 'recognition'] }, { stages: ['recording', 'recognition', 'understanding', 'reply', 'voice'] }, { stages: ['unknown'] },
    { language: 'guessed-language' }, { network: 'ethernet' }, { intendedMeaning: '字'.repeat(201) }, { recognizedText: '行\n二' },
    { deviceModel: '字'.repeat(61) }, { deviceModel: '隐藏\u007f内容' },
  ]) assert.throws(() => preparePhoneExperienceDraft({ ...source, observation: { ...observation(), ...overrides } as PhoneExperienceObservation }));
});

test('phone authorization and child-scope failures revoke cached data, while transport and ordinary conflicts keep a recoverable draft', () => {
  for (const failure of [new ApiError('验证失效', 401), new ApiError('家长锁定', 403, 'PARENT_REQUIRED'), new ApiError('孩子切换', 409, 'CONTEXT_CHANGED'), new ApiError('资料移除', 404, 'PHONE_EXPERIENCE_SCOPE')]) {
    assert.equal(phoneExperienceScopeInvalid(failure), true);
  }
  for (const failure of [new ApiError('服务暂不可用', 503), new TypeError('断网'), new DOMException('超时', 'AbortError'),
    new ApiError('记录已删', 404, 'PHONE_EXPERIENCE_NOT_FOUND'), new ApiError('已记录今天', 409, 'PHONE_EXPERIENCE_DAY_RECORDED'),
    new ApiError('内容有变', 409, 'OPERATION_CONFLICT'), new ApiError('频率限制', 429), new Error('CONTEXT_CHANGED'), { status: 403 }]) {
    assert.equal(phoneExperienceScopeInvalid(failure), false);
  }
});
