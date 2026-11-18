import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Router, type Request, type CookieOptions } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ApiError } from './provider-errors.js';

const COOKIE = 'baoyan_feedback';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_AUDIO = 16_000 * 2 * 30 + 44;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_REPORTS = 1000;
const MAX_TRIAGE_EVENTS = 100;
export const feedbackTriageSchema = z.object({
  id: z.string().uuid(), status: z.enum(['open', 'in_progress', 'resolved']),
  reviewer: z.string().trim().min(1).max(64).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  note: z.string().trim().max(2000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)).default(''),
}).strict();
export type FeedbackTriageStatus = z.infer<typeof feedbackTriageSchema>['status'];
const contextSchema = z.object({
  page: z.enum(['setup', 'home', 'call', 'parent', 'connection', 'expired']).optional(),
  callState: z.enum(['idle', 'connecting', 'listening', 'processing', 'speaking', 'paused', 'ended']).optional(),
  appVersion: z.enum(['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.2.0']).optional(),
}).strict();
const submissionSchema = z.object({
  operationId: z.string().uuid(),
  text: z.string().trim().max(2000).optional().default(''),
  context: z.string().max(512).optional().default('{}'),
}).strict();
type FeedbackRow = {
  id: string; client_hash: string; operation_id: string; payload_hash: string;
  family_id: string | null; text: string; context_json: string; audio: Uint8Array | null;
  audio_bytes: number; total_bytes: number; created_at: number; expires_at: number | null;
  status?: FeedbackTriageStatus; triage_updated_at?: number;
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const invalid = () => new ApiError(400, '反馈内容格式不正确，请检查后再提交。', 'FEEDBACK_INVALID');
const metadata = (row: FeedbackRow) => ({
  id: row.id, createdAt: new Date(row.created_at).toISOString(),
  context: JSON.parse(row.context_json), hasText: row.text.length > 0,
  hasAudio: row.audio_bytes > 0, audioBytes: row.audio_bytes,
  familyLinked: row.family_id !== null,
  expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  status: row.status ?? 'open', updatedAt: new Date(row.triage_updated_at ?? row.created_at).toISOString(),
});

const hasTriage = (db: DatabaseSync) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_triage'").get());

/** Trusted operator action; no report body, raw audio or note is returned to stdout. */
export function triageFeedback(db: DatabaseSync, input: z.input<typeof feedbackTriageSchema>, at = Date.now()) {
  const parsed = feedbackTriageSchema.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(at) || at < 0) throw new Error('处理参数格式不正确。');
  if (!hasTriage(db)) throw new Error('处理状态表尚未初始化，请先启动当前版本应用。');
  const value = parsed.data;
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const report = db.prepare('SELECT created_at,expires_at FROM feedback_reports WHERE id=?').get(value.id);
    if (!report || (report.expires_at !== null && Number(report.expires_at) <= at)) throw new Error('反馈不存在或已过期。');
    const previous = db.prepare('SELECT status,reviewer,note,updated_at FROM feedback_triage WHERE report_id=?').get(value.id);
    if (previous?.status === value.status && previous.reviewer === value.reviewer && previous.note === value.note) {
      if (ownTransaction) db.exec('COMMIT');
      return { id: value.id, status: value.status, updatedAt: new Date(Number(previous.updated_at)).toISOString(), changed: false, notificationSent: false };
    }
    if (Number(db.prepare('SELECT count(*) AS n FROM feedback_triage_events WHERE report_id=?').get(value.id)!.n) >= MAX_TRIAGE_EVENTS)
      throw new Error('该反馈的处理记录已达上限，请保留已有审计记录。');
    const updatedAt = Math.max(at, Number(previous?.updated_at ?? report.created_at));
    db.prepare(`INSERT INTO feedback_triage(report_id,status,reviewer,note,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(report_id) DO UPDATE SET status=excluded.status,reviewer=excluded.reviewer,note=excluded.note,updated_at=excluded.updated_at`)
      .run(value.id, value.status, value.reviewer, value.note, updatedAt);
    db.prepare('INSERT INTO feedback_triage_events(id,report_id,previous_status,status,reviewer,note,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), value.id, previous?.status ?? 'open', value.status, value.reviewer, value.note, updatedAt);
    if (ownTransaction) db.exec('COMMIT');
    return { id: value.id, status: value.status, updatedAt: new Date(updatedAt).toISOString(), changed: true, notificationSent: false };
  } catch (error) { if (ownTransaction) db.exec('ROLLBACK'); throw error; }
}

