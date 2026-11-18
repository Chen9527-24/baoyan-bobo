import { Router, type Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ApiError } from './provider-errors.js';
import { feedbackReportForExport, triageFeedback } from './feedback.js';

type Actor = { id: string; username: string };
const status = z.enum(['open', 'in_progress', 'resolved']);
const listInput = z.object({
  q: z.string().trim().max(64).regex(/^[a-zA-Z0-9-]*$/).default(''),
  status: status.optional(), offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const editInput = z.object({ status, revision: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)), confirm: z.literal(true),
}).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, '请检查反馈编号、处理状态和备注。', 'ADMIN_FEEDBACK_INVALID');
  return result.data;
}

/** Explicit feedback only: never reads the conversation or private memory tables. */
export function createAdminFeedbackRouter<T extends Actor>(options: {
  db: DatabaseSync; now: () => number; authorize: (req: Request) => T;
  audit: (actor: T, action: string, targetId: string) => void;
}) {
  const { db, now, authorize, audit } = options;
  const router = Router();
  const live = (id: string) => {
    const row = db.prepare('SELECT id FROM feedback_reports WHERE id=? AND (expires_at IS NULL OR expires_at>?)').get(id, now());
    if (!row) throw new ApiError(404, '这条反馈不存在、已删除或已到期。', 'ADMIN_FEEDBACK_NOT_FOUND');
  };
  const revision = (id: string) => Number(db.prepare('SELECT count(*) AS n FROM feedback_triage_events WHERE report_id=?').get(id)!.n) + 1;
  const metadata = (row: Record<string, unknown>) => ({
    id: String(row.id), createdAt: new Date(Number(row.created_at)).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(Number(row.expires_at)).toISOString(),
    status: String(row.status), revision: Number(row.revision), hasText: Boolean(row.has_text),
    hasAudio: Number(row.audio_bytes) > 0, audioBytes: Number(row.audio_bytes), familyLinked: Boolean(row.family_linked),
    context: JSON.parse(String(row.context_json)),
  });
  const select = `SELECT f.id,f.created_at,f.expires_at,f.context_json,length(f.text)>0 AS has_text,
    f.audio_bytes,f.family_id IS NOT NULL AS family_linked,coalesce(t.status,'open') AS status,
    (SELECT count(*)+1 FROM feedback_triage_events e WHERE e.report_id=f.id) AS revision
    FROM feedback_reports f LEFT JOIN feedback_triage t ON t.report_id=f.id`;
  router.get('/', (req, res) => {
    authorize(req);
    const input = parse(listInput, req.query);
    const filter = ` WHERE (f.expires_at IS NULL OR f.expires_at>?) AND f.id LIKE ?
      AND (?='' OR coalesce(t.status,'open')=?)`;
    const values = [now(), `%${input.q}%`, input.status ?? '', input.status ?? ''];
    const total = Number(db.prepare(`SELECT count(*) AS n FROM feedback_reports f LEFT JOIN feedback_triage t ON t.report_id=f.id${filter}`).get(...values)!.n);
    const rows = db.prepare(`${select}${filter} ORDER BY f.created_at DESC,f.id LIMIT ? OFFSET ?`).all(...values, input.limit, input.offset);
    res.json({ items: rows.map(metadata), total, offset: input.offset, limit: input.limit });
  });
  router.get('/:id', (req, res) => {
    const actor = authorize(req), id = parse(z.string().uuid(), req.params.id);
    live(id);
    const exported = feedbackReportForExport(db, id)!;
    const row = db.prepare(`${select} WHERE f.id=?`).get(id)!;
    const triage = db.prepare('SELECT note FROM feedback_triage WHERE report_id=?').get(id);
    const events = db.prepare(`SELECT previous_status,status,reviewer,note,created_at FROM feedback_triage_events
      WHERE report_id=? ORDER BY created_at,rowid`).all(id).map(event => ({
      previousStatus: event.previous_status, status: event.status, reviewer: event.reviewer, note: event.note,
      createdAt: new Date(Number(event.created_at)).toISOString(),
    }));
    audit(actor, 'feedback.view', id);
    res.json({ ...metadata(row), text: exported.report.text, note: String(triage?.note ?? ''), events });
  });
  router.get('/:id/audio', (req, res) => {
    const actor = authorize(req), id = parse(z.string().uuid(), req.params.id);
    live(id);
    const row = db.prepare('SELECT audio FROM feedback_reports WHERE id=?').get(id);
    if (!(row?.audio instanceof Uint8Array) || !row.audio.length) throw new ApiError(404, '这条反馈没有语音。', 'ADMIN_FEEDBACK_AUDIO_NOT_FOUND');
    audit(actor, 'feedback.audio', id);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'audio/wav', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline; filename="feedback.wav"' }).send(Buffer.from(row.audio));
  });
  router.post('/:id/status', (req, res) => {
    const actor = authorize(req), id = parse(z.string().uuid(), req.params.id), input = parse(editInput, req.body);
    db.exec('BEGIN IMMEDIATE');
    try {
      live(id);
      if (revision(id) !== input.revision) throw new ApiError(409, '反馈状态已经更新，请刷新后再处理。', 'ADMIN_FEEDBACK_CHANGED');
      const result = triageFeedback(db, { id, status: input.status, reviewer: actor.username, note: input.reason }, now());
      if (result.changed) audit(actor, 'feedback.status', id);
      const nextRevision = revision(id);
      db.exec('COMMIT');
      res.json({ ...result, revision: nextRevision });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  return router;
}
