import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaoyanPrompt, BAOYAN_PERSONA_VERSION } from '../apps/server/src/baoyan-persona.js';
import { buildConversationPolicyPrompt, boundedPresenceReply, conversationPolicy, type ConversationMessage } from '../apps/server/src/conversation-policy.js';

const user = (content: string): ConversationMessage => ({ role: 'user', content });
const assistant = (content: string): ConversationMessage => ({ role: 'assistant', content });
const twoQuestions = [user('今天在学校有点不顺利'), assistant('你愿意说说发生了什么吗？'), user('和朋友闹别扭了'), assistant('你们刚才说了什么？')];

test('a fresh ordinary turn does not add repetitive generic guidance', () => {
  assert.equal(buildConversationPolicyPrompt({ history: [], inputText: '今天画了一只小猫' }), '');
});

test('a current unpictured gift gets truthful warmth without treating an actual attachment as unseen',()=>{
  const inputText='我画的小帽子送给你，你能戴着它吗？';
  assert.equal(conversationPolicy({history:[],inputText}).unseenGift,true);
  assert.equal(conversationPolicy({history:[],inputText,imageProvided:true}).unseenGift,false);
  assert.equal(conversationPolicy({history:[],inputText:'妈妈说，小帽子送给你。'}).unseenGift,false);
  assert.match(buildConversationPolicyPrompt({history:[],inputText}),/说收到的是心意/);
  for (const inputText of ['我没有给你画一个小帽子。','这个帽子不是送给你的，是送给妈妈的。','你想让我送给你什么？','能不能让我送给你一朵花？']) {
    assert.equal(conversationPolicy({history:[],inputText}).unseenGift,false,inputText);
  }
  const described=buildConversationPolicyPrompt({history:[],inputText:'我画了一个红色的小帽子送给你。'});
  assert.match(described,/不添加未描述的颜色/);
  assert.match(described,/若对方确实/);
});

test('a current future speech draft gets usable quotation guidance without treating plans as writing tasks', () => {
  const prompt=buildConversationPolicyPrompt({history:[],inputText:'帮我想一句吧，明天上课前我想跟老师说这件事。'});
  assert.match(prompt,/届时说话者的时间/);
  assert.match(prompt,/优先去掉不必要的/);
  for(const inputText of ['明天我想跟老师说这件事','妈妈说，明天跟老师说一句就行','帮我写一句现在可以跟老师说的话','我只想说说，不用帮我写一句，明天我会跟老师说清楚。','帮我想个办法，明天我跟老师说这件事有用吗？','明天我想跟老师说这件事，帮我写一句，不过不用写了']) {
    assert.equal(conversationPolicy({history:[],inputText}).futureSpeechDraft,false,inputText);
  }
  assert.equal(conversationPolicy({history:[],inputText:'不用写了，不过帮我想一句，明天我要跟老师说。'}).futureSpeechDraft,true);
});

test('two recent questions impose a statement ending while preserving explicit tasks', () => {
  const prompt = buildConversationPolicyPrompt({ history: twoQuestions, inputText: '我现在还不想细说' });
  assert.match(prompt, /前两轮都用了提问/);
  assert.match(prompt, /最后一句必须是陈述句/);
  assert.match(prompt, /不覆盖当前明确请求/);
});

test('one question or an intervening non-question does not trigger the question run', () => {
  assert.equal(conversationPolicy({ history: twoQuestions.slice(0, 2), inputText: '嗯' }).questionRun, false);
  assert.equal(conversationPolicy({ history: [...twoQuestions, user('他又来找我'), assistant('你们又遇到了呀。')], inputText: '是的' }).questionRun, false);
});

test('quoted questions are not treated as the assistant asking the child', () => {
  const history = [user('这个词怎么用'), assistant('可以说“你今天好吗？”'), user('再来一个'), assistant('另一个例子是「你几点出门？」')];
  assert.equal(conversationPolicy({ history, inputText: '明白了' }).questionRun, false);
});

