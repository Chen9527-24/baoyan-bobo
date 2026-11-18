import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionSyncGate } from '../apps/web/src/lib/sessionSyncGate.ts';
import {
  applyMutationFailure, applyMutationResult, applyQueryResult, createOperation, expireOperation,
  isUnresolved, OPERATION_TTL_MS, recoverOperations, requireRecheck, serializeOperations,
  type TrackedOperation,
} from '../apps/web/src/lib/memoryOperations.ts';

const id = '17881f5f-7c4b-401c-928b-6c2b3f4e9411';
const otherId = '7045b3aa-df8a-4f38-814f-585919a73a0e';
const now = 1_800_000_000_000;
const uncertain = (action: 'save' | 'forget' = 'save'): TrackedOperation => applyMutationFailure(createOperation(id, action, now), 503);

test('durable recovery stores only an operation id, action and timestamp, never memory content', () => {
  const record = { ...uncertain(), content: '绝不能持久化的记忆正文', message: '回执可能含正文', candidateId: 'candidate-private' };
  const encoded = serializeOperations([record], now + 1000);
  assert.deepEqual(JSON.parse(encoded), [{ operationId: id, action: 'save', createdAt: now }]);
  assert.equal(encoded.includes('正文'), false);
  const restored = recoverOperations(encoded, now + 2000);
  assert.equal(restored[0]?.operationId, id);
  assert.equal(restored[0]?.phase, 'unconfirmed');
  assert.equal(Object.hasOwn(restored[0]!, 'content'), false);
});

test('restore discards malformed or forged metadata while keeping valid identifiers unchanged', () => {
  const raw = JSON.stringify([
    {operationId:id,action:'forget',createdAt:now,content:'not restored'},
    {operationId:id,action:'save',createdAt:now},
    {operationId:'not-an-operation',action:'save',createdAt:now},
    {operationId:otherId,action:'delete-everything',createdAt:now},
    {operationId:otherId,action:'save',createdAt:now+400_000},
  ]);
  const restored = recoverOperations(raw, now);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.action, 'forget');
  assert.deepEqual(recoverOperations('{bad json', now), []);
});

test('not_found remains unresolved and recoverable; it never means failed or safe to repeat', () => {
  const value = applyQueryResult(uncertain(), {operationId:id,status:'not_found',message:'没有查到'}, now + 1000);
  assert.equal(value.phase, 'unconfirmed');
  assert.equal(isUnresolved(value), true);
  assert.equal(JSON.parse(serializeOperations([value], now + 1000))[0].operationId, id);
  assert.match(value.message, /勿重复提交/);
});

test('a query can resolve saving or forgetting without returning any memory body', () => {
  const saved = applyQueryResult(uncertain(), {operationId:id,action:'save',status:'committed',effect:'saved',message:'已记住'}, now + 1000);
  const forgotten = applyQueryResult(uncertain('forget'), {operationId:id,action:'forget',status:'committed',effect:'forgotten',message:'只忘掉这一条'}, now + 1000);
  assert.equal(saved.phase, 'committed');
  assert.equal(forgotten.phase, 'committed');
  assert.equal(serializeOperations([saved,forgotten], now + 1000), '[]');
});

test('mismatched id, action or effect never fabricates a successful outcome', () => {
  for (const result of [
    {operationId:otherId,status:'committed' as const,effect:'saved' as const,message:'ok'},
    {operationId:id,action:'forget' as const,status:'committed' as const,message:'ok'},
    {operationId:id,status:'committed' as const,effect:'forgotten' as const,message:'ok'},
  ]) assert.equal(applyQueryResult(uncertain(), result, now + 1000).phase, 'unconfirmed');
});

test('a superseded result survives a late mutation success instead of reviving outdated state', () => {
  const superseded = applyQueryResult(uncertain(), {operationId:id,status:'superseded',message:'已有后续修改'}, now + 1000);
  assert.equal(superseded.phase, 'superseded');
  assert.equal(applyMutationResult(superseded, {saved:true,message:'旧的保存回执'}, now + 2000), superseded);
  assert.equal(serializeOperations([superseded], now + 2000), '[]');
});

