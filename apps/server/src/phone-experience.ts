import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './provider-errors.js';

export const PHONE_EXPERIENCE_RETENTION_MS = 30 * 86_400_000;
export const PHONE_EXPERIENCE_MAX_RECORDS = 30;
export const PHONE_EXPERIENCE_ENVIRONMENTS = ['iphone-wechat', 'iphone-safari', 'android-wechat', 'android-chrome', 'other-phone'] as const;
export const PHONE_EXPERIENCE_TAGS = ['voice-delay', 'voice-flat', 'voice-unclear', 'playback-failed', 'too-formal', 'too-many-questions', 'wrong-memory', 'natural', 'other'] as const;
export const PHONE_EXPERIENCE_SCORE_KEYS = ['voiceClarity', 'voiceFeeling', 'replyNaturalness', 'continuity', 'overall'] as const;
export const PHONE_OBSERVATION_RESULTS = ['smooth', 'problem', 'uncertain'] as const;
export const PHONE_OBSERVATION_STAGES = ['recording', 'recognition', 'understanding', 'reply', 'voice', 'memory', 'interruption', 'other'] as const;
export const PHONE_OBSERVATION_LANGUAGES = ['mandarin', 'english', 'chaoshan', 'hakka', 'cantonese', 'mixed', 'other', 'uncertain'] as const;
export const PHONE_OBSERVATION_NETWORKS = ['wifi', 'mobile', 'uncertain'] as const;
const score = z.number().int().min(0).max(5);
const scoresSchema = z.object({ voiceClarity: score, voiceFeeling: score, replyNaturalness: score, continuity: score, overall: score }).strict();
const briefText = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)).transform(value => value.trim());
const observationSchema = z.object({
  result: z.enum(PHONE_OBSERVATION_RESULTS),
  stages: z.array(z.enum(PHONE_OBSERVATION_STAGES)).max(4).refine(values => new Set(values).size === values.length),
  language: z.enum(PHONE_OBSERVATION_LANGUAGES), intendedMeaning: briefText(200), recognizedText: briefText(200),
  deviceModel: briefText(60), network: z.enum(PHONE_OBSERVATION_NETWORKS),
}).strict().refine(value => value.result !== 'problem' || value.stages.length > 0)
  .refine(value => value.result !== 'smooth' || value.stages.length === 0);
const draftSchema = z.object({
  operationId: z.string().uuid(), adultFictionalConfirmed: z.literal(true), phoneUsedConfirmed: z.literal(true),
  environment: z.enum(PHONE_EXPERIENCE_ENVIRONMENTS), scores: scoresSchema,
  tags: z.array(z.enum(PHONE_EXPERIENCE_TAGS)).max(5).refine(tags => new Set(tags).size === tags.length),
  note: z.string().max(500).refine(note => !/[\u0000-\u001f\u007f]/u.test(note)).transform(note => note.trim()),
  observation: observationSchema.optional(),
}).strict().refine(draft => !!draft.observation || PHONE_EXPERIENCE_SCORE_KEYS.some(key => draft.scores[key] > 0));
type Scores = z.infer<typeof scoresSchema>;
export type PhoneExperienceRecord = {
  id: string; day: string; createdAt: string; scores: Scores;
  tags: typeof PHONE_EXPERIENCE_TAGS[number][]; note: string;
  environment: typeof PHONE_EXPERIENCE_ENVIRONMENTS[number]; parentUsedPhoneConfirmed: true;
  observation?: z.infer<typeof observationSchema>;
};
export type PhoneExperienceState = { startedAt: string | null; today: string; records: PhoneExperienceRecord[]; completedDays: number };
type Row = { id: string; child_id: string; payload: string; payload_hash: string; created_at: number; day: string };
const failure = (status: number, message: string, code: string) => new ApiError(status, message, code);
const dayAt = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);

/** Parent authorization belongs to the caller. This store independently scopes every
 * operation to a real family+child profile and never reads chat, voice, UA or images. */