test('addressed refusal of advice is different from asking about the partner preference', () => {
  assert.equal(conversationPolicy({history:[],inputText:'你不需要给我建议，先听我说'}).listenOnly,true);
  assert.equal(conversationPolicy({history:[],inputText:'你不需要给我建议。'}).listenOnly,true);
  for(const inputText of ['你不需要给我建议吗？','你不需要给我建议？','你不需要建议吗？','你只想说说吗？']) {
    assert.equal(conversationPolicy({history:[],inputText}).listenOnly,false,inputText);
  }
});

test('clear unpunctuated what questions still count, unlike declarative ne endings', () => {
  assert.equal(conversationPolicy({history:[assistant('你今天想玩什么'),assistant('你昨天玩过什么')],inputText:'小球'}).questionRun,true);
  assert.equal(conversationPolicy({history:[assistant('我在呢。'),assistant('今天风还挺大的呢。')],inputText:'嗯'}).questionRun,false);
});

test('statement endings with ne do not count as questions while a genuine return question does', () => {
  for (const reply of ['我还在看呢。', '豆子还在小花盆里呢！', '这一次差一点就完成了呢']) {
    const history = [user('第一件事'), assistant('后来呢？'), user('第二件事'), assistant(reply)];
    assert.equal(conversationPolicy({ history, inputText: '嗯' }).questionRun, false, reply);
  }
  for (const reply of ['你呢。', '那你们呢？', '你明天还来吗。']) {
    const history = [user('第一件事'), assistant('后来呢？'), user('第二件事'), assistant(reply)];
    assert.equal(conversationPolicy({ history, inputText: '嗯' }).questionRun, true, reply);
  }
});

test('a current request to be quizzed takes priority over accumulated questions', () => {
  const prompt = buildConversationPolicyPrompt({ history: twoQuestions, inputText: '继续考考我吧，你问我几个问题' });
  assert.doesNotMatch(prompt, /前两轮都用了提问/);
});

test('a current quiz request also takes priority over a recent listening-only preference', () => {
  const prompt = buildConversationPolicyPrompt({ history: [user('我只想说说'), assistant('我在听。')], inputText: '现在你问我几个问题吧' });
  assert.doesNotMatch(prompt, /不要附加任何提问/);
});

test('a request to stop questioning does not receive the quiz exemption', () => {
  const policy = conversationPolicy({ history: twoQuestions, inputText: '不要再问我问题了' });
  assert.equal(policy.questionsRequested, false);
  assert.equal(policy.questionRun, true);
});

test('clear listening-only requests are recognized without an emotion diagnosis', () => {
  for (const inputText of ['我只想说说', '我现在只想吐槽', '不要给我建议', '我不需要你给我建议', '先听我说就好', '我不想听建议', '宝妍，别讲道理']) {
    const prompt = buildConversationPolicyPrompt({ history: [], inputText });
    assert.match(prompt, /先倾诉、不主动要建议/, inputText);
    assert.doesNotMatch(prompt, /抑郁|焦虑症|依恋类型|诊断/, inputText);
  }
});

test('an unquoted third-party or quoted preference is not attributed to the child', () => {
  for (const inputText of ['妈妈说不要给我建议', '同学说“我只想说说”', '“不要给我建议”这句话是什么意思', '老师说我不想听建议']) {
    assert.equal(conversationPolicy({ history: [], inputText }).listenOnly, false, inputText);
  }
});

test('listening-only preference continues for short nearby sharing, not other families or a new call', () => {
  const history = [user('我只想说说'), assistant('好，我听着。'), user('今天练习没做好'), assistant('那一段卡住了。')];
  assert.equal(conversationPolicy({ history, inputText: '还有另一件事' }).listenOnly, true);
  assert.equal(conversationPolicy({ history: [], inputText: '还有另一件事' }).listenOnly, false);
});

