import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Home } from '../apps/web/src/components/Home';
import { UsageTaskCounts } from '../apps/web/src/components/ParentSoftware';
import type { CallController } from '../apps/web/src/hooks/useCall';
import type { Bootstrap, Trial } from '../apps/web/src/lib/types';

// These are layout-only renders; ignore stylesheet modules without mounting effects or making requests.
register('data:text/javascript,' + encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
  return nextLoad(url, context);
}`), import.meta.url);
const { ParentNavigation, ParentPanel } = await import('../apps/web/src/components/ParentPanel');
const { App, TrialNotice, TrialExperienceDetails } = await import('../apps/web/src/App');

const noop = () => {};
const data: Bootstrap = { configured: true, mode: 'live', capabilities: { chat: true, asr: true, tts: true, voiceprint: true, vision: true, autoLanguage: true }, child: { id: 'fictional', nickname: '虚构用户', ageGroup: '6-8', outfit: 'mint', showCaptions: true, memoryEnabled: true, voiceEnabled: true, sessionMinutes: 10, dailyMinutes: 20 }, parentAuthorized: true, memoryCount: 0, memberCount: 0, globalMemories: [], remainingDailySeconds: 1200 };
const trial: Trial = { enabled: true, requiresInvite: false, expiresAt: '2026-10-26T12:54:09Z', maxSessionMinutes: 10, maxDailyMinutes: 20 };
function render(element: React.ReactElement) {
  const runtime = globalThis as unknown as { React?: typeof React };
  const before = runtime.React;
  try { runtime.React = React; return renderToStaticMarkup(element); }
  finally { if (before) runtime.React = before; else delete runtime.React; }
}
function home(changes: Partial<CallController> = {}, bootstrap = data) {
  const call = { state: 'paused', active: true, call: { id: 'fictional' }, remaining: 300, voiceMode: 'hold', syncReady: true, muted: false, conversationMode: { mode: 'auto' }, memoryOperations: { operations: [], unresolved: false }, audio: {}, setVoiceMode: noop, setVoiceHolding: noop, setAudioPreparing: noop, setVoiceReady: noop, setError: noop, setState: noop, ...changes } as unknown as CallController;
  return render(React.createElement(Home, { data: bootstrap, call, onPreference: async () => {} }));
}
function primaryVoiceButton(markup: string) {
  const controls = markup.match(/<button[^>]*class="[^"]*\bvoice-primary-action\b[^"]*"[^>]*>/g) ?? [];
  assert.ok(controls.length <= 1, 'only one primary microphone action may be rendered');
  return controls[0];
}
function holdButton(markup: string) {
  const controls = markup.match(/<button[^>]*class="[^"]*\bhold-to-talk-button\b[^"]*"[^>]*>/g) ?? [];
  assert.equal(controls.length, 1, 'keep the press session mounted, including while its recording converts');
  return controls[0]!;
}

test('the single trial notice retains adult fictional scope and opens the same detail in resting and active views', () => {
  for (const companion of [true, false]) {
    const markup = render(React.createElement(TrialNotice, { companion, onOpen: noop }));
    assert.equal(markup.split('朋友内测').length - 1, 1);
    assert.equal((markup.match(/<button /g) ?? []).length, 1);
    assert.match(markup, /请由成年人使用虚构资料体验/);
    assert.match(markup, /体验说明/);
    assert.doesNotMatch(markup, /mode-badge|<details/);
  }
  const active = render(React.createElement(TrialNotice, { compact: true, onOpen: noop }));
  assert.match(active, /aria-label="体验说明：成年人使用虚构资料"/);
  assert.equal((active.match(/<button /g) ?? []).length, 1);
  const expired = render(React.createElement(TrialNotice, { expired: true, onOpen: noop }));
  assert.match(expired, /本轮内测已结束|聊天已暂停/);
});

test('trial details still explain consent scope, deadline, usage limits and editable automatic memory', () => {
  const markup = render(React.createElement(TrialExperienceDetails, { trial }));
  for (const expected of ['请由成年人使用虚构资料体验', '不填写真实儿童信息', '单次最多 10 分钟', '每日最多 20 分钟', '暂离页面会结束通话', '专属记忆默认开启', '可查看、修改和删除', 'AI 小姐姐']) assert.ok(markup.includes(expected), expected);
  assert.match(markup, /2026/);
});

test('hold is directly available while listening, while paused or automatic speech has just one primary action', () => {
  const hold = home({ state: 'listening' });
  assert.equal(primaryVoiceButton(hold), undefined);
  assert.doesNotMatch(holdButton(hold), /disabled=/);
  assert.doesNotMatch(hold, /aria-label="开始说话"|aria-label="暂停收音"|aria-label="我来说"/);
  assert.match(hold, /换成自由说/);
  const paused = home(), automatic = home({ state: 'listening', voiceMode: 'auto' });
  assert.match(primaryVoiceButton(paused)!, /aria-label="开始说话"/);
  assert.match(paused, /<div hidden=""><div class="hold-to-talk">/);
  assert.match(holdButton(paused), /disabled=""/);
  assert.match(primaryVoiceButton(automatic)!, /aria-label="暂停收音"/);
  assert.doesNotMatch(automatic, /hold-to-talk-button|finish-utterance/);
  assert.match(automatic, /换成按住说/);
  assert.match(primaryVoiceButton(home({ voiceMode: 'auto' }))!, /aria-label="开始说话"/);
  assert.match(primaryVoiceButton(home({ state: 'listening', muted: true }))!, /aria-label="开始说话"/);
  for (const markup of [paused, automatic, hold]) {
    assert.doesNotMatch(markup, /compact-resume|>开麦<|>关麦<|aria-label="打开麦克风"|aria-label="关闭麦克风"/);
    assert.doesNotMatch(markup, /voice-mode-selector|聊天设置/);
    assert.match(markup, /aria-label="结束聊天"/);
    assert.match(markup, /选择说话、照片或打字/);
  }
});

test('working speech offers cancellation instead of a second start action, without unmounting pending press conversion', () => {
  for (const changes of [{ state: 'processing' }, { state: 'speaking' }, { state: 'connecting' }, { state: 'listening', audioPreparing: true }] as const) {
    const markup = home(changes), action = primaryVoiceButton(markup)!;
    assert.match(action, changes.state === 'connecting' ? /aria-label="取消连接"/ : /aria-label="我来说"/);
    assert.doesNotMatch(action, /disabled=""/);
    assert.doesNotMatch(markup, /aria-label="开始说话"|aria-label="暂停收音"/);
    assert.match(markup, /<div hidden=""><div class="hold-to-talk">/);
    holdButton(markup);
    for (const blocking of [{ memoryPending: true }, { cancelling: true }]) {
      assert.match(primaryVoiceButton(home({ ...changes, ...blocking }))!, /disabled=""/);
    }
  }
});

test('microphone resume and hold capture cannot bypass identity, memory, cancellation or synchronization guards', () => {
  for (const changes of [{ speakerNeedsRejoin: true }, { memoryPending: true }, { cancelling: true }, { syncReady: false }] as const) {
    assert.match(primaryVoiceButton(home(changes))!, /aria-label="开始说话"[^>]*disabled=""/);
    assert.match(holdButton(home({ state: 'listening', ...changes })), /disabled=""/);
    assert.match(primaryVoiceButton(home({ voiceMode: 'auto', ...changes }))!, /disabled=""/);
  }
  const holding = home({ state: 'listening', voiceHolding: true, voiceReady: true });
  assert.equal(primaryVoiceButton(holding), undefined, 'holding cannot swap its pointer target for a second control');
  assert.doesNotMatch(holdButton(holding), /disabled=""/);
  assert.match(holding, /class="text-button voice-mode-toggle" disabled=""/);
  const text = home({}, { ...data, capabilities: { ...data.capabilities, asr: false } });
  assert.doesNotMatch(text, /aria-label="开始说话"|aria-label="暂停收音"/);
  assert.match(text, /call-controls without-microphone/);
  assert.match(text, /id="chat-message"/);
});

test('reply dissatisfaction, language clarification cancellation and legacy dialect exit remain reachable', () => {
  const call = { state: 'paused', active: true, call: { id: 'fictional' }, remaining: 300, voiceMode: 'hold', syncReady: true, conversationMode: { mode: 'auto' }, inputKind: 'text', inputText: '我画的小猫歪了。', reply: '画了好久，有点烦了吧。', fullReply: '画了好久，有点烦了吧。', memoryOperations: { operations: [], unresolved: false }, audio: {}, setVoiceMode: noop, setVoiceHolding: noop, setAudioPreparing: noop, setVoiceReady: noop, setError: noop, setState: noop } as unknown as CallController;
  const markup = render(React.createElement(Home, { data, call, onPreference: async () => {}, onSuggestReply: noop }));
  assert.match(markup, /这条回答不满意 · 家长调整/);
  const clarifying = home({ languageClarification: { id: '00000000-0000-4000-8000-000000000001', expiresAt: '2026-10-26T12:54:09Z' } });
  assert.match(primaryVoiceButton(clarifying)!, /aria-label="我来说"/);
  assert.doesNotMatch(primaryVoiceButton(clarifying)!, /disabled=""/);
  assert.match(home({ conversationMode: { mode: 'dialect', dialect: 'hakka', behavior: 'translate' } }), /回到聊天/);
});

test('per-turn language and correction guidance are available inside a closed detail while the transcript stays visible', () => {
  const markup = home({ inputText: '我准备吃饭。', inputKind: 'text', inputSource: 'interpretation', detectedLanguage: 'chaoshan', replyId: 'fictional-reply' });
  const detail = /<details class="transcript-review">[\s\S]*?<\/details>/.exec(markup)?.[0];
  assert.ok(detail, 'correction detail starts closed');
  assert.match(detail, /<summary>听错了？<\/summary>/);
  for (const text of ['这句识别为潮汕话', '听错了，改一下', '重新说这一句', '这是语音理解的意思']) assert.ok(detail.includes(text), text);
  assert.match(markup.replace(detail, ''), /我理解的意思[\s\S]*?我准备吃饭。/);
  assert.doesNotMatch(markup.replace(detail, ''), /这句识别为|语言认错了|听错了，改一下|这是语音理解的意思/);
});

test('hidden captions retain an immediate way to read a reply when audio is unavailable without reopening chat settings', () => {
  const markup = home({ reply: '我陪你想一想。', replyTextOnly: true }, { ...data, child: { ...data.child!, showCaptions: false } });
  assert.match(markup, /声音暂不可用，可点下方显示文字/);
  assert.match(markup, /<button[^>]*>显示宝妍回复<\/button>/);
  assert.doesNotMatch(markup, /聊天设置|chat-settings|input-settings/);
});

test('the default shell offers more without keeping the internal debug entry on the homepage', () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerHeight: 844 } });
    const markup = render(React.createElement(App));
    assert.match(markup, /class="more-entry" aria-label="更多"/);
    assert.doesNotMatch(markup, /debug-entry|内测调试|type="password"/);
    assert.match(markup, /问题反馈/);
  } finally {
    if (before) Object.defineProperty(globalThis, 'window', before);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('parent navigation exposes four daily groups and keeps both test entries in a closed secondary menu', () => {
  const markup = render(React.createElement(ParentNavigation, { tab: 'overview', busy: false, onSelect: noop }));
  const primary = /<nav class="parent-primary-nav"[\s\S]*?<\/nav>/.exec(markup)?.[0] ?? '';
  assert.equal((primary.match(/<button /g) ?? []).length, 4);
  for (const label of ['账号与家庭', '使用与时限', '记忆小本', '资料与授权']) assert.ok(primary.includes(label), label);
  assert.doesNotMatch(primary, /三天体验记录|回答调整与场景库/);
  assert.match(markup, /<details class="parent-test-menu">/);
  assert.match(markup, /三天体验记录|回答调整与场景库/);
  assert.match(markup, /独立内测调试另行保存/);
});

test('an incoming dissatisfaction draft opens its existing natural-language adjustment and secondary menu', () => {
  const markup = render(React.createElement(ParentPanel, { data, initialCalibrationDraft: { question: '我画的小猫歪了。', actualReply: '继续努力。', guideline: '先接住具体感受。', ageGroup: '6-8' }, onBusyChange: noop, onChild: noop, onClose: noop, onWithdraw: noop, onSessionChange: noop }));
  assert.match(markup, /<details class="parent-test-menu" open="">/);
  assert.match(markup, /改回答/);
  assert.match(markup, /我的场景库/);
  assert.match(markup, /我画的小猫歪了/);
  assert.doesNotMatch(markup, /旧提示词编辑器/);
  const busy = render(React.createElement(ParentNavigation, { tab: 'family', busy: true, onSelect: noop }));
  assert.equal((busy.match(/disabled=""/g) ?? []).length, 6);
});

test('empty former activities vanish from default statistics and existing counts remain in a closed history', () => {
  const counts = { chat: 7, dialect: 2, story: 0, learning: 0 };
  const empty = render(React.createElement(UsageTaskCounts, { counts }));
  assert.match(empty, /陪伴聊天 <strong>7|家乡话理解 <strong>2/);
  assert.doesNotMatch(empty, /听故事|一起学|查看旧栏目记录/);
  for (const previous of [{ ...counts, story: 3 }, { ...counts, learning: 4 }, { ...counts, story: 3, learning: 4 }]) {
    const markup = render(React.createElement(UsageTaskCounts, { counts: previous }));
    assert.match(markup, /<details class="past-activity-counts">/);
    assert.match(markup, /查看旧栏目记录/);
    assert.equal(markup.includes('听故事'), previous.story > 0);
    assert.equal(markup.includes('一起学'), previous.learning > 0);
    assert.deepEqual(previous, { ...counts, story: previous.story, learning: previous.learning });
  }
});
