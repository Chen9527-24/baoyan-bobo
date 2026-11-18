import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createMemoryContinuity, memoryTopicClosed } from '../apps/server/src/memory-continuity.js';
import type { Memory } from '../apps/server/src/types.js';

const personal = (content: string, kind: Memory['kind'] = 'plan'): Memory => ({ id: randomUUID(), key: randomUUID(), content, kind, scope: 'personal', revision: 1, source: '聊天自动整理（原话日：2026-09-30）' });
const global: Memory = { ...personal('小屋叫云朵小屋', 'imaginary'), key: 'world.home.name', scope: 'global' };
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE families(id TEXT PRIMARY KEY);CREATE TABLE memories(id TEXT PRIMARY KEY);CREATE TABLE software_profile_memories(family_id TEXT);');
  const familyId = randomUUID(), childId = randomUUID(); db.prepare('INSERT INTO families VALUES(?)').run(familyId);
  let time = Date.parse('2026-09-30T00:00:00Z'); const continuity = createMemoryContinuity(db, () => time);
  return { db, familyId, childId, continuity, advance(ms: number) { time += ms; } };
}

test('continuity offers at most one confirmed plan/imaginary topic per child and Beijing day', () => {
  const f = fixture(); try {
    const memories = [global, personal('我明天准备画画'), personal('想象的小屋里有一棵星星树', 'imaginary'), personal('我喜欢蓝色', 'preference')];
    const first = f.continuity.offer(f.familyId, f.childId, '我回来了', memories); assert.ok(first); assert.ok(['plan', 'imaginary'].includes(first.kind));
    assert.equal(f.continuity.offer(f.familyId, f.childId, '宝妍你好', memories), undefined);
    f.advance(86_400_000); assert.ok(f.continuity.offer(f.familyId, f.childId, '我又来了', memories));
  } finally { f.db.close(); }
});

test('casual non-greeting and preference-only lists do not trigger unsolicited recall', () => {
  const f = fixture(); try {
    const plan = personal('我明天准备画画');
    assert.equal(f.continuity.offer(f.familyId, f.childId, '我今天有点困', [plan]), undefined);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [global, personal('我喜欢画画', 'preference')]), undefined);
    assert.equal(Number((f.db.prepare('SELECT count(*) AS n FROM memory_continuity').get() as any).n), 0);
  } finally { f.db.close(); }
});

test('refusal stops future unsolicited offer and ordinary recall but explicit related memory remains available', () => {
  const f = fixture(); try {
    const plan = personal('我明天准备画画'); f.continuity.refused(f.familyId, f.childId, plan.id);
    f.advance(86_400_000);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '我回来了', [plan]), undefined);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '画画怎么样', [global, plan]).map(item => item.id), [global.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你还记得我画画的计划吗', [global, plan]).map(item => item.id), [global.id, plan.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你还记得踢球吗', [global, plan]).map(item => item.id), [global.id]);
  } finally { f.db.close(); }
});

test('suppression and daily offer state belong to selected child and family, with no memory contents persisted', () => {
  const f = fixture(); try {
    const plan = personal('我明天准备画画'), secondChild = randomUUID(), secondFamily = randomUUID();
    f.db.prepare('INSERT INTO families VALUES(?)').run(secondFamily);
    assert.ok(f.continuity.offer(f.familyId, f.childId, '你好', [plan]));
    assert.ok(f.continuity.offer(f.familyId, secondChild, '你好', [plan]));
    assert.ok(f.continuity.offer(secondFamily, f.childId, '你好', [plan]));
    f.continuity.refused(f.familyId, f.childId, plan.id);
    assert.equal(f.continuity.relevant(f.familyId, f.childId, '画画怎么样', [plan]).length, 0);
    assert.equal(f.continuity.relevant(f.familyId, secondChild, '画画怎么样', [plan]).length, 1);
    assert.equal(f.continuity.relevant(secondFamily, f.childId, '画画怎么样', [plan]).length, 1);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM memory_continuity').all()).includes('画画'), false);
  } finally { f.db.close(); }
});