export function createPhoneExperienceStore(db: DatabaseSync, now: () => number = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS phone_experience_records(
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL, child_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, day TEXT NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    FOREIGN KEY(family_id,child_id) REFERENCES software_profiles(family_id,child_id) ON DELETE CASCADE,
    UNIQUE(family_id,child_id,operation_id), UNIQUE(family_id,child_id,day)
  );
  CREATE INDEX IF NOT EXISTS phone_experience_scope ON phone_experience_records(family_id,child_id,created_at);
  CREATE INDEX IF NOT EXISTS phone_experience_expiry ON phone_experience_records(expires_at);`);
  const profile = (familyId: string, childId: string) => {
    if (!db.prepare('SELECT 1 FROM software_profiles WHERE family_id=? AND child_id=?').get(familyId, childId))
      throw failure(404, '这份体验资料不存在，请重新选择。', 'PHONE_EXPERIENCE_SCOPE');
  };
  const sweepAt = (at: number) => { db.prepare('DELETE FROM phone_experience_records WHERE expires_at<=?').run(at); };
  const rows = (familyId: string, childId: string) => db.prepare('SELECT id,child_id,payload,payload_hash,created_at,day FROM phone_experience_records WHERE family_id=? AND child_id=? ORDER BY created_at DESC,id').all(familyId, childId) as Row[];
  const stateAt = (familyId: string, childId: string, at: number): PhoneExperienceState => {
    profile(familyId, childId); sweepAt(at); const current = rows(familyId, childId);
    return {
      startedAt: current.length ? new Date(Math.min(...current.map(row => row.created_at))).toISOString() : null,
      today: dayAt(at), records: current.map(row => JSON.parse(row.payload) as PhoneExperienceRecord),
      // This is only the count of user-submitted dates; no pass result is inferred.
      completedDays: new Set(current.map(row => row.day)).size,
    };
  };
  return {
    snapshot(familyId: string, childId: string) { return stateAt(familyId, childId, now()); },
    submit(familyId: string, childId: string, unknownDraft: unknown) {
      const parsed = draftSchema.safeParse(unknownDraft);
      if (!parsed.success) throw failure(400, '请确认实际手机体验，并检查语言、问题环节和简短说明；日期无需填写。', 'PHONE_EXPERIENCE_INVALID');
      const at = now(), draft = parsed.data; profile(familyId, childId); sweepAt(at);
      const tags = [...draft.tags].sort();
      const observation = draft.observation ? { ...draft.observation, stages: [...draft.observation.stages].sort() } : undefined;
      const payloadHash = createHash('sha256').update(JSON.stringify({ environment: draft.environment, scores: draft.scores, tags, note: draft.note, ...(observation ? { observation } : {}) })).digest('hex');
      const existing = db.prepare('SELECT payload_hash FROM phone_experience_records WHERE family_id=? AND child_id=? AND operation_id=?').get(familyId, childId, draft.operationId) as { payload_hash: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw failure(409, '这次记录的内容已经变化，请用新的记录编号。', 'OPERATION_CONFLICT');
        return stateAt(familyId, childId, at);
      }
      const day = dayAt(at);
      if (db.prepare('SELECT 1 FROM phone_experience_records WHERE family_id=? AND child_id=? AND day=?').get(familyId, childId, day))
        throw failure(409, '今天已经记录，请查看原记录或隔天再来。', 'PHONE_EXPERIENCE_DAY_RECORDED');
      if (rows(familyId, childId).length >= PHONE_EXPERIENCE_MAX_RECORDS)
        throw failure(429, '体验记录已达 30 条，请先删除旧记录。', 'PHONE_EXPERIENCE_LIMIT');
      const record: PhoneExperienceRecord = {
        id: randomUUID(), day, createdAt: new Date(at).toISOString(), scores: draft.scores, tags,
        note: draft.note, environment: draft.environment, parentUsedPhoneConfirmed: true,
        ...(observation ? { observation } : {}),
      };
      db.prepare('INSERT INTO phone_experience_records VALUES(?,?,?,?,?,?,?,?,?)').run(record.id, familyId, childId, draft.operationId, payloadHash, day, JSON.stringify(record), at, at + PHONE_EXPERIENCE_RETENTION_MS);
      return stateAt(familyId, childId, at);
    },
    remove(familyId: string, childId: string, id: string) {
      if (!z.string().uuid().safeParse(id).success) throw failure(400, '体验记录编号格式不正确。', 'PHONE_EXPERIENCE_INVALID');
      const at = now(); profile(familyId, childId); sweepAt(at);
      const deleted = db.prepare('DELETE FROM phone_experience_records WHERE family_id=? AND child_id=? AND id=?').run(familyId, childId, id);
      if (!deleted.changes) throw failure(404, '体验记录不存在或已删除。', 'PHONE_EXPERIENCE_NOT_FOUND');
      return stateAt(familyId, childId, at);
    },
    exportFamily(familyId: string): (PhoneExperienceRecord & { childId: string })[] {
      sweepAt(now());
      return (db.prepare('SELECT child_id,payload FROM phone_experience_records WHERE family_id=? ORDER BY created_at DESC,id').all(familyId) as Pick<Row, 'child_id' | 'payload'>[])
        .map(row => ({ ...JSON.parse(row.payload) as PhoneExperienceRecord, childId: row.child_id }));
    },
    sweep() { sweepAt(now()); },
  };
}