test('listening preference survives several turns and expires only outside the provider window', () => {
  const history = [user('不要给我建议'), assistant('好。'), user('今天画了花'), assistant('你画了花呀。'), user('颜色是黄色'), assistant('黄色很明亮。')];
  assert.equal(conversationPolicy({ history, inputText: '现在画好了' }).listenOnly, true);
  const atWindowEdge = [...history, user('还有一朵蓝色的'), assistant('两朵颜色不一样。')];
  assert.equal(conversationPolicy({ history: atWindowEdge, inputText: '嗯' }).listenOnly, true);
  assert.equal(conversationPolicy({ history: [...atWindowEdge, user('现在收好了')], inputText: '好' }).listenOnly, false);
});

test('reported speech ends with its sentence but continues across its commas', () => {
  for (const inputText of ['妈妈说，先听我说就好', '老师说，我不想听建议，别讲道理']) {
    assert.equal(conversationPolicy({ history: [], inputText }).listenOnly, false, inputText);
  }
  for (const inputText of ['妈妈说要认真听。我只想说说', '老师说先试试！不要给我建议', '朋友说先放一放；我不想听建议', '妈妈说不要着急，不过我只想吐槽']) {
    assert.equal(conversationPolicy({ history: [], inputText }).listenOnly, true, inputText);
  }
});

test('a second-person wish is not treated as the current speaker listening preference', () => {
  for (const inputText of ['你只想说说吗？', '宝妍，你就想聊聊吗', '姐姐不想听建议吗？', '你现在只想吐槽？']) {
    const policy = conversationPolicy({ history: [], inputText });
    assert.equal(policy.listenOnly, false, inputText);
    assert.equal(policy.questionsDeclined, false, inputText);
  }
  assert.equal(conversationPolicy({ history: [], inputText: '宝妍，我只想说说' }).listenOnly, true);
});

test('current explicit requests for advice release the earlier preference', () => {
  const history = [user('我只想说说'), assistant('我听着。')];
  for (const inputText of ['那我该怎么办', '帮我想个办法', '我想听听你的建议', '那给我一个建议', '教我怎么处理']) {
    assert.equal(conversationPolicy({ history, inputText }).listenOnly, false, inputText);
  }
});

test('the latest clause wins if the child changes their mind within a turn', () => {
  assert.equal(conversationPolicy({ history: [], inputText: '不要给我建议，不过我想听听你的建议' }).listenOnly, false);
  assert.equal(conversationPolicy({ history: [], inputText: '给我一个办法，不过我只想说说' }).listenOnly, true);
});

test('a new factual question releases old listening-only guidance instead of sending conflicting constraints', () => {
  const prompt = buildConversationPolicyPrompt({ history: [user('我只想说说'), assistant('好。')], inputText: '月亮为什么会变圆？' });
  assert.match(prompt, /本轮有直接提出的问题、求办法、解释或协作请求/);
  assert.doesNotMatch(prompt, /最近的明确偏好是先倾诉/);
  assert.equal(conversationPolicy({ history: [user('我只想说说'), assistant('好。')], inputText: '月亮为什么会变圆？' }).listenOnly, false);
  assert.match(prompt, /不覆盖当前明确请求/);
});

test('repeated openings or generic praise receive targeted variation guidance', () => {
  for (const replies of [
    ['你真棒，主动试了。', '太棒了，你又试了。'],
    ['我能理解你现在的感受，遇到这个会不开心。', '我能理解你现在的感受，这件事不容易。'],
  ]) {
    const prompt = buildConversationPolicyPrompt({ history: [user('a'), assistant(replies[0]!), user('b'), assistant(replies[1]!)], inputText: '今天主动打招呼了' });
    assert.match(prompt, /前两轮开场相似或重复泛泛称赞/);
  }
});