/** Accept only our canonical PCM WAV, without metadata chunks or server transcoding. */
function validateAudio(file: Express.Multer.File | undefined): Buffer | null {
  if (!file) return null;
  const b = file.buffer;
  if (!['audio/wav', 'audio/wave', 'audio/x-wav'].includes(file.mimetype.toLowerCase())) throw invalid();
  if (b.length > MAX_AUDIO) throw new ApiError(413, '故障反馈语音最多录制 30 秒。', 'FEEDBACK_AUDIO_TOO_LONG');
  if (b.length < 46 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE'
    || b.readUInt32LE(4) !== b.length - 8 || b.toString('ascii', 12, 16) !== 'fmt ' || b.readUInt32LE(16) !== 16
    || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16_000
    || b.readUInt32LE(28) !== 32_000 || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16
    || b.toString('ascii', 36, 40) !== 'data' || b.readUInt32LE(40) !== b.length - 44 || (b.length - 44) % 2) throw invalid();
  return b;
}

export function feedbackMetadata(db: DatabaseSync) {
  // Do not read text/audio into operator stdout, including in list mode.
  const triage = hasTriage(db);
  return db.prepare(`SELECT f.id,f.created_at,f.context_json,length(f.text)>0 AS has_text,f.audio_bytes,
    f.family_id IS NOT NULL AS family_linked,f.expires_at,${triage ? "coalesce(t.status,'open')" : "'open'"} AS status,
    ${triage ? 'coalesce(t.updated_at,f.created_at)' : 'f.created_at'} AS updated_at FROM feedback_reports f
    ${triage ? 'LEFT JOIN feedback_triage t ON t.report_id=f.id' : ''} ORDER BY f.created_at DESC,f.id`).all().map(row => ({
    id: row.id, createdAt: new Date(Number(row.created_at)).toISOString(), context: JSON.parse(String(row.context_json)),
    hasText: Boolean(row.has_text), hasAudio: Number(row.audio_bytes) > 0, audioBytes: Number(row.audio_bytes),
    familyLinked: Boolean(row.family_linked), expiresAt: row.expires_at === null ? null : new Date(Number(row.expires_at)).toISOString(),
    status: row.status, updatedAt: new Date(Number(row.updated_at)).toISOString(),
  }));
}

export function feedbackReportForExport(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM feedback_reports WHERE id=?').get(id) as FeedbackRow | undefined;
  if (!row) return undefined;
  if (hasTriage(db)) { const triage = db.prepare('SELECT status,updated_at FROM feedback_triage WHERE report_id=?').get(id); if (triage) { row.status = triage.status as FeedbackTriageStatus; row.triage_updated_at = Number(triage.updated_at); } }
  return { report: { ...metadata(row), text: row.text }, audio: row.audio ? Buffer.from(row.audio) : null };
}

