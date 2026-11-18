import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainTrialTimes, trialHasEnded, trialSetupError, trialTimeOptions } from '../apps/web/src/lib/trial.ts';
import type { Trial } from '../apps/web/src/lib/types.ts';

const now = Date.parse('2026-09-29T01:00:00Z');
const trial: Trial = { enabled: true, requiresInvite: true, expiresAt: '2026-09-30T01:00:00Z', maxSessionMinutes: 10, maxDailyMinutes: 20 };

test('servers without trial retain original setup values and choices', () => {
  assert.equal(trialHasEnded(undefined, now), false);
  assert.equal(trialSetupError(undefined, '', now), undefined);
  assert.deepEqual(constrainTrialTimes(15, 45), { session: 15, daily: 45 });
  assert.deepEqual(trialTimeOptions().sessionOptions, [5, 10, 15, 20]);
  assert.deepEqual(trialTimeOptions().dailyOptions, [10, 20, 30, 45, 60]);
});
test('invitation is required only when the server says so', () => {
  assert.match(trialSetupError(trial, '  ', now)!, /邀请码.*家长 PIN/);
  assert.equal(trialSetupError(trial, ' Friend-Invite ', now), undefined);
  assert.equal(trialSetupError({ ...trial, requiresInvite: false }, '', now), undefined);
});
test('deadline blocks the exact instant of expiry and stale final-step submissions', () => {
  const deadline = Date.parse(trial.expiresAt);
  assert.equal(trialHasEnded(trial, deadline - 1), false);
  assert.equal(trialHasEnded(trial, deadline), true);
  assert.match(trialSetupError(trial, 'valid-invite', deadline)!, /已结束/);
});
test('an invalid trial deadline cannot silently permit setup', () => {
  assert.equal(trialHasEnded({ ...trial, expiresAt: 'invalid' }, now), true);
  assert.match(trialSetupError({ ...trial, expiresAt: 'invalid' }, 'valid-invite', now)!, /不能完成设置/);
});
test('trial choices never exceed either server ceiling', () => {
  const limits = trialTimeOptions({ ...trial, maxSessionMinutes: 12, maxDailyMinutes: 17 });
  assert.deepEqual(limits.sessionOptions, [5, 10, 12]);
  assert.deepEqual(limits.dailyOptions, [10, 17]);
  assert.deepEqual(constrainTrialTimes(20, 60, { ...trial, maxSessionMinutes: 12, maxDailyMinutes: 17 }), { session: 12, daily: 17 });
});
test('caps smaller than the original minimum still provide valid choices', () => {
  const small = { ...trial, maxSessionMinutes: 2, maxDailyMinutes: 3 };
  assert.deepEqual(trialTimeOptions(small).sessionOptions, [2]);
  assert.deepEqual(trialTimeOptions(small).dailyOptions, [3]);
  assert.deepEqual(constrainTrialTimes(10, 20, small), { session: 2, daily: 3 });
});
test('daily quota smaller than session cap also bounds the session selection', () => {
  const limits = { ...trial, maxSessionMinutes: 15, maxDailyMinutes: 7 };
  assert.deepEqual(trialTimeOptions(limits).sessionOptions, [5, 7]);
  assert.deepEqual(constrainTrialTimes(10, 20, limits), { session: 7, daily: 7 });
});
test('changing the session cannot leave the selected daily quota below it', () => {
  assert.deepEqual(constrainTrialTimes(10, 5, trial), { session: 10, daily: 10 });
});
test('existing in-range nonstandard parent values remain visible as choices', () => {
  const limits = trialTimeOptions(trial, { session: 7, daily: 13 });
  assert.deepEqual(limits.sessionOptions, [5, 7, 10]);
  assert.deepEqual(limits.dailyOptions, [10, 13, 20]);
});
test('invalid ceilings fail closed instead of offering out-of-range values', () => {
  for (const value of [0, -1, 1.5, Number.NaN]) {
    const invalid = { ...trial, maxSessionMinutes: value };
    assert.equal(trialTimeOptions(invalid).valid, false);
    assert.deepEqual(constrainTrialTimes(10, 20, invalid), { session: 0, daily: 0 });
    assert.match(trialSetupError(invalid, 'valid-invite', now)!, /时限暂时无法确认/);
  }
});
