import type { DatabaseSync } from 'node:sqlite';
import type { Memory } from './types.js';

// Deliberately small topic families, not inferred facts or a semantic model.
// A match only makes an already-authorized memory available as conversational data.
const topicFamilies = [
  ['画画', '绘画', '画图', '涂画', '画完', '画好'],
  ['积木', '搭建', '搭积木'],
  ['足球', '踢球'],
  ['篮球', '投篮'],
  ['阅读', '读书', '看书'],
  ['唱歌', '歌唱'],
  ['跳舞', '舞蹈'],
  ['小屋', '小房子'],
  ['花园', '小花圃'],
] as const;

// Common conversational fragments must not recall a private item on their own.
const generic = [
  '我', '我们', '你', '你的', '我的', '自己', '现在', '目前', '今天', '昨天', '明天', '后天',
  '上次', '之前', '以前', '下次', '下周', '周末', '晚上', '今晚', '时候', '最近',
  '喜欢', '最喜欢', '不喜欢', '准备', '计划', '打算', '想要', '想去', '想一起',
  '有点', '觉得', '感觉', '开心', '高兴', '难过', '紧张', '事情', '这件事', '一件事',
  '记得', '记忆', '记住', '说过', '聊过', '知道', '继续', '告诉', '什么', '哪些',
  '怎么', '怎么样', '一下', '一起', '一个', '一点', '已经', '完成', '学会', '可以',
  '帮忙', '帮我', '最爱', '爱好', '还是', '特别', '真的', '但是', '然后', '就是',
  '学习', '做事', '小朋友', '问题', '东西', '你好', '谢谢', '回来',
  '看了', '读了', '去了', '做了', '做完', '玩了', '画了', '画完', '种了', '拿了', '买了',
].sort((a, b) => b.length - a.length);

function normalized(text: string) { return text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, ''); }
function meaningfulPairs(text: string) {
  // Do not join pieces across a removed word into an invented shared phrase.
  let remaining = normalized(text).replace(/[一二三四五六七八九十几两\d]+(?:个|只|棵|座|本|条|辆|支|件|种|块|次)/gu, '|');
  for (const word of generic) remaining = remaining.split(word).join('|');
  return new Set(remaining.split('|').flatMap(part => Array.from(
    { length: Math.max(0, part.length - 1) }, (_, index) => part.slice(index, index + 2),
  )).filter(pair => !/^(?:好了|好吧|好的|很好|很多|有个|有一|一只|一棵|一点|是的|这个|那个|那件|这件|去了|去过|做了|做完|做过|说说|聊聊|是什)$/u.test(pair)));
}

function sameTopic(text: string, content: string) {
  const input = normalized(text), memory = normalized(content);
  if (topicFamilies.some(words => words.some(word => input.includes(word)) && words.some(word => memory.includes(word)))) return true;
  const inputPairs = meaningfulPairs(input);
  return [...meaningfulPairs(memory)].some(pair => inputPairs.has(pair));
}