export function createFeedback(db: DatabaseSync, now: () => number) {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback_config(name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback_reports(
      id TEXT PRIMARY KEY,client_hash TEXT NOT NULL,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
      family_id TEXT REFERENCES families(id) ON DELETE CASCADE,text TEXT NOT NULL,context_json TEXT NOT NULL,
      audio BLOB,audio_bytes INTEGER NOT NULL,total_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,
      UNIQUE(client_hash,operation_id));
    CREATE INDEX IF NOT EXISTS feedback_family_idx ON feedback_reports(family_id);
    CREATE INDEX IF NOT EXISTS feedback_expiry_idx ON feedback_reports(expires_at);
    CREATE TABLE IF NOT EXISTS feedback_rate_events(id TEXT PRIMARY KEY,client_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS feedback_rate_time_idx ON feedback_rate_events(created_at);
    CREATE INDEX IF NOT EXISTS feedback_rate_client_idx ON feedback_rate_events(client_hash,created_at);
    CREATE TABLE IF NOT EXISTS feedback_triage(
      report_id TEXT PRIMARY KEY REFERENCES feedback_reports(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved')),
      reviewer TEXT NOT NULL CHECK(length(reviewer)<=64),note TEXT NOT NULL CHECK(length(note)<=2000),updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback_triage_events(
      id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
      previous_status TEXT NOT NULL CHECK(previous_status IN ('open','in_progress','resolved')),
      status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved')),
      reviewer TEXT NOT NULL CHECK(length(reviewer) BETWEEN 1 AND 64),note TEXT NOT NULL CHECK(length(note)<=2000),created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS feedback_triage_events_report_idx ON feedback_triage_events(report_id,created_at);
    INSERT OR IGNORE INTO feedback_triage(report_id,status,reviewer,note,updated_at)
      SELECT id,'open','','',created_at FROM feedback_reports;`);
  db.prepare("INSERT OR IGNORE INTO feedback_config(name,value) VALUES('cookie_key',?)").run(randomBytes(32).toString('hex'));
  const key = Buffer.from(String(db.prepare("SELECT value FROM feedback_config WHERE name='cookie_key'").get()!.value), 'hex');
  if (key.length !== 32) throw new Error('反馈配置无效。');
  const sign = (value: string) => createHmac('sha256', key).update(value).digest('base64url');
  function cookieIdentity(req: Request): string | undefined {
    const value = req.cookies?.[COOKIE];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    const [identity, signature] = value.split('.') as [string, string];
    const actual = Buffer.from(signature); const expected = Buffer.from(sign(identity));
    return timingSafeEqual(actual, expected) ? digest(identity) : undefined;
  }
  function sweep() {
    db.prepare('DELETE FROM feedback_reports WHERE expires_at IS NOT NULL AND expires_at<=?').run(now());
    db.prepare('DELETE FROM feedback_rate_events WHERE created_at<=?').run(now() - DAY);
  }
  sweep();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO, files: 1, fields: 3, parts: 4, fieldSize: 8192 },
    fileFilter: (_req, file, callback) => {
      if (['audio/wav', 'audio/wave', 'audio/x-wav'].includes(file.mimetype.toLowerCase())) callback(null, true);
      else callback(invalid());
    },
  });
  return {
    sweep,
    exportFamily(familyId: string) {
      return db.prepare(`SELECT f.id,f.text,f.context_json,f.created_at,f.audio_bytes,f.expires_at,f.family_id,
        coalesce(t.status,'open') AS status,coalesce(t.updated_at,f.created_at) AS triage_updated_at
        FROM feedback_reports f LEFT JOIN feedback_triage t ON t.report_id=f.id WHERE f.family_id=? ORDER BY f.created_at,f.id`)
        .all(familyId).map(row => ({ ...metadata(row as FeedbackRow), text: row.text }));
    },
    router(options: { cookie: CookieOptions; familyId: (req: Request) => string | undefined }) {
      const router = Router();
      router.get('/context', (req, res) => {
        if (!cookieIdentity(req)) {
          const identity = randomBytes(32).toString('base64url');
          res.cookie(COOKIE, `${identity}.${sign(identity)}`, options.cookie);
        }
        res.json({ ok: true });
      });
      router.post('/', (req, res, next) => {
        const clientHash = cookieIdentity(req);
        if (!clientHash) { next(new ApiError(428, '请重新打开反馈窗口，再提交。', 'FEEDBACK_CONTEXT_REQUIRED')); return; }
        if (!req.is('multipart/form-data')) { next(invalid()); return; }
        const initialFamilyId = options.familyId(req) ?? null;
        upload.single('audio')(req, res, error => {
          if (error) { next(error instanceof multer.MulterError ? new ApiError(413, '反馈语音或文字超出限制，请缩短后再提交。', 'FEEDBACK_LIMIT') : error); return; }
          try {
            const parsed = submissionSchema.safeParse(req.body);
            if (!parsed.success) throw invalid();
            const input = parsed.data;
            let json: unknown;
            try { json = JSON.parse(input.context); } catch { throw invalid(); }
            const context = contextSchema.safeParse(json);
            if (!context.success) throw invalid();
            const audio = validateAudio(req.file);
            if (!input.text && !audio) throw new ApiError(400, '请写下遇到的问题，或录一段语音。', 'FEEDBACK_EMPTY');
            const contextJson = JSON.stringify(context.data);
            const familyId = options.familyId(req) ?? null;
            if (initialFamilyId !== familyId) throw new ApiError(409, '家庭资料已变化，请重新打开反馈窗口后提交。', 'FEEDBACK_SESSION_CHANGED');
            const payloadHash = digest(JSON.stringify({ text: input.text, context: context.data, audio: audio ? digest(audio) : null, familyId }));
            const at = now();
            sweep();
            db.exec('BEGIN IMMEDIATE');
            try {
              const existing = db.prepare('SELECT id,created_at,payload_hash FROM feedback_reports WHERE client_hash=? AND operation_id=?').get(clientHash, input.operationId);
              if (existing) {
                if (existing.payload_hash !== payloadHash) throw new ApiError(409, '这次反馈的内容已发生变化，请重新打开反馈窗口后提交。', 'FEEDBACK_CONFLICT');
                db.exec('COMMIT');
                res.status(200).json({ id: existing.id, createdAt: new Date(Number(existing.created_at)).toISOString() });
                return;
              }
              const recent = Number(db.prepare('SELECT count(*) AS n FROM feedback_rate_events WHERE client_hash=? AND created_at>?').get(clientHash, at - HOUR)!.n);
              const global = Number(db.prepare('SELECT count(*) AS n FROM feedback_rate_events WHERE created_at>?').get(at - DAY)!.n);
              if (recent >= 10 || global >= 200) throw new ApiError(429, '反馈提交较多，请稍后再试。内容仍保留在当前窗口。', 'FEEDBACK_RATE_LIMIT');
              const totalBytes = Buffer.byteLength(input.text) + Buffer.byteLength(contextJson) + (audio?.length ?? 0);
              const capacity = db.prepare('SELECT count(*) AS n,coalesce(sum(total_bytes),0) AS bytes FROM feedback_reports').get()!;
              if (Number(capacity.n) >= MAX_REPORTS || Number(capacity.bytes) + totalBytes > MAX_BYTES)
                throw new ApiError(503, '反馈收件箱暂时已满，请稍后再试。', 'FEEDBACK_STORAGE_FULL');
              const id = randomUUID();
              db.prepare(`INSERT INTO feedback_reports(id,client_hash,operation_id,payload_hash,family_id,text,context_json,audio,audio_bytes,total_bytes,created_at,expires_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, clientHash, input.operationId, payloadHash, familyId, input.text, contextJson, audio, audio?.length ?? 0, totalBytes, at, at + 30 * DAY);
              db.prepare("INSERT INTO feedback_triage(report_id,status,reviewer,note,updated_at) VALUES(?,'open','','',?)").run(id, at);
              db.prepare('INSERT INTO feedback_rate_events(id,client_hash,created_at) VALUES(?,?,?)').run(id, clientHash, at);
              db.exec('COMMIT');
              res.status(201).json({ id, createdAt: new Date(at).toISOString() });
            } catch (failure) { db.exec('ROLLBACK'); throw failure; }
          } catch (failure) { next(failure); }
        });
      });
      return router;
    },
  };
}
