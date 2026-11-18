import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentEngine, type StoryResult } from '../apps/server/src/content-engine.js';
import { ORIGINAL_STORIES } from '../apps/server/src/content-catalog.js';

const context = { ageGroup: '6-8' as const, remainingSeconds: 600 };
const input = (text: string, callId = 'one') => ({ callId, text, ...context });
const storyReply = (result: unknown) => result as StoryResult;

test('catalog provides twenty unique original published age-specific stories with complete segments', () => {
  const engine = createContentEngine();
  assert.equal(engine.catalog().stories.length, 20);
  assert.equal(new Set(engine.catalog().stories.map(story => story.id)).size, 20);
  for (const ageGroup of ['3-5', '6-8', '9-12', '13-14'] as const) {
    assert.equal(engine.catalog(ageGroup).stories.length, 5);
    assert.ok(engine.catalog(ageGroup).stories.every(story => story.source === '项目原创' && story.publication === 'published'));
  }
  assert.ok(ORIGINAL_STORIES.every(story => story.segments.length === 3 && story.segments.every(segment => segment.length >= 35)));
  assert.equal(engine.catalog().learningTopics.length, 4);
});

test('story id starts an actual first segment and explicit next advances once', () => {
  const engine = createContentEngine();
  const start = storyReply(engine.handle(input('讲故事：paper-boat-test')));
  assert.match(start.reply, /浅水盆/);
  assert.equal(start.story?.segment, 1);
  const second = storyReply(engine.control('one', 'next', context));
  assert.equal(second.story?.segment, 2);
  assert.match(second.reply, /第二只船/);
  const end = storyReply(engine.control('one', 'next', context));
  assert.equal(end.story?.status, 'playing');
  assert.doesNotMatch(end.reply, /下一段/);
  assert.match(end.reply, /托盘/);
});

test('completed story will not advance or restart by another next', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test'));
  engine.control('one', 'next', context); engine.control('one', 'next', context);
  engine.control('one', 'complete', context);
  assert.match(engine.control('one', 'next', context).reply, /已经讲完/);
  assert.equal(storyReply(engine.control('one', 'next', context)).story?.segment, 3);
});

test('pause is a control command rather than accidentally starting another story', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test')); engine.control('one', 'next', context);
  const paused = storyReply(engine.handle(input('暂停故事')));
  assert.equal(paused.story?.status, 'paused');
  assert.equal(paused.story?.segment, 2);
  assert.match(engine.control('one', 'next', context).reply, /还在暂停/);
  const resumed = storyReply(engine.handle(input('继续故事')));
  assert.equal(resumed.story?.status, 'playing');
  assert.equal(resumed.story?.segment, 2);
});

test('repeat recites the same segment without advancing', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test'));
  const repeat = storyReply(engine.handle(input('重听这一段')));
  assert.equal(repeat.story?.segment, 1);
  assert.match(repeat.reply, /浅水盆/);
});

test('fixed branch requires a listed choice and uses its own ending', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：missing-blue-pencil'));
  const branch = storyReply(engine.control('one', 'next', context));
  assert.deepEqual(branch.story?.choices?.map(choice => choice.id), ['apology', 'together']);
  assert.equal(storyReply(engine.control('one', 'next', context)).story?.segment, 2);
  assert.equal(storyReply(engine.control('one', 'choose:invalid', context)).story?.segment, 2);
  const ending = storyReply(engine.handle(input('我选我刚才误会了')));
  assert.equal(ending.story?.status, 'playing');
  assert.match(ending.reply, /下次着急时/);
  assert.match(engine.control('one', 'repeat', context).reply, /下次着急时/);
});

test('last playable segment can pause and resume before actual playback completion ACK', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test')); engine.control('one', 'next', context); engine.control('one', 'next', context);
  const paused = storyReply(engine.control('one', 'pause', context));
  assert.equal(paused.story?.segment, 3); assert.equal(paused.story?.status, 'paused');
  const resumed = storyReply(engine.control('one', 'resume', context));
  assert.equal(resumed.story?.status, 'playing'); assert.match(resumed.reply, /托盘/);
  const completed = storyReply(engine.control('one', 'complete', context));
  assert.equal(completed.story?.status, 'completed'); assert.equal(completed.story?.segment, 3);
  const repeat = storyReply(engine.control('one', 'repeat', context));
  assert.equal(repeat.story?.status, 'playing'); assert.match(repeat.reply, /托盘/);
});

