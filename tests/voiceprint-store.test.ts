import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createVoiceprintStore, type VoiceprintEnrollment } from '../apps/server/src/voiceprint-store.js';
import type { VoiceprintProvider } from '../apps/server/src/volc-voiceprint.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

function wav(seconds = 6, silent = false): Uint8Array {
  const value = Buffer.alloc(44 + seconds * 32000); value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4);
  value.write('WAVE', 8); value.write('fmt ', 12); value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22);
  value.writeUInt32LE(16000, 24); value.writeUInt32LE(32000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34);
  value.write('data', 36); value.writeUInt32LE(value.length - 44, 40);
  if (!silent) for (let i = 44; i < value.length; i += 2) value.writeInt16LE(i % 4 ? 1000 : -1000, i);
  return value;
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE families(id TEXT PRIMARY KEY);
    CREATE TABLE members(id TEXT PRIMARY KEY,family_id TEXT NOT NULL,name TEXT NOT NULL,relation TEXT NOT NULL,status TEXT NOT NULL,consent INTEGER NOT NULL);`);
  const familyId = randomUUID(), secondFamilyId = randomUUID(), memberId = randomUUID(), secondMemberId = randomUUID();
  db.prepare('INSERT INTO families VALUES(?)').run(familyId); db.prepare('INSERT INTO families VALUES(?)').run(secondFamilyId);
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?,1)').run(memberId, familyId, '虚构爸爸', '爸爸', 'not_enrolled');
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?,1)').run(secondMemberId, secondFamilyId, '虚构妈妈', '妈妈', 'not_enrolled');
  const registered: { speakerId: string; groupId: string; audioUrl: string; templateId: string }[] = [];
  const removed: string[] = []; let at = Date.parse('2026-09-30T00:00:00Z');
  const provider: VoiceprintProvider = {
    configured: true, audioOrigin: 'https://baoyan.fixture.testing',
    async createGroup() { return randomUUID(); },
    async register(input) { const templateId = randomUUID(); registered.push({ ...input, templateId }); return { templateId }; },
    async remove({ templateId }) { removed.push(templateId); return { supplierDeletion: 'soft_deleted' }; },
    async find({ speakerId, groupId }) { return registered.find(entry => entry.speakerId === speakerId && entry.groupId === groupId)?.templateId; },
  };
  const store = createVoiceprintStore({ db, now: () => at, provider });
  const input: VoiceprintEnrollment = { familyId, memberId, operationId: randomUUID(), audio: wav(), durationSeconds: 6,
    contentType: 'audio/wav', consent: true, participantConfirmed: true };
  return { db, store, provider, familyId, secondFamilyId, memberId, secondMemberId, registered, removed, input,
    advance(ms: number) { at += ms; }, close() { store.close(); db.close(); } };
}
const apiError = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
const payload = (speaker_id: string) => ({ result: { utterances: [{ text: '虚构声音', additions: { speaker_id } }] } });

test('registration exposes safe status, retains no raw audio in SQLite, and uses anonymous token', async () => {
  const f = fixture(); try {
    const status = await f.store.enroll(f.input);
    assert.equal(status.status, 'enrolled'); assert.equal(status.memberId, f.memberId); assert.equal(status.revision, 1);
    assert.equal(status.supplierDeletion, 'not_requested'); assert.equal(f.store.retentionDays, 90);
    assert.notEqual(f.registered[0].speakerId, f.memberId); assert.notEqual(f.registered[0].speakerId, f.familyId);
    assert.equal(JSON.stringify(status).includes(f.registered[0].templateId), false);
    const columns = f.db.prepare('PRAGMA table_info(voiceprint_templates)').all() as { name: string }[];
    assert.equal(columns.some(col => /audio|embedding/.test(col.name)), false);
    const url = new URL(f.registered[0].audioUrl);
    assert.equal(f.store.getAudio(url.pathname.split('/').at(-1)!, url.searchParams.get('expires')!, url.searchParams.get('signature')!), undefined);
  } finally { f.close(); }
});

test('active voiceprint recognizes only its family and returns no fabricated confidence', async () => {
  const f = fixture(); try {
    await f.store.enroll(f.input);
    const known = f.store.parseMatch(f.familyId, payload(f.registered[0].speakerId));
    assert.deepEqual(known, { memberId: f.memberId, name: '虚构爸爸', relation: '爸爸', revision: 1 });
    assert.equal(f.store.parseMatch(f.secondFamilyId, payload(f.registered[0].speakerId)), undefined);
    assert.equal(f.store.parseMatch(f.familyId, payload(randomUUID())), undefined);
    assert.equal(f.store.parseMatch(f.familyId, payload('0')), undefined);
    assert.equal(f.store.asrParameters(f.secondFamilyId), undefined);
    assert.equal(f.store.asrParameters(f.familyId)?.voiceprints.length, 1);
  } finally { f.close(); }
});

test('wrong family cannot register, disable or remove another family member', async () => {
  const f = fixture(); try {
    await assert.rejects(f.store.enroll({ ...f.input, familyId: f.secondFamilyId }), apiError('NOT_FOUND'));
    assert.throws(() => f.store.disable(f.secondFamilyId, f.memberId), apiError('NOT_FOUND'));
    assert.throws(() => f.store.remove(f.secondFamilyId, f.memberId), apiError('NOT_FOUND'));
    assert.equal(f.registered.length, 0);
  } finally { f.close(); }
});

test('independent participant consent is required, child registration binds selected child and guardian', async () => {
  const f = fixture(); try {
    await assert.rejects(f.store.enroll({ ...f.input, participantConfirmed: false } as any), apiError('VOICEPRINT_CONSENT_REQUIRED'));
    f.db.prepare("UPDATE members SET relation='孩子' WHERE id=?").run(f.memberId);
    await assert.rejects(f.store.enroll(f.input), apiError('VOICEPRINT_GUARDIAN_REQUIRED'));
    const childId = randomUUID();
    await f.store.enroll({ ...f.input, childId, guardianConsent: true });
    assert.equal(f.store.list(f.familyId)[0].childId, childId);
    assert.equal(f.store.parseMatch(f.familyId, payload(f.registered[0].speakerId))?.childId, childId);
    const receipt = f.db.prepare('SELECT version,participant_declared,guardian_declared FROM voiceprint_consents').get() as any;
    assert.equal(receipt.version, f.store.consentVersion); assert.equal(receipt.participant_declared, 1); assert.equal(receipt.guardian_declared, 1);
  } finally { f.close(); }
});

test('adult templates ignore the caller current child reference in storage, safe status and matching', async () => {
  const f = fixture(); try {
    const result = await f.store.enroll({ ...f.input, childId: randomUUID() });
    assert.equal(result.childId, undefined);
    assert.equal(f.db.prepare('SELECT child_id FROM voiceprint_templates WHERE member_id=?').get(f.memberId)!.child_id, null);
    assert.equal(f.store.list(f.familyId)[0].childId, undefined);
    assert.equal(f.store.parseMatch(f.familyId, payload(f.registered[0].speakerId))?.childId, undefined);
  } finally { f.close(); }
});

test('signed audio is accessible only while foreground registration remains authorized', async () => {
  const f = fixture(); try {
    let authorized = true; let fetchChecks = 0;
    f.provider.register = async input => {
      const url = new URL(input.audioUrl); const id = url.pathname.split('/').at(-1)!;
      const expires = url.searchParams.get('expires')!, signature = url.searchParams.get('signature')!;
      assert.deepEqual(f.store.getAudio(id, expires, signature)?.bytes, new Uint8Array(f.input.audio)); fetchChecks++;
      assert.equal(f.store.getAudio(id, expires, '0'.repeat(64)), undefined);
      assert.equal(f.store.getAudio(id, String(Number(expires) + 1), signature), undefined);
      authorized = false;
      assert.equal(f.store.getAudio(id, expires, signature), undefined);
      return { templateId: randomUUID() };
    };
    await assert.rejects(f.store.enroll({ ...f.input, assertAuthorized() { if (!authorized) throw new ApiError(403, '撤回'); } }), error => error instanceof ApiError);
    assert.equal(fetchChecks, 1); assert.equal(f.store.list(f.familyId).length, 0);
    assert.equal(Number((f.db.prepare('SELECT count(*) AS n FROM voiceprint_cleanup').get() as any).n), 1);
  } finally { f.close(); }
});

test('canonical audio duration and non-silence are checked on server without trusting supplied metadata', async () => {
  const f = fixture(); try {
    for (const override of [ { durationSeconds: 20 }, { audio: wav(4), durationSeconds: 4 },
      { contentType: 'audio/mpeg' }, { audio: wav(6, true) }, { audio: new Uint8Array(100) } ])
      await assert.rejects(f.store.enroll({ ...f.input, ...override }), error => error instanceof ApiError);
    assert.equal(f.registered.length, 0);
  } finally { f.close(); }
});

test('same completed enrollment is idempotent and changed payload conflicts without re-registering', async () => {
  const f = fixture(); try {
    const status = await f.store.enroll(f.input);
    assert.deepEqual(await f.store.enroll(f.input), status); assert.equal(f.registered.length, 1);
    const changed = wav(); changed[50]++;
    await assert.rejects(f.store.enroll({ ...f.input, audio: changed }), apiError('OPERATION_CONFLICT'));
  } finally { f.close(); }
});

test('replacement activates atomically, bumps revision and soft-deletes old reference only afterwards', async () => {
  const f = fixture(); try {
    await f.store.enroll(f.input); const old = f.registered[0];
    const replacement = await f.store.enroll({ ...f.input, operationId: randomUUID() });
    assert.equal(replacement.revision, 2);
    assert.equal(f.store.parseMatch(f.familyId, payload(old.speakerId)), undefined);
    assert.ok(f.store.parseMatch(f.familyId, payload(f.registered[1].speakerId)));
    assert.equal(f.removed.length, 0); assert.equal((await f.store.cleanup()).processed, 1);
    assert.deepEqual(f.removed, [old.templateId]);
  } finally { f.close(); }
});

test('disable and delete stop matching immediately; confirmed vendor deletion is explicitly soft', async () => {
  const f = fixture(); try {
    await f.store.enroll(f.input); const speakerId = f.registered[0].speakerId;
    assert.equal(f.store.disable(f.familyId, f.memberId)?.status, 'disabled');
    assert.equal(f.store.parseMatch(f.familyId, payload(speakerId)), undefined); assert.equal(f.store.asrParameters(f.familyId), undefined);
    assert.equal(f.store.remove(f.familyId, f.memberId)?.supplierDeletion, 'pending');
    await f.store.cleanup();
    assert.equal(f.store.list(f.familyId)[0].supplierDeletion, 'soft_deleted');
    assert.equal(f.store.list(f.familyId)[0].status, 'deleted');
    assert.ok((f.db.prepare('SELECT revoked_at FROM voiceprint_consents').get() as any).revoked_at);
  } finally { f.close(); }
});

test('expired template is excluded and queued for cleanup without extending original validity', async () => {
  const f = fixture(); try {
    const status = await f.store.enroll(f.input); f.advance(91 * 86_400_000);
    assert.equal(f.store.parseMatch(f.familyId, payload(f.registered[0].speakerId)), undefined);
    const expired = f.store.list(f.familyId)[0]; assert.equal(expired.status, 'expired'); assert.equal(expired.expiresAt, status.expiresAt);
    assert.equal(expired.supplierDeletion, 'pending'); await f.store.cleanup(); assert.equal(f.removed.length, 1);
  } finally { f.close(); }
});

test('cancel returns promptly and late supplier receipt never activates; cleanup obligation is durable', async () => {
  const f = fixture(); try {
    let entered!: () => void, release!: (value: { templateId: string }) => void;
    const began = new Promise<void>(resolve => { entered = resolve; }); const controller = new AbortController();
    const lateId = randomUUID();
    f.provider.register = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const registration = f.store.enroll({ ...f.input, signal: controller.signal }); await began;
    controller.abort(); await assert.rejects(registration, apiError('REQUEST_ABORTED'));
    assert.equal(f.store.list(f.familyId).length, 0);
    release({ templateId: lateId }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.list(f.familyId).length, 0);
    const job = f.db.prepare('SELECT template_id,state FROM voiceprint_cleanup').get() as any;
    assert.equal(job.template_id, lateId); assert.equal(job.state, 'pending');
    await f.store.cleanup(); assert.deepEqual(f.removed, [lateId]);
  } finally { f.close(); }
});

test('member revision/consent change before supplier completion prevents activation', async () => {
  const f = fixture(); try {
    f.provider.register = async () => {
      f.db.prepare("UPDATE members SET name='已改名' WHERE id=?").run(f.memberId);
      return { templateId: randomUUID() };
    };
    await assert.rejects(f.store.enroll(f.input), apiError('VOICEPRINT_CONTEXT_CHANGED'));
    assert.equal(f.store.list(f.familyId).length, 0);
  } finally { f.close(); }
});

test('family withdrawal preserves cleanup jobs after family/member rows are removed', async () => {
  const f = fixture(); try {
    await f.store.enroll(f.input); const templateId = f.registered[0].templateId;
    f.store.removeFamily(f.familyId);
    f.db.prepare('DELETE FROM members WHERE family_id=?').run(f.familyId); f.db.prepare('DELETE FROM families WHERE id=?').run(f.familyId);
    await f.store.cleanup(); assert.deepEqual(f.removed, [templateId]);
    assert.equal(f.store.parseMatch(f.familyId, payload(f.registered[0].speakerId)), undefined);
    assert.equal(f.store.asrParameters(f.familyId), undefined);
  } finally { f.close(); }
});

test('absent late template and provider failure remain cleanup-pending, never physical-deletion success', async () => {
  const f = fixture(); try {
    await f.store.enroll(f.input); f.store.remove(f.familyId, f.memberId);
    f.provider.remove = async () => { throw new Error('synthetic upstream failure'); };
    assert.deepEqual(await f.store.cleanup(), { processed: 0, pending: 1 });
    assert.equal(f.store.list(f.familyId)[0].supplierDeletion, 'pending');
    assert.equal((await f.store.cleanup()).processed, 0);
  } finally { f.close(); }
});

test('unconfigured account never uploads and rejects explicit enrollment', async () => {
  const f = fixture(); let store: ReturnType<typeof createVoiceprintStore> | undefined;
  try {
    f.provider.configured = false;
    store = createVoiceprintStore({ db: f.db, now: Date.now, provider: f.provider });
    await assert.rejects(store.enroll(f.input), apiError('VOICEPRINT_NOT_CONFIGURED'));
    assert.equal(f.registered.length, 0); assert.equal(store.asrParameters(f.familyId), undefined);
  } finally { store?.close(); f.close(); }
});

test('restart cancels unfinished task and recovers its family-scoped cleanup job', async () => {
  const f = fixture(); let restarted: ReturnType<typeof createVoiceprintStore> | undefined;
  try {
    const groupId = randomUUID(), speakerId = randomUUID();
    f.db.prepare("INSERT INTO voiceprint_enrollments VALUES(?,?,?,?,?,?,'pending',?)").run(f.familyId, f.memberId, randomUUID(), 'synthetic-hash', speakerId, groupId, Date.now() + 60_000);
    restarted = createVoiceprintStore({ db: f.db, provider: f.provider });
    assert.equal((f.db.prepare('SELECT state FROM voiceprint_enrollments').get() as any).state, 'cancelled');
    assert.equal((f.db.prepare('SELECT state FROM voiceprint_cleanup').get() as any).state, 'pending');
    assert.deepEqual(await restarted.cleanup(), { processed: 0, pending: 1 });
  } finally { restarted?.close(); f.close(); }
});

test('service shutdown prevents late activation and invalidates signed audio before database close', async () => {
  const f = fixture();
  try {
    let entered!: () => void, release!: (value: { templateId: string }) => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    f.provider.register = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const registration = f.store.enroll(f.input); await began;
    f.store.close(); await assert.rejects(registration, apiError('SERVICE_STOPPED'));
    f.db.close(); release({ templateId: randomUUID() });
    await new Promise(resolve => setImmediate(resolve));
  } catch (failure) { try { f.close(); } catch { /* already closed */ } throw failure; }
});

test('unresolved cleanup limit stops new registrations before supplier group capacity is exhausted', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 30; i++) f.db.prepare("INSERT INTO voiceprint_cleanup VALUES(?,?,?,?,?,NULL,'pending',0,?,?)").run(
      randomUUID(), f.familyId, f.memberId, randomUUID(), randomUUID(), Date.now(), Date.now());
    await assert.rejects(f.store.enroll(f.input), apiError('VOICEPRINT_CLEANUP_PENDING'));
    assert.equal(f.registered.length, 0);
  } finally { f.close(); }
});