test('late lookup failures cannot undo an already confirmed result', () => {
  const committed = applyMutationResult(uncertain(), {saved:true,message:'已确认'}, now + 1000);
  assert.equal(applyMutationFailure(committed, 503), committed);
  assert.equal(applyQueryResult(committed, {operationId:id,status:'not_found',message:'无'}, now + 2000), committed);
});

test('explicit 4xx is rejected, while network and 5xx retain the original query identifier', () => {
  const value = createOperation(id,'forget',now);
  assert.equal(applyMutationFailure(value, 409).phase, 'failed');
  assert.equal(serializeOperations([applyMutationFailure(value, 403)], now), '[]');
  for (const status of [undefined,500,503]) {
    const result = applyMutationFailure(value, status);
    assert.equal(result.phase, 'unconfirmed');
    assert.equal(result.operationId, id);
    assert.equal(result.action, 'forget');
  }
});

test('a malformed successful HTTP response is still unknown, not a claimed failure or success', () => {
  assert.equal(applyMutationResult(uncertain(), {}, now + 1000).phase, 'unconfirmed');
  assert.equal(applyMutationResult(uncertain(), {saved:false,message:'明确拒绝'}, now + 1000).phase, 'failed');
});

test('24-hour expiration stops recovery and ignores a late result without guessing the outcome', () => {
  const restored = recoverOperations(serializeOperations([uncertain()], now), now + OPERATION_TTL_MS);
  assert.equal(restored[0]?.phase, 'expired');
  assert.equal(isUnresolved(restored[0]!), false);
  assert.equal(serializeOperations(restored, now + OPERATION_TTL_MS), '[]');
  const expired = expireOperation(uncertain(), now + OPERATION_TTL_MS);
  assert.equal(applyQueryResult(expired,{operationId:id,status:'committed',message:'晚到成功'},now+OPERATION_TTL_MS),expired);
  assert.match(expired.message, /不推测/);
});


test('an invalidation before a late POST receipt requires a fresh lookup, never direct success', () => {
  const invalidated = requireRecheck(createOperation(id,'save',now), now + 1000);
  const lateReceipt = applyMutationResult(invalidated, {saved:true,message:'旧保存回执'}, now + 2000);
  assert.equal(lateReceipt.phase, 'unconfirmed');
  assert.equal(lateReceipt.needsVerification, true);
  const current = applyQueryResult(lateReceipt, {operationId:id,status:'superseded',message:'已被家长删除'}, now + 3000);
  assert.equal(current.phase, 'superseded');
});

test('a previously committed operation is rechecked when later memory changes invalidate its result', () => {
  const committed = applyMutationResult(uncertain(), {saved:true}, now + 1000);
  const recheck = requireRecheck(committed, now + 2000);
  assert.equal(recheck.phase, 'unconfirmed');
  assert.equal(JSON.parse(serializeOperations([recheck], now + 2000))[0].operationId, id);
  const verified = applyQueryResult(recheck, {operationId:id,status:'committed',effect:'saved',message:'仍有效'}, now + 3000);
  assert.equal(verified.phase, 'committed');
  assert.equal(verified.needsVerification, false);
});


test('call eligibility stays closed while event synchronization is disconnected, even if other APIs work', () => {
  const gate = new SessionSyncGate();
  const stream = gate.attach();
  assert.equal(gate.ready, false);
  assert.equal(gate.open(stream), true);
  assert.equal(gate.ready, true);
  gate.disconnect(stream);
  assert.equal(gate.ready, false);
  // Only the event channel reconnects the gate; an HTTP response cannot open it.
  assert.equal(gate.ready, false);
  gate.open(stream);
  assert.equal(gate.ready, true);
});

test('late events from a replaced stream cannot reopen the call gate or disconnect the new stream', () => {
  const gate = new SessionSyncGate();
  const previous = gate.attach();
  gate.open(previous);
  gate.detach(previous);
  assert.equal(gate.open(previous), false);
  assert.equal(gate.ready, false);
  const current = gate.attach();
  assert.equal(gate.open(previous), false);
  gate.open(current);
  assert.equal(gate.disconnect(previous), false);
  assert.equal(gate.ready, true);
});