test('continuity only uses the current caller-scoped memory list and does not pull another child bucket', () => {
  const f = fixture(); try {
    const first = personal('我明天准备画画'), second = personal('我明天准备踢球');
    f.continuity.offer(f.familyId, f.childId, '你好', [first]);
    const offered = f.continuity.offer(f.familyId, randomUUID(), '你好', [second]);
    assert.equal(offered?.id, second.id); assert.equal(offered?.content.includes('画画'), false);
    assert.deepEqual(f.continuity.relevant(f.familyId, randomUUID(), '画画怎么样', [global, second]).map(item => item.id), [global.id]);
  } finally { f.db.close(); }
});

test('bounded related topics recall drawing and construction synonyms without conflating other activities', () => {
  const f = fixture(); try {
    const drawing = personal('我喜欢画画', 'preference'), building = personal('我明天准备玩积木');
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '今天想试试绘画', [drawing, building]).map(item => item.id), [drawing.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '我打算搭建一座小城堡', [drawing, building]).map(item => item.id), [building.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '足球该怎么玩', [drawing, building]), []);
    assert.equal(f.continuity.relevant(f.familyId, randomUUID(), '绘画', [building]).length, 0);
  } finally { f.db.close(); }
});

test('ordinary generic phrases and shared feelings do not trigger private recall by themselves', () => {
  const f = fixture(); try {
    const memories = [personal('我明天准备画画'), personal('我今天有点难过', 'event'), personal('我已经完成了拼图', 'event')];
    for (const text of ['我明天准备做点事情', '我今天有点难过', '我已经完成了', '你喜欢什么', '帮我一下', '我们一起聊聊', '我现在想学习']) {
      assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, text, memories), [], text);
    }
    const dinosaur = personal('我喜欢恐龙', 'preference');
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '恐龙生活在哪里', [dinosaur]).map(item => item.id), [dinosaur.id]);
    const cat = personal('我看了一只小猫', 'event');
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '我看了一只小狗', [cat]), []);
  } finally { f.db.close(); }
});

test('direct broad recall is bounded to three scoped personal items and may specify preferences', () => {
  const f = fixture(); try {
    const first = personal('我喜欢恐龙', 'preference'), second = personal('我喜欢绿色', 'preference');
    const plan = personal('我明天准备画画'), event = personal('我读完了一本书', 'event');
    const memories = [global, first, second, plan, event];
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你还记得我喜欢什么吗', memories).map(item => item.id), [global.id, first.id, second.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你还记得我之前说过什么吗', memories).map(item => item.id), [global.id, second.id, plan.id, event.id]);
    for (const text of ['记忆是什么', '妈妈说你还记得我喜欢什么吗', '“你还记得我喜欢什么吗”是什么意思']) {
      assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, text, memories).map(item => item.id), [global.id], text);
    }
  } finally { f.db.close(); }
});

test('refused topics stay suppressed across synonyms, edits and broad recall until explicitly requested', () => {
  const f = fixture(); try {
    const drawing = personal('我喜欢画画', 'preference');
    f.continuity.refused(f.familyId, f.childId, drawing.id);
    const revised = { ...drawing, content: '我现在喜欢绘画', revision: 2 };
    for (const text of ['绘画怎么开始', '我之前想绘画', '你还记得我喜欢什么吗']) {
      assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, text, [revised]), [], text);
    }
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你还记得我画画的喜好吗', [revised]).map(item => item.id), [drawing.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '我们继续聊画画吧', [revised]).map(item => item.id), [drawing.id]);
    for (const text of ['不要再记得我画画的事情', '妈妈问你记得我绘画的事情吗', '“你记得我的绘画吗”这句话怎么说']) {
      assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, text, [revised]), [], text);
    }
  } finally { f.db.close(); }
});

