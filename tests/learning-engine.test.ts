import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningEngine } from '../apps/server/src/learning-engine.js';

const context = { ageGroup: '9-12' as const, remainingSeconds: 600 };
const input = (text: string, callId = 'one') => ({ ...context, text, callId });
function solve(question: string, answer: string) {
  const engine = createLearningEngine();
  const first = engine.handle(input(question));
  assert.equal(first?.learning?.stage, 'confirm');
  engine.handle(input('确认题目'));
  return engine.handle(input(answer));
}

test('arithmetic requires question confirmation and does not disclose answer first', () => {
  const engine = createLearningEngine();
  const first = engine.handle(input('帮我算3+5'));
  assert.equal(first?.learning?.question, '3+5等于多少');
  assert.doesNotMatch(first!.reply, /得到8|答案.*8/);
  assert.match(engine.handle(input('8'))!.reply, /先确认题目/);
  assert.equal(engine.handle(input('确认'))?.learning?.stage, 'attempt');
  assert.equal(engine.handle(input('8'))?.learning?.stage, 'finished');
});

test('precedence and left association are exact rather than numeric guesswork', () => {
  assert.equal(solve('3+4×2', '11')?.learning?.stage, 'finished');
  assert.equal(solve('12÷3×2', '8')?.learning?.stage, 'finished');
  assert.equal(solve('8-3-2', '3')?.learning?.stage, 'finished');
  assert.equal(solve('-5+3', '-2')?.learning?.stage, 'finished');
});

test('decimal arithmetic has no binary float error and recurring values accept fractions', () => {
  assert.equal(solve('0.1+0.2', '0.3')?.learning?.stage, 'finished');
  assert.equal(solve('1÷3', '1/3')?.learning?.stage, 'finished');
  assert.notEqual(solve('1÷3', '0.333333')?.learning?.stage, 'finished');
});

test('spoken Chinese numbers and operation names parse without embedding a supplied answer', () => {
  assert.equal(solve('帮我算一下三加五', '八')?.learning?.stage, 'finished');
  assert.equal(solve('十二乘以三', '三十六')?.learning?.stage, 'finished');
  assert.equal(solve('零点一加零点二', '零点三')?.learning?.stage, 'finished');
  assert.equal(solve('宝妍，算一下三加五等于多少？'.replace('，', ''), '八')?.learning?.stage, 'finished');
});

test('one explanation step is given at a time, with no automatic full solution', () => {
  const engine = createLearningEngine();
  engine.handle(input('3+4×2')); engine.control('one', 'confirm', context);
  const first = engine.control('one', 'explain', context);
  assert.equal(first.learning?.step, 1);
  assert.match(first.reply, /先算4乘2/);
  assert.doesNotMatch(first.reply, /得到11/);
  const second = engine.control('one', 'next', context);
  assert.match(second.reply, /先算3加8/);
  assert.equal(second.learning?.stage, 'finished');
});

test('wrong answer gets a method hint without affirming or silently marking correct', () => {
  const engine = createLearningEngine();
  engine.handle(input('3+5')); engine.control('one', 'confirm', context);
  const wrong = engine.handle(input('9'));
  assert.match(wrong!.reply, /还没有.*吻合/);
  assert.equal(wrong?.learning?.stage, 'attempt');
  assert.doesNotMatch(wrong!.reply, /得到8/);
});

test('correcting question replaces old answer and asks confirmation again', () => {
  const engine = createLearningEngine();
  engine.handle(input('3+5')); engine.control('one', 'confirm', context);
  assert.equal(engine.handle(input('题目改成3+6'))?.learning?.stage, 'confirm');
  engine.control('one', 'confirm', context);
  assert.notEqual(engine.handle(input('8'))?.learning?.stage, 'finished');
  assert.equal(engine.handle(input('9'))?.learning?.stage, 'finished');
});

test('unsupported correction clears old exercise instead of continuing obsolete problem', () => {
  const engine = createLearningEngine();
  engine.handle(input('3+5'));
  assert.match(engine.handle(input('题目改成解方程x+3=5'))!.reply, /超出/);
  assert.equal(engine.state('one'), undefined);
});

test('division by zero, parentheses, too many values and equations are explicitly unsupported', () => {
  const engine = createLearningEngine();
  for (const question of ['算1÷0', '计算(3+5)×2', '1+2+3+4+5+6', '解方程x+3=5', '数学题：求积分']) assert.match(engine.handle(input(question))!.reply, /超出/, question);
});

test('very young group stays within small integer addition and subtraction', () => {
  const engine = createLearningEngine();
  assert.equal(engine.handle({ ...input('2+3'), ageGroup: '3-5' })?.learning?.stage, 'confirm');
  assert.match(engine.handle({ ...input('20+3'), ageGroup: '3-5' })!.reply, /超出/);
  assert.match(engine.handle({ ...input('3×4'), ageGroup: '3-5' })!.reply, /超出/);
});

