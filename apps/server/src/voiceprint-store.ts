import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './provider-errors.js';
import { parseVoiceprintSpeaker, voiceprintAsrParameters, voiceprintAudioOrigin, type VoiceprintProvider } from './volc-voiceprint.js';

const DAY = 86_400_000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const VOICEPRINT_CONSENT_VERSION = 'voiceprint-consent-1';
export const VOICEPRINT_RETENTION_DAYS = 90;
const AUDIO_TTL = 120_000;
const ENROLLMENT_TTL = 60_000;
const MAX_AUDIO_BYTES = 960_044;
type MemberRow = { id: string; family_id: string; name: string; relation: string; status: string; consent: number };
type TemplateRow = { family_id: string; member_id: string; child_id: string | null; speaker_id: string; group_id: string;
  template_id: string; status: string; revision: number; created_at: number; expires_at: number };
type OperationRow = { family_id: string; member_id: string; operation_id: string; input_hash: string; speaker_id: string;
  group_id: string | null; state: string; expires_at: number };
type JobRow = { id: string; family_id: string; member_id: string; speaker_id: string; group_id: string; template_id: string | null;
  state: string; attempts: number; next_attempt: number; created_at: number };
type Audio = { familyId: string; memberId: string; operationId: string; bytes: Uint8Array; contentType: string; expiresAt: number };
type Pending = { familyId: string; memberId: string; operationId: string; speakerId: string; groupId?: string;
  controller: AbortController; audioId?: string; assertAuthorized?: () => void };
export type VoiceprintStatus = { memberId: string; childId?: string; status: 'enrolled' | 'disabled' | 'expired' | 'deleted';
  revision: number; expiresAt: string; supplierDeletion: 'not_requested' | 'pending' | 'soft_deleted' };
export type VoiceprintMatch = { memberId: string; childId?: string; name: string; relation: string; revision: number };
export type VoiceprintEnrollment = { familyId: string; memberId: string; childId?: string; operationId: string;
  audio: Uint8Array; contentType: string; durationSeconds: number; consent: true; participantConfirmed: true;
  guardianConsent?: true; signal?: AbortSignal; assertAuthorized?: () => void };

const error = (status: number, message: string, code: string) => new ApiError(status, message, code);