test('expired and malformed expiry items cannot be recalled or consume a daily offer', () => {
  const f = fixture(); try {
    const expired = { ...personal('我明天准备画画'), expiresAt: '2026-09-30T00:00:00Z' };
    const malformed = { ...personal('我明天准备玩积木'), expiresAt: 'invalid' };
    const active = { ...personal('我明天准备绘画'), expiresAt: '2026-09-30T00:00:01Z' };
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你还记得我之前说过什么吗', [expired, malformed, active]).map(item => item.id), [active.id]);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [expired, malformed]), undefined);
    assert.equal(Number((f.db.prepare('SELECT count(*) AS n FROM memory_continuity').get() as any).n), 0);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [expired, malformed, active])?.id, active.id);
    f.advance(1000);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '绘画', [active]), []);
  } finally { f.db.close(); }
});

test('removed and rewritten items cannot be recovered from continuity state', () => {
  const f = fixture(); try {
    const original = personal('我明天准备画画');
    f.continuity.offer(f.familyId, f.childId, '你好', [original]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你记得我绘画的计划吗', []), []);
    const revised = { ...original, content: '我明天准备踢球', revision: 2 };
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '绘画', [revised]), []);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '足球', [revised]).map(item => item.id), [original.id]);
    const stored = JSON.stringify(f.db.prepare('SELECT * FROM memory_continuity').all());
    assert.equal(stored.includes('画画'), false); assert.equal(stored.includes('踢球'), false);
  } finally { f.db.close(); }
});

test('Beijing midnight resets the daily budget but the same topic remains under a seven-day cooldown', () => {
  const f = fixture(); try {
    const plan = personal('想象的小屋里有画画的花园', 'imaginary'), otherChild = randomUUID();
    f.advance(15 * 3600000 + 59 * 60000 + 59 * 1000);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [plan])?.id, plan.id);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [plan]), undefined);
    f.advance(1000);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [plan]), undefined);
    f.advance(6 * 86_400_000);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [plan])?.id, plan.id);
    f.continuity.refused(f.familyId, f.childId, plan.id);
    assert.equal(f.continuity.offer(f.familyId, otherChild, '你好', [plan])?.id, plan.id);
    assert.equal(f.continuity.relevant(f.familyId, otherChild, '绘画', [plan]).length, 1);
  } finally { f.db.close(); }
});

test('ordinary recall sends at most three relevant personal items and keeps unrelated private facts out', () => {
  const f = fixture(); try {
    const items = ['我喜欢画画', '我想画一个花园', '我准备画画', '我画了一只小猫', '我喜欢绘画'].map(content => personal(content));
    const unrelated = personal('我喜欢足球', 'preference');
    const recalled = f.continuity.relevant(f.familyId, f.childId, '画画', [global, ...items, unrelated]);
    assert.equal(recalled.filter(item => item.scope === 'personal').length, 3);
    assert.ok(recalled.some(item => item.id === global.id));
    assert.ok(recalled.every(item => item.id !== unrelated.id));
  } finally { f.db.close(); }
});

test('a direct current refusal excludes only the named topic while a new topic remains available', () => {
  const f = fixture(); try {
    const drawing = personal('我喜欢画画', 'preference'), football = personal('我喜欢足球', 'preference');
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '别再提画画了。说说足球吧', [drawing, football]).map(item => item.id), [football.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '别再提画画了，聊足球吧', [drawing, football]).map(item => item.id), [football.id]);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '我不想聊画画了', [drawing, football]), []);
    assert.equal(memoryTopicClosed(football, '别提画画了'), false);
    assert.equal(memoryTopicClosed(personal('我明天准备踢足球'), '我已经画完小猫了，明天打算踢足球'), false);
    assert.equal(memoryTopicClosed(drawing, '我不喜欢足球'), false);
  } finally { f.db.close(); }
});

test('a child self-reported completion or cancellation closes ordinary old-plan recall without deleting it', () => {
  const f = fixture(); try {
    const plan = personal('我明天准备画画');
    for (const text of ['我已经画完小猫了', '我不打算画画了', '我画完了小花园']) {
      assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, text, [plan]), [], text);
    }
    const history = [{ role: 'user' as const, content: '我已经画好小花园了' }, { role: 'assistant' as const, content: '好呀。' }];
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '画画真有趣', [plan], history), []);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '你还记得我画画的计划吗', [plan], history).map(item => item.id), [plan.id]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_continuity').get()?.n, 0, 'no invented completion persisted');
  } finally { f.db.close(); }
});