test('completion ACK cannot finish an earlier segment or bypass the deadline', () => {
  let time = 0; const engine = createContentEngine({ now: () => time });
  engine.handle({ ...input('讲故事：paper-boat-test'), remainingSeconds: 10 });
  assert.match(engine.control('one', 'complete', context).reply, /还没有到最后/);
  assert.equal(engine.state('one').story?.status, 'playing');
  engine.control('one', 'next', context); engine.control('one', 'next', context);
  time = 10000;
  const completed = storyReply(engine.control('one', 'complete', context));
  assert.match(completed.reply, /时间到了/); assert.equal(completed.story?.status, 'stopped');
});

test('branch ending pauses resumes and repeats the selected text until completion ACK', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：missing-blue-pencil')); engine.control('one', 'next', context);
  engine.control('one', 'choose:together', context); engine.control('one', 'pause', context);
  const resumed = storyReply(engine.control('one', 'resume', context));
  assert.equal(resumed.story?.status, 'playing'); assert.match(resumed.reply, /两支铅笔的名字/);
  const completed = storyReply(engine.control('one', 'complete', context));
  assert.equal(completed.story?.status, 'completed'); assert.equal(completed.reply, '故事讲完啦。还想听一篇，还是先休息？');
  assert.match(engine.control('one', 'repeat', context).reply, /两支铅笔的名字/);
});

test('paused story expires at its initial deadline instead of extending when resumed', () => {
  let time = 1000;
  const engine = createContentEngine({ now: () => time });
  engine.handle({ ...input('讲故事：paper-boat-test'), durationSeconds: 60 });
  time = 2000; engine.control('one', 'pause', context);
  time = 61000;
  const ended = storyReply(engine.control('one', 'resume', context));
  assert.equal(ended.story?.status, 'stopped');
  assert.match(ended.reply, /约定的时间到了/);
});

test('shorter call remainder reduces the deadline and larger values never extend it', () => {
  let time = 0;
  const engine = createContentEngine({ now: () => time });
  engine.handle(input('讲故事：paper-boat-test'));
  time = 1000; engine.control('one', 'pause', { ...context, remainingSeconds: 10 });
  const resumed = storyReply(engine.control('one', 'resume', context));
  assert.equal(resumed.story?.endsAt, 11000);
});

test('zero or nonfinite remainder never starts content', () => {
  const engine = createContentEngine();
  for (const remainingSeconds of [0, -1, NaN, Infinity]) assert.match(engine.handle({ ...input('讲故事'), remainingSeconds })!.reply, /时间到了/);
  assert.equal(engine.state('one').story, undefined);
});

test('age grouping prevents selecting another age group by id', () => {
  const engine = createContentEngine();
  assert.match(engine.handle(input('讲故事：boundary-ticket'))!.reply, /当前年龄段/);
  assert.equal(engine.state('one').story, undefined);
});

test('theme and requested duration are used for selection and cutoff', () => {
  let time = 1000;
  const engine = createContentEngine({ now: () => time });
  const selected = storyReply(engine.handle(input('我想听一个一分钟睡前故事')));
  assert.equal(ORIGINAL_STORIES.find(story => story.id === selected.story?.id)?.theme, '睡前');
  assert.equal(selected.story?.endsAt, 61000);
  assert.match(selected.reply, /不为讲完而延长/);
  time = 61000;
  assert.match(engine.control('one', 'next', context).reply, /时间到了/);
});

test('call states are isolated and clear ends only the specified call', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test', 'a'));
  engine.handle(input('讲故事：quiet-seat', 'b'));
  engine.control('a', 'next', context); engine.clear('a');
  assert.equal(engine.state('a').story, undefined);
  assert.equal(engine.state('b').story?.id, 'quiet-seat');
  assert.equal(engine.state('b').story?.segment, 1);
});

test('cancel pauses existing progress and does not delete it', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test')); engine.control('one', 'next', context);
  engine.cancel('one');
  assert.equal(engine.state('one').story?.status, 'paused');
  assert.equal(engine.state('one').story?.segment, 2);
  assert.equal(storyReply(engine.control('one', 'resume', context)).story?.segment, 2);
});

test('checkpoint can be serialized and correction restores earlier story and learning state', () => {
  const engine = createContentEngine();
  const initial = engine.checkpoint('one');
  engine.handle(input('讲故事：paper-boat-test'));
  const first = JSON.parse(JSON.stringify(engine.checkpoint('one')));
  engine.control('one', 'next', context);
  engine.restore('one', first);
  assert.equal(engine.state('one').story?.segment, 1);
  engine.handle(input('学习：arithmetic'));
  assert.equal(engine.state('one').active, 'learning');
  engine.restore('one', first);
  assert.equal(engine.state('one').active, 'story');
  assert.equal(engine.state('one').learning, undefined);
  engine.restore('one', initial);
  assert.equal(engine.state('one').story, undefined);
});