/** SQLite contains references and lifecycle receipts; enrollment audio is only short-lived memory. */
export function createVoiceprintStore(options: { db: DatabaseSync; now?: () => number; provider: VoiceprintProvider;
  audioOrigin?: string; signingSecret?: string; retentionMs?: number }) {
  const { db, provider } = options;
  const now = options.now ?? Date.now;
  const audioOrigin = voiceprintAudioOrigin(options.audioOrigin ?? provider.audioOrigin);
  // A process-local key is safe: restart intentionally invalidates all enrollment audio URLs.
  const signingSecret = options.signingSecret ?? randomBytes(32).toString('hex');
  const retentionMs = options.retentionMs ?? VOICEPRINT_RETENTION_DAYS * DAY;
  if (retentionMs < DAY || retentionMs > 365 * DAY || !Number.isSafeInteger(retentionMs)) throw new Error('声纹有效期必须为1至365天。');
  if (signingSecret.length < 32) throw new Error('声音登记签名配置无效。');
  const configured = provider.configured && !!audioOrigin;
  const pending = new Map<string, Pending>();
  const audio = new Map<string, Audio>();
  let closed = false;
  let cleaning = false;
  let cleanupController: AbortController | undefined;
  db.exec(`CREATE TABLE IF NOT EXISTS voiceprint_groups(family_id TEXT PRIMARY KEY,group_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS voiceprint_templates(family_id TEXT NOT NULL,member_id TEXT NOT NULL,child_id TEXT,
      speaker_id TEXT NOT NULL UNIQUE,group_id TEXT NOT NULL,template_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,
      revision INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      PRIMARY KEY(family_id,member_id));
    CREATE TABLE IF NOT EXISTS voiceprint_enrollments(family_id TEXT NOT NULL,member_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,input_hash TEXT NOT NULL,speaker_id TEXT NOT NULL,group_id TEXT,
      state TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(family_id,operation_id));
    CREATE TABLE IF NOT EXISTS voiceprint_cleanup(id TEXT PRIMARY KEY,family_id TEXT NOT NULL,member_id TEXT NOT NULL,
      speaker_id TEXT NOT NULL,group_id TEXT NOT NULL,template_id TEXT,state TEXT NOT NULL,attempts INTEGER NOT NULL,
      next_attempt INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(speaker_id));
    CREATE TABLE IF NOT EXISTS voiceprint_consents(family_id TEXT NOT NULL,member_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      version TEXT NOT NULL,participant_declared INTEGER NOT NULL,guardian_declared INTEGER NOT NULL,
      agreed_at INTEGER NOT NULL,revoked_at INTEGER,PRIMARY KEY(family_id,operation_id));`);

  function assertRunning() { if (closed) throw error(503, '服务已经停止，请重新连接', 'SERVICE_STOPPED'); }
  function member(familyId: string, memberId: string): MemberRow {
    const row = db.prepare('SELECT * FROM members WHERE id=? AND family_id=?').get(memberId, familyId) as MemberRow | undefined;
    if (!row) throw error(404, '成员不存在', 'NOT_FOUND');
    return row;
  }
  function row(familyId: string, memberId: string): TemplateRow | undefined {
    return db.prepare('SELECT * FROM voiceprint_templates WHERE family_id=? AND member_id=?').get(familyId, memberId) as TemplateRow | undefined;
  }
  function queue(familyId: string, memberId: string, speakerId: string, groupId: string, templateId?: string) {
    db.prepare(`INSERT INTO voiceprint_cleanup VALUES(?,?,?,?,?,?,'pending',0,?,?)
      ON CONFLICT(speaker_id) DO UPDATE SET template_id=COALESCE(excluded.template_id,voiceprint_cleanup.template_id),
      state=CASE WHEN excluded.template_id IS NOT NULL AND voiceprint_cleanup.template_id IS NULL THEN 'pending' ELSE voiceprint_cleanup.state END`).run(
      randomUUID(), familyId, memberId, speakerId, groupId, templateId ?? null, now(), now());
  }
  function signature(id: string, expiresAt: number): string {
    return createHmac('sha256', signingSecret).update(`${id}:${expiresAt}`).digest('hex');
  }
  function publicStatus(entry: TemplateRow): VoiceprintStatus {
    const job = db.prepare('SELECT state FROM voiceprint_cleanup WHERE speaker_id=?').get(entry.speaker_id) as { state: string } | undefined;
    return { memberId: entry.member_id, ...(entry.child_id ? { childId: entry.child_id } : {}),
      status: entry.status as VoiceprintStatus['status'], revision: entry.revision,
      expiresAt: new Date(entry.expires_at).toISOString(),
      supplierDeletion: job?.state === 'soft_deleted' ? 'soft_deleted' : job ? 'pending' : 'not_requested' };
  }
  function abort(entry: Pending, reason = error(499, '这次声音登记已经取消', 'REQUEST_ABORTED')) {
    entry.controller.abort(reason);
    if (entry.audioId) audio.delete(entry.audioId);
    if (entry.groupId) queue(entry.familyId, entry.memberId, entry.speakerId, entry.groupId);
    db.prepare("UPDATE voiceprint_enrollments SET state='cancelled' WHERE family_id=? AND operation_id=? AND state='pending'").run(entry.familyId, entry.operationId);
  }
  // A previous process cannot resume an upload. Recover only its cleanup obligation.
  for (const op of db.prepare("SELECT * FROM voiceprint_enrollments WHERE state='pending'").all() as OperationRow[]) {
    if (op.group_id) queue(op.family_id, op.member_id, op.speaker_id, op.group_id);
    db.prepare("UPDATE voiceprint_enrollments SET state='cancelled' WHERE family_id=? AND operation_id=?").run(op.family_id, op.operation_id);
  }

  function sweep() {
    if (closed) return;
    for (const [id, clip] of audio) if (clip.expiresAt <= now()) audio.delete(id);
    for (const op of pending.values()) {
      let reason: ApiError | undefined;
      const receipt = db.prepare('SELECT expires_at FROM voiceprint_enrollments WHERE family_id=? AND operation_id=?').get(op.familyId, op.operationId) as { expires_at: number } | undefined;
      if (!receipt || receipt.expires_at <= now()) reason = error(410, '这次声音登记已过期', 'VOICEPRINT_EXPIRED');
      try { op.assertAuthorized?.(); } catch { reason = error(403, '请重新输入家长 PIN', 'PARENT_REQUIRED'); }
      if (!reason) {
        const current = db.prepare('SELECT consent,status FROM members WHERE id=? AND family_id=?').get(op.memberId, op.familyId) as MemberRow | undefined;
        if (!current || !current.consent || current.status === 'disabled') reason = error(409, '成员状态已改变，请重新登记', 'VOICEPRINT_CONTEXT_CHANGED');
      }
      if (reason && !op.controller.signal.aborted) abort(op, reason);
    }
    for (const template of db.prepare("SELECT * FROM voiceprint_templates WHERE status='enrolled'").all() as TemplateRow[]) {
      const current = db.prepare('SELECT consent,status FROM members WHERE id=? AND family_id=?').get(template.member_id, template.family_id) as MemberRow | undefined;
      const expired = template.expires_at <= now();
      if (expired || !current || !current.consent || current.status === 'disabled') {
        db.prepare('UPDATE voiceprint_templates SET status=?,revision=revision+1 WHERE family_id=? AND member_id=?').run(expired ? 'expired' : 'disabled', template.family_id, template.member_id);
        db.prepare('UPDATE voiceprint_consents SET revoked_at=? WHERE family_id=? AND member_id=? AND revoked_at IS NULL').run(now(), template.family_id, template.member_id);
        queue(template.family_id, template.member_id, template.speaker_id, template.group_id, template.template_id);
      }
    }
    db.prepare("DELETE FROM voiceprint_enrollments WHERE state!='pending' AND expires_at<=?").run(now() - DAY);
    db.prepare("DELETE FROM voiceprint_cleanup WHERE state='soft_deleted' AND created_at<=?").run(now() - 30 * DAY);
    db.prepare('DELETE FROM voiceprint_consents WHERE revoked_at IS NOT NULL AND revoked_at<=?').run(now() - 30 * DAY);
  }

  function validateAudio(bytes: Uint8Array, contentType: string, seconds: number) {
    if (!(bytes instanceof Uint8Array) || contentType !== 'audio/wav' || bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES)
      throw error(400, '请录制5至30秒单人声音', 'VOICEPRINT_AUDIO_INVALID');
    const wav = Buffer.from(bytes);
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
      || wav.readUInt32LE(4) !== wav.length - 8 || wav.toString('ascii', 12, 16) !== 'fmt '
      || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1
      || wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000
      || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data'
      || wav.readUInt32LE(40) !== wav.length - 44 || (wav.length - 44) % 2)
      throw error(400, '登记声音格式无效，请重新录制', 'VOICEPRINT_AUDIO_INVALID');
    const actual = (wav.length - 44) / 32000;
    if (!Number.isFinite(seconds) || actual < 5 || actual > 30 || Math.abs(actual - seconds) > 0.1)
      throw error(400, '请录制5至30秒单人声音', 'VOICEPRINT_AUDIO_INVALID');
    // This only rejects silence; it is not a speaker count, noise or liveness check.
    let energy = 0; for (let i = 44; i < wav.length; i += 2) energy += Math.abs(wav.readInt16LE(i));
    if (energy / ((wav.length - 44) / 2) < 5) throw error(422, '登记声音太轻，请靠近麦克风重新录制', 'VOICEPRINT_AUDIO_QUIET');
  }

  function waitActive<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(signal.reason instanceof ApiError ? signal.reason : error(499, '这次声音登记已经取消', 'REQUEST_ABORTED'));
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      task.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  async function enroll(input: VoiceprintEnrollment): Promise<VoiceprintStatus> {
    assertRunning(); sweep();
    if (!configured) throw error(503, '真实识人服务尚未配置或开通，普通聊天仍可使用', 'VOICEPRINT_NOT_CONFIGURED');
    const who = member(input.familyId, input.memberId);
    if (who.status === 'disabled' || !who.consent || input.consent !== true || input.participantConfirmed !== true)
      throw error(400, '需要登记本人主动参与并单独同意', 'VOICEPRINT_CONSENT_REQUIRED');
    if (who.relation === '孩子' && (!input.guardianConsent || !input.childId || !UUID.test(input.childId)))
      throw error(400, '儿童声音登记需要监护同意及明确孩子资料', 'VOICEPRINT_GUARDIAN_REQUIRED');
    if (!UUID.test(input.operationId) || (input.childId !== undefined && !UUID.test(input.childId))) throw error(400, '登记参数无效', 'INVALID_INPUT');
    validateAudio(input.audio, input.contentType, input.durationSeconds);
    input.assertAuthorized?.();
    if (input.signal?.aborted) throw error(499, '这次声音登记已经取消', 'REQUEST_ABORTED');
    const inputHash = createHash('sha256').update(input.audio).update(JSON.stringify([input.memberId, input.childId ?? null, VOICEPRINT_CONSENT_VERSION])).digest('hex');
    const previous = db.prepare('SELECT * FROM voiceprint_enrollments WHERE family_id=? AND operation_id=?').get(input.familyId, input.operationId) as OperationRow | undefined;
    if (previous) {
      if (previous.input_hash !== inputHash) throw error(409, '操作标识已用于其他登记', 'OPERATION_CONFLICT');
      const template = row(input.familyId, input.memberId);
      if (previous.state === 'active' && template?.speaker_id === previous.speaker_id && template.status === 'enrolled') return publicStatus(template);
      throw error(409, previous.state === 'pending' ? '这位家人的声音正在登记' : '此登记已结束，请重新录制', 'VOICEPRINT_OPERATION_ENDED');
    }
    if ([...pending.values()].some(op => op.familyId === input.familyId)) throw error(409, '本家庭有声音正在登记，请先完成或取消', 'VOICEPRINT_BUSY');
    if (pending.size >= 20 || audio.size >= 20) throw error(429, '声音登记服务正忙，请稍后再试', 'VOICEPRINT_BUSY');
    const familyPending = Number((db.prepare("SELECT count(*) AS n FROM voiceprint_cleanup WHERE family_id=? AND state='pending'").get(input.familyId) as any).n);
    const globalPending = Number((db.prepare("SELECT count(*) AS n FROM voiceprint_cleanup WHERE state='pending'").get() as any).n);
    // A group allows 50 vendor references. Leave headroom for current members and
    // refuse new creation while previous cancelled/replaced references accumulate.
    if (familyPending >= 30 || globalPending >= 1000) throw error(429, '先前声音仍在清理，请稍后再登记', 'VOICEPRINT_CLEANUP_PENDING');
    const op: Pending = { familyId: input.familyId, memberId: input.memberId, operationId: input.operationId,
      speakerId: randomUUID(), controller: new AbortController(), assertAuthorized: input.assertAuthorized };
    const key = `${input.familyId}:${input.operationId}`;
    pending.set(key, op);
    db.prepare("INSERT INTO voiceprint_enrollments VALUES(?,?,?,?,?,NULL,'pending',?)").run(input.familyId, input.memberId, input.operationId, inputHash, op.speakerId, now() + ENROLLMENT_TTL);
    const cancel = () => abort(op);
    input.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort(op, error(504, '声音登记超时，已停止激活并等待清理结果', 'VOICEPRINT_TIMEOUT')), ENROLLMENT_TTL);
    let templateId: string | undefined;
    try {
      const group = db.prepare('SELECT group_id FROM voiceprint_groups WHERE family_id=?').get(input.familyId) as { group_id: string } | undefined;
      op.groupId = group?.group_id ?? await waitActive(provider.createGroup({ groupName: randomUUID(), signal: op.controller.signal }), op.controller.signal);
      if (op.controller.signal.aborted) throw op.controller.signal.reason;
      if (!group) db.prepare('INSERT INTO voiceprint_groups VALUES(?,?)').run(input.familyId, op.groupId);
      db.prepare('UPDATE voiceprint_enrollments SET group_id=? WHERE family_id=? AND operation_id=?').run(op.groupId, input.familyId, input.operationId);
      const clipId = randomUUID(); op.audioId = clipId;
      const expiresAt = now() + AUDIO_TTL;
      audio.set(clipId, { familyId: input.familyId, memberId: input.memberId, operationId: input.operationId,
        bytes: new Uint8Array(input.audio), contentType: input.contentType, expiresAt });
      const url = `${audioOrigin}/api/voiceprint/audio/${clipId}?expires=${expiresAt}&signature=${signature(clipId, expiresAt)}`;
      const registration = provider.register({ speakerId: op.speakerId, audioUrl: url, groupId: op.groupId, signal: op.controller.signal,
        onLateRegistration: late => { if (!closed) queue(input.familyId, input.memberId, op.speakerId, op.groupId!, late.templateId); } }).then(result => {
          if (op.controller.signal.aborted && !closed) queue(input.familyId, input.memberId, op.speakerId, op.groupId!, result.templateId);
          return result;
        });
      const result = await waitActive(registration, op.controller.signal);
      templateId = result.templateId;
      if (op.controller.signal.aborted || closed) throw error(499, '这次声音登记已经取消', 'REQUEST_ABORTED');
      input.assertAuthorized?.();
      const current = member(input.familyId, input.memberId);
      const receipt = db.prepare('SELECT state,expires_at FROM voiceprint_enrollments WHERE family_id=? AND operation_id=?').get(input.familyId, input.operationId) as OperationRow;
      if (!current.consent || current.status === 'disabled' || current.name !== who.name || current.relation !== who.relation
        || receipt.state !== 'pending' || receipt.expires_at <= now()) throw error(409, '成员或登记状态已改变，未激活这次声音', 'VOICEPRINT_CONTEXT_CHANGED');
      const previousTemplate = row(input.familyId, input.memberId);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO voiceprint_templates VALUES(?,?,?,?,?,?,'enrolled',?,?,?)
          ON CONFLICT(family_id,member_id) DO UPDATE SET child_id=excluded.child_id,speaker_id=excluded.speaker_id,
          group_id=excluded.group_id,template_id=excluded.template_id,status='enrolled',revision=excluded.revision,
          created_at=excluded.created_at,expires_at=excluded.expires_at`).run(input.familyId, input.memberId, who.relation === '孩子' ? input.childId ?? null : null,
          op.speakerId, op.groupId, templateId, (previousTemplate?.revision ?? 0) + 1, now(), now() + retentionMs);
        if (previousTemplate) queue(input.familyId, input.memberId, previousTemplate.speaker_id, previousTemplate.group_id, previousTemplate.template_id);
        db.prepare('UPDATE voiceprint_consents SET revoked_at=? WHERE family_id=? AND member_id=? AND revoked_at IS NULL').run(now(), input.familyId, input.memberId);
        db.prepare('INSERT INTO voiceprint_consents VALUES(?,?,?,?,1,?,?,NULL)').run(input.familyId, input.memberId, input.operationId,
          VOICEPRINT_CONSENT_VERSION, input.guardianConsent === true ? 1 : 0, now());
        db.prepare("UPDATE voiceprint_enrollments SET state='active' WHERE family_id=? AND operation_id=?").run(input.familyId, input.operationId);
        db.exec('COMMIT');
      } catch (failure) { db.exec('ROLLBACK'); throw failure; }
      return publicStatus(row(input.familyId, input.memberId)!);
    } catch (failure) {
      if (op.groupId && !closed) queue(input.familyId, input.memberId, op.speakerId, op.groupId, templateId);
      if (!closed) db.prepare("UPDATE voiceprint_enrollments SET state='cancelled' WHERE family_id=? AND operation_id=? AND state='pending'").run(input.familyId, input.operationId);
      throw failure;
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener('abort', cancel);
      if (op.audioId) audio.delete(op.audioId); pending.delete(key);
    }
  }

  function deactivate(familyId: string, memberId: string, status: 'disabled' | 'deleted'): VoiceprintStatus | undefined {
    assertRunning();
    for (const op of pending.values()) if (op.familyId === familyId && op.memberId === memberId) abort(op);
    const template = row(familyId, memberId);
    if (!template) return;
    db.prepare('UPDATE voiceprint_templates SET status=?,revision=revision+1 WHERE family_id=? AND member_id=?').run(status, familyId, memberId);
    db.prepare('UPDATE voiceprint_consents SET revoked_at=? WHERE family_id=? AND member_id=? AND revoked_at IS NULL').run(now(), familyId, memberId);
    queue(familyId, memberId, template.speaker_id, template.group_id, template.template_id);
    return publicStatus(row(familyId, memberId)!);
  }

  async function cleanup(): Promise<{ processed: number; pending: number }> {
    assertRunning(); sweep();
    if (cleaning || !provider.configured) return { processed: 0, pending: Number((db.prepare("SELECT count(*) AS n FROM voiceprint_cleanup WHERE state='pending'").get() as any).n) };
    cleaning = true; cleanupController = new AbortController(); let processed = 0;
    try {
      const jobs = db.prepare("SELECT * FROM voiceprint_cleanup WHERE state='pending' AND next_attempt<=? ORDER BY created_at LIMIT 10").all(now()) as JobRow[];
      for (const job of jobs) {
        if (closed) break;
        try {
          const templateId = job.template_id ?? await provider.find({ speakerId: job.speaker_id, groupId: job.group_id, signal: cleanupController.signal });
          if (!templateId) {
            // A timed-out vendor creation may materialize later. Absence is not physical deletion.
            const attempts = job.attempts + 1;
            db.prepare('UPDATE voiceprint_cleanup SET attempts=?,next_attempt=? WHERE id=?').run(attempts, now() + Math.min(DAY, 30_000 * 2 ** Math.min(attempts, 11)), job.id);
            continue;
          }
          db.prepare('UPDATE voiceprint_cleanup SET template_id=? WHERE id=?').run(templateId, job.id);
          await provider.remove({ templateId, signal: cleanupController.signal });
          if (closed) break;
          db.prepare("UPDATE voiceprint_cleanup SET state='soft_deleted',attempts=attempts+1 WHERE id=?").run(job.id);
          processed++;
        } catch {
          if (closed) break;
          const attempts = job.attempts + 1;
          db.prepare('UPDATE voiceprint_cleanup SET attempts=?,next_attempt=? WHERE id=?').run(attempts, now() + Math.min(DAY, 30_000 * 2 ** Math.min(attempts, 11)), job.id);
        }
      }
    } finally { cleaning = false; cleanupController = undefined; }
    return { processed, pending: Number((db.prepare("SELECT count(*) AS n FROM voiceprint_cleanup WHERE state='pending'").get() as any).n) };
  }

  return {
    configured, retentionDays: retentionMs / DAY, consentVersion: VOICEPRINT_CONSENT_VERSION,
    enroll,
    list(familyId: string): VoiceprintStatus[] {
      assertRunning(); sweep();
      return (db.prepare('SELECT * FROM voiceprint_templates WHERE family_id=? ORDER BY member_id').all(familyId) as TemplateRow[]).map(publicStatus);
    },
    disable(familyId: string, memberId: string) { member(familyId, memberId); return deactivate(familyId, memberId, 'disabled'); },
    remove(familyId: string, memberId: string) { member(familyId, memberId); return deactivate(familyId, memberId, 'deleted'); },
    removeFamily(familyId: string) {
      assertRunning();
      for (const op of pending.values()) if (op.familyId === familyId) abort(op);
      for (const template of db.prepare('SELECT * FROM voiceprint_templates WHERE family_id=?').all(familyId) as TemplateRow[]) deactivate(familyId, template.member_id, 'deleted');
      db.prepare('DELETE FROM voiceprint_groups WHERE family_id=?').run(familyId);
      db.prepare('DELETE FROM voiceprint_enrollments WHERE family_id=?').run(familyId);
      db.prepare('DELETE FROM voiceprint_consents WHERE family_id=?').run(familyId);
    },
    cancel(familyId: string, operationId: string) { assertRunning(); const op = pending.get(`${familyId}:${operationId}`); if (op) abort(op); },
    getAudio(id: string, expires: string, suppliedSignature: string): { bytes: Uint8Array; contentType: string } | undefined {
      if (closed || !UUID.test(id) || !/^\d{10,16}$/.test(expires) || !/^[a-f\d]{64}$/.test(suppliedSignature)) return;
      const clip = audio.get(id); const expiresAt = Number(expires);
      if (!clip || clip.expiresAt !== expiresAt || expiresAt <= now()) return;
      const op = pending.get(`${clip.familyId}:${clip.operationId}`);
      if (!op || op.controller.signal.aborted) return;
      try { op.assertAuthorized?.(); } catch { abort(op); return; }
      if (!timingSafeEqual(Buffer.from(signature(id, expiresAt), 'hex'), Buffer.from(suppliedSignature, 'hex'))) return;
      return { bytes: new Uint8Array(clip.bytes), contentType: clip.contentType };
    },
    asrParameters(familyId: string): ReturnType<typeof voiceprintAsrParameters> | undefined {
      assertRunning(); sweep(); if (!configured) return;
      const active = db.prepare("SELECT * FROM voiceprint_templates WHERE family_id=? AND status='enrolled' AND expires_at>?").all(familyId, now()) as TemplateRow[];
      if (!active.length || active.some(entry => entry.group_id !== active[0].group_id)) return;
      return voiceprintAsrParameters(active[0].group_id);
    },
    parseMatch(familyId: string, payload: unknown): VoiceprintMatch | undefined {
      assertRunning(); sweep(); if (!configured) return;
      const speakerId = parseVoiceprintSpeaker(payload); if (!speakerId) return;
      const template = db.prepare("SELECT * FROM voiceprint_templates WHERE family_id=? AND speaker_id=? AND status='enrolled' AND expires_at>?").get(familyId, speakerId, now()) as TemplateRow | undefined;
      if (!template) return;
      const who = member(familyId, template.member_id);
      if (!who.consent || who.status === 'disabled') return;
      return { memberId: who.id, ...(template.child_id ? { childId: template.child_id } : {}), name: who.name, relation: who.relation, revision: template.revision };
    },
    sweep, cleanup,
    close() {
      if (closed) return;
      for (const op of pending.values()) abort(op, error(503, '服务已停止，登记未激活', 'SERVICE_STOPPED'));
      cleanupController?.abort();
      audio.clear(); closed = true;
    },
  };
}