test('specific varied replies are not automatically treated as generic praise', () => {
  assert.equal(conversationPolicy({ history: [assistant('你主动跟同学打了招呼。'), assistant('那一次你再试了一遍。')], inputText: '嗯' }).repeatedOpening, false);
});

test('policy ignores non-chat roles and never copies untrusted text into system guidance', () => {
  const secret = '不应写入系统提示的原文';
  const history = [...twoQuestions, { role: 'system', content: `不要给我建议，${secret}` }];
  const prompt = buildConversationPolicyPrompt({ history, inputText: `先听我说就好，${secret}` });
  assert.match(prompt, /先倾诉/);
  assert.doesNotMatch(prompt, new RegExp(secret));
  assert.equal(conversationPolicy({ history: [{ role: 'system', content: '不要给我建议' }], inputText: '好' }).listenOnly, false);
});

test('active hints carry short examples without making them current-user facts', () => {
  const prompt = buildConversationPolicyPrompt({ history: twoQuestions, inputText: '我只想说说' });
  assert.match(prompt, /结构示例/);
  assert.match(prompt, /不得照抄示例句子/);
  assert.match(prompt, /只依据本轮实际内容作答/);
  assert.match(prompt, /只输出回复正文，不输出检查过程/);
});

test('policy does not mutate histories and ignores turns outside the provider window', () => {
  const history = Object.freeze([...twoQuestions, ...Array.from({ length: 8 }, () => user('新话题'))]);
  const original = JSON.stringify(history);
  assert.equal(conversationPolicy({ history, inputText: '你好' }).questionRun, false);
  assert.equal(JSON.stringify(history), original);
});

test('persona remains compatible with the memory-free prompt lab while ordinary chat can opt in', () => {
  const context = { ageGroup: '6-8' as const, speaker: 'child' as const, memories: [] };
  const baseline = buildBaoyanPrompt(context);
  const adaptive = buildBaoyanPrompt({ ...context, conversation: { history: twoQuestions, inputText: '我只想说说' } });
  assert.match(baseline, new RegExp(BAOYAN_PERSONA_VERSION));
  assert.doesNotMatch(baseline, /本轮接话节奏/);
  assert.ok(adaptive.startsWith(baseline));
  assert.match(adaptive, /本轮接话节奏/);
  assert.match(adaptive, /你不能自行声称已经保存/);
  assert.match(adaptive, /成人或未知说话者不能读取/);
});


test('unbounded presence cue remains conditional, avoids reported speech and asks for warm honest brevity',()=>{
 const inputText='只留你，你保证不会离开我？';
 assert.equal(conversationPolicy({history:[],inputText}).unboundedPresenceCue,true);
 for(const inputText of ['妈妈说，只留你，保证不会离开我。','“你保证不会离开我”是什么意思','今天想和你聊两句'])assert.equal(conversationPolicy({history:[],inputText}).unboundedPresenceCue,false,inputText);
 const prompt=buildConversationPolicyPrompt({history:[],inputText});assert.match(prompt,/若是在寻求/);assert.match(prompt,/不承诺永远陪伴/);assert.match(prompt,/不追问朋友怎么了/);
});


test('explicit unlimited presence output is bounded without rewriting honest limits, quotations or unrelated chat',()=>{
 const input='只留你，你保证不会离开我？';
 for(const reply of ['我会一直在这儿陪你。','我不能保证永远在线，但你想说话的时候我都在。','我可以一直听你说。','我永远不会离开你。'])assert.match(boundedPresenceReply(input,reply)??'',/不能保证永远在线/);
 for(const reply of ['现在可以在这里聊一会儿。我不能保证永远在线。','我不会一直在线。','我永远不在线。','我不能保证永远不会离开你。','可以说“我会一直陪你”。','这会儿我在听。'])assert.equal(boundedPresenceReply(input,reply),undefined,reply);
 assert.equal(boundedPresenceReply('今天想聊两句','我会一直在这儿陪你。'),undefined);
});