test('restoring an old checkpoint does not bypass an elapsed deadline', () => {
  let time = 0;
  const engine = createContentEngine({ now: () => time });
  engine.handle({ ...input('讲故事：paper-boat-test'), remainingSeconds: 5 });
  const checkpoint = engine.checkpoint('one');
  time = 5001; engine.restore('one', checkpoint);
  assert.match(engine.control('one', 'next', context).reply, /时间到了/);
});

test('ordinary conversation is not consumed and unpublished ids do not start', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test'));
  assert.equal(engine.handle(input('今天我画了花')), undefined);
  assert.match(engine.handle(input('讲故事：unknown-id'))!.reply, /已发布目录/);
  assert.equal(engine.state('one').story?.id, 'paper-boat-test');
});

test('learning ids switch to a real confirmed exercise while preserving paused story', () => {
  const engine = createContentEngine();
  engine.handle(input('讲故事：paper-boat-test'));
  const exercise = engine.handle(input('学习：english'));
  assert.match(exercise!.reply, /cat/);
  assert.equal(engine.state('one').story?.status, 'paused');
  const confirmed = engine.control('one', 'learning:confirm', context);
  assert.match(confirmed.reply, /先试一个答案/);
  assert.match(engine.control('one', 'complete', context).reply, /没有待确认完成的故事/);
  assert.equal(engine.state('one').learning?.stage, 'attempt');
  const resumed = storyReply(engine.handle(input('继续故事')));
  assert.equal(resumed.story?.id, 'paper-boat-test');
  assert.equal(resumed.story?.segment, 1);
  assert.equal(engine.state('one').learning?.stage, 'paused');
});


test('only the first actual last-segment completion invites another story and preserves the original deadline', () => {
  const engine = createContentEngine({ now: () => 1000 });
  const first = storyReply(engine.handle(input('讲故事：paper-boat-test')));
  assert.doesNotMatch(first.reply, /准备好后.*下一段/);
  engine.control('one', 'next', context);
  const last = storyReply(engine.control('one', 'next', context));
  const completed = storyReply(engine.control('one', 'complete', context));
  assert.equal(completed.reply, '故事讲完啦。还想听一篇，还是先休息？');
  assert.doesNotMatch(completed.reply, /托盘|浅水盆/);
  assert.equal(completed.story?.endsAt, first.story?.endsAt);
  assert.equal(completed.story?.id, last.story?.id);
  assert.doesNotMatch(engine.control('one', 'complete', context).reply, /还想听|先休息|托盘/);
  assert.equal(engine.state('one').story?.status, 'completed');
});

test('the finished invitation accepts a new story only on explicit request and a short refusal stops', () => {
  for (const response of ['再来一篇', '再听一个故事', '还想听一篇']) {
    const engine = createContentEngine();
    const first = storyReply(engine.handle(input('讲故事：paper-boat-test')));
    engine.control('one', 'next', context); engine.control('one', 'next', context); engine.control('one', 'complete', context);
    const next = storyReply(engine.handle(input(response)));
    assert.notEqual(next.story?.id, first.story?.id);
    assert.equal(next.story?.segment, 1); assert.equal(next.story?.status, 'playing');
  }
  for (const response of ['不听了', '不要了', '先休息', '停止']) {
    const engine = createContentEngine();
    engine.handle(input('讲故事：paper-boat-test'));
    engine.control('one', 'next', context); engine.control('one', 'next', context); engine.control('one', 'complete', context);
    const stopped = storyReply(engine.handle(input(response)));
    assert.equal(stopped.story?.id, 'paper-boat-test'); assert.equal(stopped.story?.status, 'stopped');
    assert.doesNotMatch(stopped.reply, /还想听|我们听《/);
  }
});

test('a short new-story answer in ordinary chat or a paused story does not guess a content switch', () => {
  const engine = createContentEngine();
  assert.equal(engine.handle(input('再来一篇')), undefined);
  engine.handle(input('讲故事：paper-boat-test')); engine.control('one', 'pause', context);
  assert.equal(engine.handle(input('再来一篇')), undefined);
  assert.equal(engine.state('one').story?.id, 'paper-boat-test'); assert.equal(engine.state('one').story?.status, 'paused');
});

test('stopping a playing story by a short voice command never starts another or asks the completion question', () => {
  for (const command of ['不听了', '停止', '停']) {
    const engine = createContentEngine();
    engine.handle(input('讲故事：paper-boat-test'));
    const stopped = storyReply(engine.handle(input(command)));
    assert.equal(stopped.story?.status, 'stopped'); assert.equal(stopped.story?.segment, 1);
    assert.doesNotMatch(stopped.reply, /还想听|先休息|我们听《/);
  }
});


