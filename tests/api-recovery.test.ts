import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, isConfiguredBootstrap, recoverSetupState, responseApiError } from '../apps/web/src/lib/api.ts';
import type { Bootstrap } from '../apps/web/src/lib/types.ts';

const bootstrap: Bootstrap = {
  configured: true, parentAuthorized: false, mode: 'demo', capabilities: { chat: false, asr: false, tts: false, voiceprint: false },
  child: { id: 'test-child', nickname: '小云朵', ageGroup: '6-8', outfit: 'mint', showCaptions: true, memoryEnabled: false, voiceEnabled: false, sessionMinutes: 10, dailyMinutes: 20 },
  memoryCount: 0, memberCount: 0, globalMemories: [], remainingDailySeconds: 1200,
};
const unconfigured: Bootstrap = { ...bootstrap, configured: false, child: null };

test('a lost setup response recovers the existing household with the original authorization state', async () => {
  for (const parentAuthorized of [false, true]) {
    const current = { ...bootstrap, parentAuthorized };
    let reads = 0;
    const result = await recoverSetupState(new TypeError('Failed to fetch'), async () => { reads++; return current; });
    assert.equal(reads, 1);
    assert.equal(result.data, current);
    assert.equal(result.data?.parentAuthorized, parentAuthorized);
    assert.equal(result.error, '');
  }
});

test('default setup recovery performs one bootstrap GET and never resubmits the invitation', async () => {
  const originalFetch = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: { url: string; method: string; body: BodyInit | null | undefined }[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } });
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body }); return Response.json(bootstrap); };
  try {
    const result = await recoverSetupState(new ApiError('本设备已完成设置', 409, 'ALREADY_CONFIGURED'));
    assert.equal(result.data?.configured, true);
    assert.deepEqual(calls, [{ url: '/api/bootstrap', method: 'GET', body: undefined }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('an unconfigured household preserves an explicit invitation rejection', async () => {
  const error = new ApiError('请输入有效且尚未使用的内测邀请码。', 403, 'TRIAL_INVITE_REQUIRED');
  const result = await recoverSetupState(error, async () => unconfigured);
  assert.equal(result.data, null);
  assert.equal(result.error, error.message);
});

test('a failed bootstrap read does not replace the original definite rejection', async () => {
  const error = new ApiError('本轮内测名额已满。', 403, 'TRIAL_FAMILY_LIMIT');
  const result = await recoverSetupState(error, async () => { throw new TypeError('network'); });
  assert.equal(result.error, error.message);
  assert.equal(result.data, null);
});

test('uncertain setup failures direct the user to refresh or contact the inviter, never claim failure', async () => {
  for (const error of [new TypeError('network'), new DOMException('timeout', 'AbortError'), new ApiError('server error', 500)]) {
    const result = await recoverSetupState(error, async () => unconfigured);
    assert.equal(result.data, null);
    assert.match(result.error, /结果暂时无法确认/);
    assert.match(result.error, /刷新.*联系分享人.*不要反复提交/);
    assert.doesNotMatch(result.error, /设置失败|操作未完成/);
  }
});

test('failed recovery reads keep network outcomes unconfirmed', async () => {
  const result = await recoverSetupState(new TypeError('network'), async () => { throw new Error('read also failed'); });
  assert.equal(result.data, null);
  assert.match(result.error, /结果暂时无法确认/);
});

test('malformed successful payloads cannot be mistaken for a configured household', async () => {
  for (const value of [{}, { ...bootstrap, child: null }, { ...bootstrap, parentAuthorized: undefined }]) {
    assert.equal(isConfiguredBootstrap(value as Bootstrap), false);
    const result = await recoverSetupState(new ApiError('设置结果尚未确认', 502), async () => value as Bootstrap);
    assert.equal(result.data, null);
    assert.match(result.error, /无法确认/);
  }
});

test('speech errors retain quota, busy and expiry messages with their HTTP status and code', async () => {
  for (const [status, code, message] of [
    [429, 'TRIAL_DAILY_LIMIT', '今天的全站体验调用额度已用完，请明天再来。'],
    [429, 'TRIAL_BUSY', '当前体验人数较多，请稍后再试。'],
    [410, 'TRIAL_EXPIRED', '本轮内测已结束，仍可在家长管理中导出或删除资料。'],
  ] as const) {
    const error = await responseApiError(Response.json({ error: message, code }, { status }), '声音暂时不可用');
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
  }
});

test('non-JSON and unsafe error payloads fall back without exposing arbitrary content', async () => {
  const responses = [new Response('<html>proxy error</html>', { status: 502 }), ...[
    null, [], { error: { details: 'internal' } }, { error: 'x'.repeat(301) }, { error: 'bad\u0000value' },
  ].map(body => Response.json(body, { status: 502 }))];
  for (const response of responses) {
    const error = await responseApiError(response, '声音暂时不可用');
    assert.equal(error.message, '声音暂时不可用');
    assert.equal(error.status, 502);
    assert.equal(error.code, undefined);
  }
});

test('an invalid error code is ignored while retaining a safe explanatory message', async () => {
  const error = await responseApiError(Response.json({ error: '请稍后再试。', code: { nested: true } }, { status: 429 }), 'fallback');
  assert.equal(error.message, '请稍后再试。');
  assert.equal(error.code, undefined);
});