test('assistant guesses, third parties, negations, questions and quotes cannot close a child plan', () => {
  const plan = personal('我明天准备画画');
  for (const text of ['我还没有画完', '我已经画完了吗？', '“我已经画完了”是什么意思', '妈妈说我已经画完了', '我朋友已经画完了', '如果我已经画完了就好了', '我可能已经画完了']) {
    assert.equal(memoryTopicClosed(plan, text), false, text);
  }
  assert.equal(memoryTopicClosed(plan, '画画', [{ role: 'assistant', content: '我已经画完了' }]), false);
  assert.equal(memoryTopicClosed(plan, '画画', [{ role: 'assistant', content: '别再提画画了' }]), false);
});

test('only current or recent dated plans may be offered; old plans remain available on explicit recall', () => {
  const f = fixture(); try {
    const undated = { ...personal('我明天准备画画'), source: '聊天自动整理（日期未记录）' };
    const old = { ...personal('我明天准备踢足球'), source: '聊天自动整理（原话日：2026-09-20）' };
    const malformed = { ...personal('我明天准备玩积木'), source: '聊天自动整理（原话日：2026-02-30）' };
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [undated, old, malformed]), undefined);
    assert.equal(f.continuity.relevant(f.familyId, f.childId, '你还记得我踢球的计划吗', [old])[0]?.id, old.id);
    const recent = personal('我明天准备画画');
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [recent])?.id, recent.id);
    f.advance(4 * 86_400_000);
    assert.equal(f.continuity.offer(f.familyId, randomUUID(), '你好', [recent]), undefined, 'do not keep asking a past tomorrow plan');
  } finally { f.db.close(); }
});

test('a later self-reported same-topic event avoids an unsolicited plan reminder without claiming the plan was fulfilled', () => {
  const f = fixture(); try {
    const plan = personal('我明天准备画画');
    const event = { ...personal('我已经画完小花园了', 'event'), source: '聊天自动整理（原话日：2026-10-01）' };
    f.advance(86_400_000);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [plan, event]), undefined);
    assert.equal(f.continuity.relevant(f.familyId, f.childId, '你还记得我画画的计划吗', [plan, event]).some(item => item.id === plan.id), true);
    assert.equal(f.continuity.offer(f.familyId, f.childId, '你好', [plan, { ...event, content: '妈妈说我已经画完小花园了' }])?.id, plan.id);
  } finally { f.db.close(); }
});

test('only an explicit lasting refusal of a named authorized topic is saved across calls', () => {
  const f = fixture(); try {
    const drawing = personal('我喜欢画画', 'preference'), football = personal('我喜欢足球', 'preference');
    for (const text of ['我今天不想再聊画画了', '现在别再提画画', '先不聊画画', '“别再提画画”是什么意思', '妈妈说别再提画画', '别再提无聊的事了']) {
      assert.deepEqual(f.continuity.refuseTopics(f.familyId, f.childId, text, [global, drawing, football]), [], text);
    }
    assert.deepEqual(f.continuity.refuseTopics(f.familyId, f.childId, '以后别再提画画了，我们聊足球', [global, drawing, football]), [drawing.id]);
    f.advance(86_400_000);
    assert.deepEqual(f.continuity.relevant(f.familyId, f.childId, '绘画和足球', [drawing, football]).map(item => item.id), [football.id]);
    assert.equal(f.continuity.relevant(f.familyId, f.childId, '你还记得我绘画的喜好吗', [drawing])[0]?.id, drawing.id);
    assert.equal(f.continuity.relevant(f.familyId, randomUUID(), '绘画', [drawing])[0]?.id, drawing.id);
    const stored = JSON.stringify(f.db.prepare('SELECT * FROM memory_continuity').all());
    assert.equal(stored.includes('画画'), false); assert.equal(stored.includes('足球'), false);
  } finally { f.db.close(); }
});