test('single-step unit conversion uses exact ratios across length mass and time', () => {
  assert.equal(solve('3米等于多少厘米', '300厘米')?.learning?.stage, 'finished');
  assert.equal(solve('500克等于多少千克', '0.5千克')?.learning?.stage, 'finished');
  assert.equal(solve('1.5小时等于多少分钟', '90分钟')?.learning?.stage, 'finished');
  assert.equal(solve('三米换成厘米', '三百')?.learning?.stage, 'finished');
});

test('cross-dimensional conversion does not invent an answer', () => {
  const engine = createLearningEngine();
  assert.match(engine.handle(input('单位换算3米等于多少秒'))!.reply, /超出/);
  assert.equal(engine.state('one'), undefined);
  assert.match(engine.handle(input('3米等于多少秒'))!.reply, /超出/);
});

test('unit answer must use the requested unit rather than merely matching the number', () => {
  const engine = createLearningEngine();
  engine.handle(input('3米等于多少厘米')); engine.control('one', 'confirm', context);
  assert.match(engine.handle(input('300米'))!.reply, /答案单位/);
  assert.equal(engine.state('one')?.stage, 'attempt');
  assert.equal(engine.handle(input('300厘米'))?.learning?.stage, 'finished');
  assert.equal(solve('500克等于多少千克', '0.5公斤')?.learning?.stage, 'finished');
});

test('English and Chinese presets are actual answerable fixed exercises', () => {
  const english = createLearningEngine();
  assert.match(english.handle(input('学习：english'))!.reply, /cat/);
  english.control('one', 'confirm', context);
  assert.equal(english.handle(input('猫'))?.learning?.stage, 'finished');
  const chinese = createLearningEngine();
  assert.match(chinese.handle(input('学习：chinese'))!.reply, /反义词/);
  chinese.control('one', 'confirm', context);
  assert.equal(chinese.handle(input('小'))?.learning?.stage, 'finished');
});

test('similar exercise keeps topic and asks new confirmation', () => {
  const engine = createLearningEngine();
  engine.handle(input('学习：english')); engine.control('one', 'confirm', context); engine.handle(input('猫'));
  const similar = engine.handle(input('再来一道同类题'));
  assert.match(similar!.reply, /dog/);
  assert.equal(similar?.learning?.stage, 'confirm');
});

test('pause retains question and no answer advances until resumed', () => {
  const engine = createLearningEngine();
  engine.handle(input('3+5')); engine.control('one', 'confirm', context); engine.cancel('one');
  assert.equal(engine.state('one')?.stage, 'paused');
  assert.match(engine.handle(input('8'))!.reply, /还在暂停/);
  engine.control('one', 'resume', context);
  assert.equal(engine.state('one')?.stage, 'attempt');
  assert.equal(engine.handle(input('8'))?.learning?.stage, 'finished');
});

test('stop cannot be resumed and repeat keeps progress unchanged', () => {
  const engine = createLearningEngine();
  engine.handle(input('3+4×2')); engine.control('one', 'confirm', context); engine.control('one', 'explain', context);
  assert.match(engine.control('one', 'repeat', context).reply, /3\+4×2/);
  assert.equal(engine.state('one')?.step, 1);
  engine.control('one', 'stop', context);
  assert.match(engine.control('one', 'resume', context).reply, /已经结束/);
});

test('exercise replacement and similar question do not extend the original call deadline', () => {
  let time = 1000;
  const engine = createLearningEngine({ now: () => time });
  engine.handle({ ...input('3+5'), remainingSeconds: 30 });
  time = 2000; engine.handle(input('题目改成3+6'));
  assert.equal(engine.state('one')?.endsAt, 31000);
  engine.control('one', 'confirm', context); engine.handle(input('9'));
  time = 3000; engine.control('one', 'similar', context);
  assert.equal(engine.state('one')?.endsAt, 31000);
  time = 31000; assert.match(engine.control('one', 'confirm', context).reply, /时间到了/);
});

test('zero nonfinite or elapsed time cannot be used to bypass expiry', () => {
  const engine = createLearningEngine();
  for (const remainingSeconds of [0, -1, NaN, Infinity]) assert.match(engine.handle({ ...input('学习：arithmetic'), remainingSeconds })!.reply, /时间到了/);
  assert.equal(engine.state('one'), undefined);
});

test('checkpoint restores question and step for input correction without cross-call leakage', () => {
  const engine = createLearningEngine();
  engine.handle(input('3+4×2', 'a')); engine.control('a', 'confirm', context);
  const snapshot = JSON.parse(JSON.stringify(engine.checkpoint('a')));
  engine.control('a', 'explain', context); engine.restore('a', snapshot);
  assert.equal(engine.state('a')?.step, 0);
  assert.equal(engine.state('a')?.stage, 'attempt');
  assert.equal(engine.state('b'), undefined);
  engine.handle(input('学习：english', 'b')); engine.clear('a');
  assert.equal(engine.state('b')?.topic, 'english');
});

test('ordinary conversation remains available while a lesson is open', () => {
  const engine = createLearningEngine();
  engine.handle(input('学习：english')); engine.control('one', 'confirm', context);
  assert.equal(engine.handle(input('今天我有点累')), undefined);
  assert.equal(engine.handle(input('我是谁')), undefined);
  assert.equal(engine.state('one')?.stage, 'attempt');
});