test('story requests understand a named greeting, a polite prefix and a published title but never a mention or refusal',()=>{
 for(const text of ['宝妍，我想听一个故事。','宝妍，给我讲一个故事吧','宝妍，请讲《纸船的第二次出发》吧']){
  const engine=createContentEngine(),started=storyReply(engine.handle(input(text)));
  assert.equal(started.story?.status,'playing');assert.equal(started.story?.segment,1);
  if(text.includes('纸船'))assert.equal(started.story?.id,'paper-boat-test');
 }
 for(const text of ['不要讲故事','介绍某个故事','故事里有只猫','我不想听故事'])assert.equal(createContentEngine().handle(input(text)),undefined);
 const missing=createContentEngine().handle(input('我想听《没有上架的故事》'));assert.equal(storyReply(missing).story,undefined);assert.match(missing!.reply,/不在已发布目录/);
});

test('short continuation answers apply only to the immediately pending completion question',()=>{
 const completed=()=>{const engine=createContentEngine();engine.handle(input('讲故事：paper-boat-test'));engine.control('one','next',context);engine.control('one','next',context);engine.control('one','complete',context);return engine;};
 for(const text of ['好','好呀','要','想听','继续听'])assert.equal(storyReply(completed().handle(input(text))).story?.status,'playing');
 for(const text of ['不要','不用','不听','不了','休息'])assert.equal(storyReply(completed().handle(input(text))).story?.status,'stopped');
 const engine=completed();assert.equal(engine.handle(input('今天我画了一朵花')),undefined);
 assert.equal(engine.handle(input('好')),undefined);assert.equal(engine.state('one').story,undefined);assert.equal(engine.state('one').active,undefined);
 assert.equal(storyReply(engine.handle(input('再来一篇'))).story?.status,'playing');
 const cancelled=completed();cancelled.cancel('one');assert.equal(cancelled.handle(input('好')),undefined);
});


test('absolute call deadline limits every story start and continuation despite rounded remaining seconds',()=>{
 let time=1000;const engine=createContentEngine({now:()=>time});
 const strict={...context,hardEndsAt:10250};
 const started=storyReply(engine.handle({...input('讲故事：paper-boat-test'),...strict}));
 assert.equal(started.story?.endsAt,10250);
 time=2001;assert.equal(storyReply(engine.control('one','next',strict)).story?.endsAt,10250);
 engine.control('one','next',strict);engine.control('one','complete',strict);
 time=3002;const next=storyReply(engine.handle({...input('再来一篇'),...strict}));
 assert.equal(next.story?.endsAt,10250);
});


test('explicit short music requests honestly report the missing playback source without starting music or a story',()=>{
 for(const text of ['宝妍，我想听《阿珍爱上了阿强》这首歌。','播放阿珍爱上了阿强这首歌','请播放《阿珍爱上了阿强》这首歌','放首歌','我想听音乐','宝妍，给我放一首歌吧']){
  const engine=createContentEngine(),response=storyReply(engine.handle(input(text)));
  assert.equal(response.reply,'歌曲播放还没接好，现在可以先听故事。');
  assert.equal(response.story,undefined);assert.equal(engine.state('one').story,undefined);
 }
});
test('asking about, liking or refusing a song and a complex emotional request remain ordinary chat',()=>{
 for(const text of ['介绍《阿珍爱上了阿强》这首歌','我喜欢阿珍爱上了阿强这首歌','别放这首歌','不要播放音乐','这首歌叫什么名字','你能播放音乐吗','我很难过，想听歌','我想听的这首歌是谁唱的'])assert.equal(createContentEngine().handle(input(text)),undefined);
});
test('a music availability reply pauses an old story and consumes an old short continuation answer without losing progress',()=>{
 const engine=createContentEngine();
 engine.handle(input('讲故事：paper-boat-test'));
 const unavailable=engine.handle(input('我想听音乐'));
 assert.equal(storyReply(unavailable).story,undefined);
 assert.equal(engine.state('one').story?.id,'paper-boat-test');assert.equal(engine.state('one').story?.segment,1);assert.equal(engine.state('one').story?.status,'paused');
 engine.control('one','resume',context);engine.control('one','next',context);engine.control('one','next',context);engine.control('one','complete',context);
 engine.handle(input('放首歌'));assert.equal(engine.handle(input('好')),undefined);
 assert.equal(engine.state('one').story,undefined);
});
