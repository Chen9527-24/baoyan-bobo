import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildAutoMemoryMessages, buildConversationMemoryMessages, boundedDailyReviewStatements, extractConversationMemories, autoMemoryTopicKey, eligibleAutoMemoryStatements, extractAutoMemories, type AutoMemoryStatement } from './auto-memory-extractor.js';
import type { DailyChatStatement, SemanticDailyReview } from './daily-chat-summary.js';

type Scope = { familyId: string; childId: string; revision: number };
type State = 'pending' | 'saved' | 'empty' | 'failed' | 'cancelled' | 'skipped';
type Job = Scope & { controller: AbortController };
const TTL = 30 * 86400000;
const relativeTime = /今天|明天|昨天|前天|后天|今晚|昨晚|明晚|这周|下周|上周|本周|周末|下个月|上个月|这个月|今年|明年|去年|等会|待会|刚才|刚刚|早上|下午|晚上/;
const fingerprint = (content: string) => 'content:' + createHash('sha256').update(content.replace(/[\p{P}\p{Z}\s]/gu, '')).digest('hex');

/** Persist only the extracted memory and content-free status, never the conversation. */
export function createAutoMemoryStore(options: {
  db: DatabaseSync; now: () => number;
  valid: (scope: Scope) => boolean;
  summarize: (messages: { role: string; content: string }[], signal: AbortSignal) => Promise<string>;
  onSaved: (familyId: string) => void;
  onDailyReview?: (scope: Scope & { sessionId: string }, reviews: SemanticDailyReview[]) => void;
}) {
  const { db, now } = options;
  db.exec(`CREATE TABLE IF NOT EXISTS auto_memory_status(family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,child_id TEXT NOT NULL,state TEXT NOT NULL,saved_count INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(family_id,child_id));
    CREATE TABLE IF NOT EXISTS auto_memory_blocks(family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,child_id TEXT NOT NULL,blocked_key TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(family_id,child_id,blocked_key));`);
  // A restart cannot resume a job: its raw input was deliberately never persisted.
  db.prepare("UPDATE auto_memory_status SET state='cancelled',saved_count=0 WHERE state='pending'").run();
  let closed = false;
  const jobs = new Map<string, Job>();
  const promises = new Set<Promise<void>>();
  function status(scope: Scope, state: State, count = 0) {
    if (closed) return;
    if (!db.prepare('SELECT id FROM families WHERE id=?').get(scope.familyId)) return;
    db.prepare('INSERT INTO auto_memory_status VALUES(?,?,?,?,?) ON CONFLICT(family_id,child_id) DO UPDATE SET state=excluded.state,saved_count=excluded.saved_count,updated_at=excluded.updated_at')
      .run(scope.familyId, scope.childId, state, count, now());
  }
  function alive(job: Job) { return !closed && !job.controller.signal.aborted && jobs.get(job.familyId) === job && options.valid(job); }
  function cancelFamily(familyId: string) {
    const job = jobs.get(familyId);
    if (!job) return;
    jobs.delete(familyId); job.controller.abort(); status(job, 'cancelled');
  }
  function block(familyId: string, childId: string, key: string, content: string, kind: 'preference'|'event'|'imaginary'|'plan') {
    for (const value of [key, autoMemoryTopicKey(content,kind), fingerprint(content)]) db.prepare('INSERT INTO auto_memory_blocks VALUES(?,?,?,?) ON CONFLICT(family_id,child_id,blocked_key) DO UPDATE SET expires_at=excluded.expires_at').run(familyId, childId, value, now() + TTL);
  }
  function unblock(familyId: string, childId: string, key: string, content: string, kind: 'preference'|'event'|'imaginary'|'plan') {
    for (const value of [key, autoMemoryTopicKey(content,kind), fingerprint(content)]) db.prepare('DELETE FROM auto_memory_blocks WHERE family_id=? AND child_id=? AND blocked_key=?').run(familyId, childId, value);
  }
  function enqueue(scope: Scope, source: AutoMemoryStatement[], review?: { sessionId: string; statements: DailyChatStatement[] }) {
    const statements = eligibleAutoMemoryStatements(source).map(item => ({ ...item }));
    const daily = review ? boundedDailyReviewStatements(review.statements).map(item => ({ ...item })) : [];
    if (closed || !options.valid(scope)) return;
    cancelFamily(scope.familyId);
    if (!statements.length && !daily.length) {status(scope,'empty');return;}
    const job: Job = { ...scope, controller: new AbortController() };
    jobs.set(scope.familyId, job); status(job, 'pending');
    const timeout = setTimeout(() => job.controller.abort(), 15000); timeout.unref();
    const task = (async () => {
      try {
        // Finish the request's synchronous mutation first (e.g. disabling memory).
        await Promise.resolve();
        if (!alive(job)) return;
        const output = await options.summarize(review ? buildConversationMemoryMessages(statements, daily) : buildAutoMemoryMessages(statements), job.controller.signal);
        if (!alive(job)) { if (jobs.get(job.familyId) === job) status(job, 'cancelled'); return; }
        const extracted = review ? extractConversationMemories(output, statements, daily) : { memories: extractAutoMemories(output, statements), reviews: [] };
        const { memories } = extracted;
        let changed = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!alive(job)) { db.exec('ROLLBACK'); status(job, 'cancelled'); return; }
          db.prepare('DELETE FROM auto_memory_blocks WHERE expires_at<=?').run(now());
          let count = Number((db.prepare('SELECT count(*) n FROM memories WHERE family_id=?').get(job.familyId) as { n: number }).n);
          const revision = job.revision + 1;
          for (const memory of memories) {
            const blocked = [memory.key, fingerprint(memory.content)].some(key => db.prepare('SELECT 1 FROM auto_memory_blocks WHERE family_id=? AND child_id=? AND blocked_key=? AND expires_at>?').get(job.familyId, job.childId, key, now()));
            if (blocked) continue;
            const protectedTopic=(db.prepare('SELECT content,kind,source FROM memories WHERE family_id=?').all(job.familyId) as {content:string;kind:'preference'|'event'|'imaginary'|'plan';source:string}[]).some(item=>!item.source.startsWith('聊天自动整理（')&&autoMemoryTopicKey(item.content,item.kind)===memory.key);
            if(protectedTopic)continue;
            const existing = db.prepare('SELECT * FROM memories WHERE family_id=? AND key=?').get(job.familyId, memory.key) as { id: string; content: string; source: string } | undefined;
            const source = `聊天自动整理（${memory.recordedDay ? `原话日：${memory.recordedDay}` : '日期未记录'}）`;
            // Repeating "tomorrow" on a new day is new dated evidence, even when
            // its words match. Stable preferences still keep their original TTL.
            const refreshRelativeDay = Boolean(memory.kind !== 'preference' && memory.recordedDay && relativeTime.test(memory.content) && existing?.source !== source);
            // Explicitly confirmed facts and parent corrections have priority over inference.
            if (existing && (!existing.source.startsWith('聊天自动整理（') || existing.content === memory.content && !refreshRelativeDay)) continue;
            if (!existing && count >= 20) continue;
            db.prepare("UPDATE memory_operations SET state='superseded' WHERE family_id=? AND memory_id=? AND action='save'").run(job.familyId, existing?.id ?? '');
            db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(family_id,key) DO UPDATE SET content=excluded.content,kind=excluded.kind,revision=excluded.revision,expires_at=excluded.expires_at,source=excluded.source')
              .run(existing?.id ?? randomUUID(), job.familyId, memory.key, memory.content, memory.kind, revision, now() + TTL, source);
            changed++; if (!existing) count++;
          }
          if (review && options.onDailyReview) options.onDailyReview({ ...scope, sessionId: review.sessionId }, extracted.reviews);
          if (changed) db.prepare('UPDATE families SET revision=? WHERE id=?').run(revision, job.familyId);
          status(job, changed ? 'saved' : memories.length ? 'skipped' : 'empty', changed);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        if (changed && !closed) options.onSaved(job.familyId);
      } catch {
        if (!closed && jobs.get(job.familyId) === job) status(job, job.controller.signal.aborted ? 'cancelled' : 'failed');
      } finally {
        clearTimeout(timeout);
        if (jobs.get(job.familyId) === job) jobs.delete(job.familyId);
      }
    })();
    promises.add(task); void task.finally(() => promises.delete(task));
  }
  return {
    enqueue, cancelFamily, block, unblock,
    summary(familyId: string, childId: string) {
      const row = db.prepare('SELECT state,saved_count,updated_at FROM auto_memory_status WHERE family_id=? AND child_id=?').get(familyId, childId) as { state: State; saved_count: number; updated_at: number } | undefined;
      return row ? { state: row.state, savedCount: row.saved_count, updatedAt: new Date(row.updated_at).toISOString() } : { state: 'idle', savedCount: 0 };
    },
    deleteChild(familyId: string, childId: string) {
      cancelFamily(familyId);
      db.prepare('DELETE FROM auto_memory_status WHERE family_id=? AND child_id=?').run(familyId, childId);
      db.prepare('DELETE FROM auto_memory_blocks WHERE family_id=? AND child_id=?').run(familyId, childId);
    },
    sweep() { if (!closed) {db.prepare('DELETE FROM auto_memory_blocks WHERE expires_at<=?').run(now());db.prepare('DELETE FROM auto_memory_status WHERE updated_at<?').run(now()-TTL);} },
    wait: async () => { await Promise.all([...promises]); },
    close() { for (const familyId of jobs.keys()) cancelFamily(familyId); closed = true; },
  };
}