function explicitRecall(text: string) {
  const input = normalized(text);
  if (/[“”「」『』"']/u.test(text) || /^(?:妈妈|爸爸|老师|朋友|同学|他|她).{0,8}(?:说|问|告诉)/u.test(input)) return false;
  return !/(?:不要|不用|不想|别)(?:再)?(?:记得|记忆|记住|提起|回忆)/u.test(input)
    && (/(?:记得|记不记得|还记住|回忆|记忆)/u.test(input)
      || /^(?:(?:那|我们|请|再|想))*?(?:继续|接着)(?:聊|说|讲)/u.test(input));
}

function generalRecallKind(text: string): Memory['kind'] | 'any' | undefined {
  const input = normalized(text);
  // Mentioning memory, a quote or a third party is not a private recall request.
  if (/[“”「」『』"']/u.test(text) || /^(?:妈妈|爸爸|老师|朋友|同学|他|她).{0,8}(?:说|问|告诉)/u.test(input)) return undefined;
  const direct = /^(?:(?:宝妍|姐姐|你|请|那|还|再))*?(?:(?:还)?记得|记不记得|回忆一下|还记住)(?:我|我们)(?:的|上次|之前|以前|喜欢|说|聊|告诉|有什么|哪些|什么)/u.test(input)
    || /^(?:我|我们)(?:上次|之前|以前).{0,8}(?:说过|聊过|告诉过).{0,8}(?:什么|哪些)/u.test(input);
  if (!direct) return undefined;
  if (/(?:喜欢什么|喜欢的是什么|什么喜好|哪些爱好|我的喜好|我的爱好)/u.test(input)) return 'preference';
  if (/(?:什么计划|哪些计划|什么约定|哪些约定|准备做什么|打算做什么|我的计划)/u.test(input)) return 'plan';
  if (/(?:发生了什么|做过什么|做了什么|什么经历|哪些经历|我的经历)/u.test(input)) return 'event';
  if (/(?:聊过什么|聊了什么|说过什么|说了什么|告诉过你什么|告诉你什么|哪些事|什么事|有什么记忆|哪些记忆|什么记忆)/u.test(input)) return 'any';
  return undefined;
}

type History = readonly { role: 'user' | 'assistant'; content: string }[];
const DAY = 86_400_000;
const OFFER_COOLDOWN_DAYS = 7;
function beijingDay(time: number) { return new Date(time + 8 * 3600000).toISOString().slice(0, 10); }
function sourceDay(memory: Memory) {
  const day = /^聊天自动整理（原话日：(\d{4}-\d{2}-\d{2})）$/.exec(memory.source)?.[1];
  return day && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day ? day : undefined;
}

function directClauses(text: string) {
  // Quoted, hypothetical and reported speech cannot close the child's topic.
  // A false negative only leaves a memory available; it never invents an event.
  return text.split(/(?<=[。！？!?；;\n])/u).map(clause => clause.trim()).filter(clause => clause
    && !/[“”「」『』"'？?]/u.test(clause)
    && !/(?:如果|假如|要是|假设|可能|也许|好像|是不是|是否|怎么|什么|(?:吗|呢|么)$)/u.test(clause)
    && !/(?:爸爸|妈妈|爷爷|奶奶|外公|外婆|哥哥|姐姐|弟弟|妹妹|朋友|同学|老师|他|她|宝妍).{0,8}(?:说|问|告诉|觉得|完成|做完|画完|画好)/u.test(clause))
    .flatMap(clause => clause.split(/[，,]/u).map(part => part.trim()).filter(Boolean));
}
function refusesTopic(clause: string) {
  return /^(?:(?:我(?:现在|今天|已经|真的)?|我们|请|你|以后|今后)){0,3}(?:不想|不要|不用|不愿意|别)(?:再|继续|总|老)?(?:聊|说|谈|提|问|回忆)/u.test(clause.replace(/[，,\s]/gu, ''));
}
function permanentlyRefusesTopic(clause: string) {
  return refusesTopic(clause) && !/(?:今天|现在|这次|暂时|先不|先别|先不要|先不用)/u.test(clause)
    && /(?:以后|今后|从今往后)|(?:再|老|总)(?:聊|说|谈|提|问|回忆)/u.test(clause);
}
function closesPlan(clause: string) {
  const input = clause.replace(/[，,\s]/gu, '');
  if (!/^(?:(?:今天|昨天|刚才|现在|这次|那次))?(?:我|我们)/u.test(input)
    || /(?:还没|没有|没能|没做|未完成|没完成|没画|没读|没去|没搭|没玩)/u.test(input)) return false;
  return /(?:不(?:再)?(?:准备|打算|计划|想去|想做)|取消(?:了)?(?:计划|约定)?|已经.{0,15}(?:做完|完成|画好|画完|搭好|搭完|读完|去过|玩过)|(?:做完|画完|画好|搭完|搭好|读完).{0,12}了)/u.test(input);
}

/** Only suppresses an available topic. It does not persist or certify a result. */
export function memoryTopicClosed(memory: Memory, text: string, history: History = []) {
  return [...history.filter(item => item.role === 'user').slice(-10).map(item => item.content), text]
    .flatMap(directClauses).some(clause => sameTopic(clause, memory.content)
      && (refusesTopic(clause) || memory.kind === 'plan' && closesPlan(clause)));
}

function canOfferPlan(memory: Memory, memories: Memory[], today: string) {
  if (memory.kind !== 'plan') return true;
  if (directClauses(memory.content).some(clause => closesPlan(clause))) return false;
  const reference = sourceDay(memory);
  const relative = /今天|明天|昨天|后天|前天|今晚|明晚|昨晚|下周|这周|上周|周末|下个月|这个月|等会|待会/u.test(memory.content);
  // A missing original date cannot be repaired by treating an old "tomorrow"
  // as tomorrow again. Explicit recall can still access this old plan.
  if (relative && !reference) return false;
  if (!reference) return true;
  const elapsed = (Date.parse(today) - Date.parse(reference)) / DAY;
  if (elapsed < 0 || elapsed > 7) return false;
  const offset = /后天/u.test(memory.content) ? 2 : /明天|明晚/u.test(memory.content) ? 1
    : /前天/u.test(memory.content) ? -2 : /昨天|昨晚/u.test(memory.content) ? -1
      : /今天|今晚|等会|待会/u.test(memory.content) ? 0 : undefined;
  if (offset !== undefined && elapsed > offset + 2) return false;
  // A newer same-topic self-reported event makes a fresh reminder unnecessary.
  // We do not assert it fulfilled the plan, or delete either stored item.
  return !memories.some(item => item.scope === 'personal' && item.kind === 'event'
    && Boolean(sourceDay(item) && sourceDay(item)! >= reference)
    && sameTopic(item.content, memory.content) && directClauses(item.content).some(closesPlan));
}

export function createMemoryContinuity(db: DatabaseSync, now: () => number = Date.now) {
  db.exec('CREATE TABLE IF NOT EXISTS memory_continuity(family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,child_id TEXT NOT NULL,memory_id TEXT NOT NULL,last_offered_day TEXT,suppressed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(family_id,child_id,memory_id))');
  const state = (familyId: string, childId: string, memoryId: string) => db.prepare('SELECT suppressed,last_offered_day FROM memory_continuity WHERE family_id=? AND child_id=? AND memory_id=?').get(familyId, childId, memoryId) as { suppressed: number; last_offered_day: string | null } | undefined;
  const valid = (memory: Memory) => memory.expiresAt === undefined || (Number.isFinite(Date.parse(memory.expiresAt)) && Date.parse(memory.expiresAt) > now());

  return {
    refused(familyId: string, childId: string, memoryId: string) {
      db.prepare('INSERT INTO memory_continuity VALUES(?,?,?,NULL,1) ON CONFLICT(family_id,child_id,memory_id) DO UPDATE SET suppressed=1').run(familyId, childId, memoryId);
    },
    /** The caller must first confirm the child's identity, memory permission and
     *  that this is a real conversation, not quoted pure-translation input. */
    refuseTopics(familyId: string, childId: string, text: string, memories: Memory[]) {
      const refusals = directClauses(text).filter(permanentlyRefusesTopic);
      const ids = memories.filter(memory => memory.scope === 'personal' && valid(memory)
        && refusals.some(clause => sameTopic(clause, memory.content))).map(memory => memory.id);
      for (const id of ids) db.prepare('INSERT INTO memory_continuity VALUES(?,?,?,NULL,1) ON CONFLICT(family_id,child_id,memory_id) DO UPDATE SET suppressed=1').run(familyId, childId, id);
      return ids;
    },
    relevant(familyId: string, childId: string, text: string, memories: Memory[], history: History = []) {
      const available = memories.filter(valid), explicit = explicitRecall(text), kind = generalRecallKind(text);
      const requested = kind === undefined ? [] : available.filter(memory => memory.scope === 'personal'
        && !state(familyId, childId, memory.id)?.suppressed && (kind === 'any' || memory.kind === kind)).slice(-3);
      const requestedIds = new Set(requested.map(memory => memory.id));
      const selected = available.filter(memory => memory.scope === 'personal'
        && (requestedIds.has(memory.id) || sameTopic(text, memory.content))
        && (!state(familyId, childId, memory.id)?.suppressed || explicit && sameTopic(text, memory.content))
        && (explicit && !directClauses(text).some(clause => refusesTopic(clause) && sameTopic(clause, memory.content))
          || !memoryTopicClosed(memory, text, history)))
        .map((memory, index) => ({ memory, index, matches: [...meaningfulPairs(memory.content)].filter(pair => meaningfulPairs(text).has(pair)).length }))
        .sort((a, b) => b.matches - a.matches || (sourceDay(b.memory) ?? '').localeCompare(sourceDay(a.memory) ?? '') || b.index - a.index)
        .slice(0, 3);
      const selectedIds = new Set(selected.map(item => item.memory.id));
      return available.filter(memory => memory.scope === 'global' || selectedIds.has(memory.id));
    },
    /** Returns a topic, never a canned reply. The caller may phrase it naturally.
     *  Daily reservation is retained even if later generation fails. */
    offer(familyId: string, childId: string, text: string, memories: Memory[]): Memory | undefined {
      if (!/^(?:你好|嗨|哈喽|我回来了|我又来了|姐姐好|宝妍你好|妍妍你好)[。！!，,\s]*$/u.test(text)) return undefined;
      const day = beijingDay(now());
      const eligible = memories.filter(memory => valid(memory) && memory.scope === 'personal' && (memory.kind === 'plan' || memory.kind === 'imaginary'))
        .filter(memory => canOfferPlan(memory, memories.filter(valid), day))
        .filter(memory => { const record = state(familyId, childId, memory.id); return !record?.suppressed
          && (!record?.last_offered_day || (Date.parse(day) - Date.parse(record.last_offered_day)) / DAY >= OFFER_COOLDOWN_DAYS); });
      if (!eligible.length || db.prepare('SELECT 1 FROM memory_continuity WHERE family_id=? AND child_id=? AND last_offered_day=?').get(familyId, childId, day)) return undefined;
      const memory = eligible.at(-1)!;
      db.prepare('INSERT INTO memory_continuity VALUES(?,?,?,?,0) ON CONFLICT(family_id,child_id,memory_id) DO UPDATE SET last_offered_day=excluded.last_offered_day').run(familyId, childId, memory.id, day);
      return memory;
    },
    sweep() { db.prepare('DELETE FROM memory_continuity WHERE memory_id NOT IN (SELECT id FROM memories) AND family_id NOT IN (SELECT family_id FROM software_profile_memories)').run(); },
  };
}
