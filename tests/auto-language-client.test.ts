import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream';
import { ApiError } from '../apps/web/src/lib/api';
import { modeLabel } from '../apps/web/src/lib/softwareActivities';
import { Home } from '../apps/web/src/components/Home';
import { LanguageClarificationChoices } from '../apps/web/src/components/ConversationTools';
import { isLanguageClarification, languageAnswerContext, recoverExpiredLanguageQuestion, LanguageClarificationSession, LANGUAGE_EXPIRED, LANGUAGE_QUESTION } from '../apps/web/src/lib/languageClarification';
import type { AudioInputMetadata, Bootstrap, Turn } from '../apps/web/src/lib/types';
import type { CallController } from '../apps/web/src/hooks/useCall';

const meaning = '我吃完饭要洗碗。';
const base: Turn = { reply: '好呀，洗好碗就能安心去玩了。', replyId: crypto.randomUUID(), mode: 'live', memoryRevision: 1, globalRevision: 0, speakerRevision: 0, transcript: meaning };
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
const response = (first: unknown, last: unknown) => new Response(frame(first) + frame({ type: 'turn', turn: last }), { headers: { 'content-type': 'application/x-ndjson' } });
const first = { type: 'transcript', text: meaning };

test('an interpreted dialect is identified before its reply is complete and kept on the final turn', async () => {
  const metadata: AudioInputMetadata = { inputSource: 'interpretation', detectedLanguage: 'chaoshan' };
  const details: Turn = { ...base, ...metadata, interpretedText: meaning, conversationMode: { mode: 'auto' } };
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  let notify!: () => void;
  const observed = new Promise<void>(resolve => { notify = resolve; });
  const seen: unknown[] = [];
  let finished = false;
  const pending = readAudioTurnStream(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), (text, data) => {
    seen.push({ text, metadata: data }); notify();
  }).then(value => { finished = true; return value; });
  for (const byte of new TextEncoder().encode(frame({ ...first, ...metadata }))) stream.enqueue(Uint8Array.of(byte));
  await observed;
  assert.equal(finished, false);
  assert.deepEqual(seen, [{ text: meaning, metadata }]);
  stream.enqueue(new TextEncoder().encode(frame({ type: 'turn', turn: details })));
  stream.close();
  assert.deepEqual(await pending, details);
});

test('ordinary transcription and legacy streams remain distinct and compatible', async () => {
  for (const metadata of [undefined, { inputSource: 'transcript', detectedLanguage: 'mandarin' } as const]) {
    const seen: unknown[] = [];
    const details = { ...base, ...metadata };
    assert.deepEqual(await readAudioTurnStream(response({ ...first, ...metadata }, details), (_text, data) => seen.push(data)), details);
    assert.deepEqual(seen, [metadata]);
  }
});

for (const [label, leading, final] of [
  ['changed source', { inputSource: 'interpretation' }, { inputSource: 'transcript' }],
  ['changed dialect', { detectedLanguage: 'chaoshan' }, { detectedLanguage: 'hakka' }],
  ['missing final source', { inputSource: 'interpretation' }, {}],
  ['missing final language', { detectedLanguage: 'hakka' }, {}],
  ['late-only source', {}, { inputSource: 'interpretation' }],
  ['late-only language', {}, { detectedLanguage: 'chaoshan' }],
  ['unknown source', { inputSource: 'guess' }, { inputSource: 'guess' }],
  ['unknown language', { detectedLanguage: 'japanese' }, { detectedLanguage: 'japanese' }],
  ['coerced language', { detectedLanguage: ['hakka'] }, { detectedLanguage: ['hakka'] }],
] as const) {
  test(`a stream rejects ${label} rather than relabelling the displayed speech`, async () => {
    await assert.rejects(readAudioTurnStream(response({ ...first, ...leading }, { ...base, ...final }), () => {}),
      error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
  });
}

test('automatic mode cannot silently carry pure-translation or selected-dialect parameters', async () => {
  for (const extras of [{ dialect: 'hakka' }, { behavior: 'translate' }]) {
    await assert.rejects(readAudioTurnStream(response(first, { ...base, conversationMode: { mode: 'auto', ...extras } }), () => {}),
      error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
  }
  const selected = { ...base, conversationMode: { mode: 'dialect', dialect: 'hakka', behavior: 'translate' } };
  assert.deepEqual(await readAudioTurnStream(response(first, selected), () => {}), selected);
});

test('legacy uncertain-speech errors remain readable without fabricating a transcript', async () => {
  const prompt = '这次还没听清是哪种话，请重新说一次。';
  let called = false;
  const stream = new Response(frame({ type: 'error', error: prompt, code: 'LANGUAGE_UNCERTAIN' }), { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(readAudioTurnStream(stream, () => { called = true; }), error => error instanceof ApiError && error.code === 'LANGUAGE_UNCERTAIN' && error.status === 422 && error.message === prompt);
  assert.equal(called, false);
});

const data: Bootstrap = { configured: true, mode: 'live', capabilities: { chat: true, asr: true, tts: true, voiceprint: false, audioUnderstanding: true, autoLanguage: true }, child: { id: 'fictional', nickname: '虚构用户', ageGroup: '6-8', outfit: 'mint', showCaptions: true, memoryEnabled: true, voiceEnabled: false, sessionMinutes: 10, dailyMinutes: 20 }, parentAuthorized: false, memoryCount: 0, memberCount: 0, globalMemories: [], remainingDailySeconds: 1200 };
function render(element: React.ReactElement) {
  const runtime = globalThis as unknown as { React?: typeof React };
  const previous = runtime.React;
  try { runtime.React = React; return renderToStaticMarkup(element); }
  finally { if (previous) runtime.React = previous; else delete runtime.React; }
}
function home(metadata: Partial<CallController> = {}, bootstrap = data) {
  const noop = () => {};
  const call = { state: 'paused', active: true, call: { id: 'fictional' }, remaining: 300, voiceMode: 'hold', syncReady: true, conversationMode: { mode: 'auto' }, inputText: meaning, inputKind: 'text', replyId: base.replyId, memoryOperations: { operations: [], unresolved: false }, audio: {}, setVoiceMode: noop, setVoiceHolding: noop, setAudioPreparing: noop, setVoiceReady: noop, setError: noop, setState: noop, ...metadata } as unknown as CallController;
  return render(React.createElement(Home, { data: bootstrap, call, onPreference: async () => {} }));
}
function assertClosedLanguageReview(markup: string, label: string) {
  const review = /<details class="transcript-review">[\s\S]*?<\/details>/.exec(markup)?.[0];
  assert.ok(review, 'language metadata is available in a correction detail that starts closed');
  assert.ok(review.includes(`这句识别为${label}`));
  assert.match(review, /<summary>听错了？<\/summary>/);
  assert.doesNotMatch(markup.replace(review, ''), /这句识别为|本轮普通话|本轮潮汕话|本轮客家话|本轮英语/);
}

test('dialect meaning is labelled as an interpretation, shown once, and remains correctable', () => {
  const markup = home({ inputSource: 'interpretation', detectedLanguage: 'chaoshan', interpretedText: meaning });
  assert.match(markup, /我理解的意思/);
  assertClosedLanguageReview(markup, '潮汕话');
  assert.doesNotMatch(markup, /你刚才说|meaning-card/);
  assert.equal(markup.split(meaning).length - 1, 1);
  assert.match(markup, /听错了，改一下/);
  assert.match(markup, /重新说这一句/);
});

test('ordinary and legacy transcriptions keep the original-speech title without an invented dialect', () => {
  const ordinary = home({ inputSource: 'transcript', detectedLanguage: 'mandarin' });
  assert.match(ordinary, /你刚才说/);
  assertClosedLanguageReview(ordinary, '普通话');
  assert.doesNotMatch(ordinary, /我理解的意思/);
  const legacy = home();
  assert.match(legacy, /你刚才说/);
  assert.doesNotMatch(legacy, /这句识别为|本轮普通话|本轮潮汕话|本轮客家话/);
});

test('language settings are absent from both the home page and an active chat', () => {
  assert.equal(modeLabel({ mode: 'auto' }), '自动判断');
  for (const markup of [home(), home({ state: 'idle', active: false, call: null })]) {
    assert.doesNotMatch(markup, /聊天语言|选择聊天语言|mode-entry|home-language-row/);
  }
  assertClosedLanguageReview(home({ detectedLanguage: 'hakka', inputSource: 'interpretation' }), '客家话');
  assertClosedLanguageReview(home({ detectedLanguage: 'english', inputSource: 'transcript' }), '英语');
});

test('only an explicit legacy dialect mode offers one guarded return to chat, without language settings', () => {
  for (const conversationMode of [{ mode: 'auto' }, { mode: 'chat' }] as const) {
    assert.doesNotMatch(home({ conversationMode }), /回到聊天/);
  }
  const conversationMode = { mode: 'dialect', dialect: 'hakka', behavior: 'translate' } as const;
  const markup = home({ conversationMode });
  assert.equal(markup.split('回到聊天').length - 1, 1);
  assert.match(markup, /class="text-button">回到聊天<\/button>/);
  assert.doesNotMatch(markup, /聊天语言|选择聊天语言|mode-entry|home-language-row/);
  for (const busy of [{ state: 'processing' }, { cancelling: true }, { syncReady: false }, { speakerNeedsRejoin: true }] as const) {
    assert.match(home({ conversationMode, ...busy }), /class="text-button" disabled="">回到聊天<\/button>/);
  }
});

const clarification = { id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
const { transcript: _omitted, ...withoutTranscript } = base;
const question: Turn = { ...withoutTranscript, reply: LANGUAGE_QUESTION, languageClarification: clarification, conversationMode: { mode: 'auto' } };
const questionResponse = (turn: unknown = question, suffix = '') => new Response(frame({ type: 'turn', turn }) + suffix, { headers: { 'content-type': 'application/x-ndjson' } });

test('a sole clarification frame asks about the language without inventing an original transcript', async () => {
  let count = 0;
  assert.deepEqual(await readAudioTurnStream(questionResponse(), () => { count++; }), question);
  assert.equal(count, 0);
});

test('English transcripts keep their language metadata on both stream frames', async () => {
  const text = 'My paper plane is on the cupboard.';
  const metadata = { inputSource: 'transcript', detectedLanguage: 'english' } as const;
  const english = { ...base, transcript: text, ...metadata };
  const seen: unknown[] = [];
  assert.deepEqual(await readAudioTurnStream(response({ type: 'transcript', text, ...metadata }, english), (value, details) => seen.push({ value, details })), english);
  assert.deepEqual(seen, [{ value: text, details: metadata }]);
});

for (const [label, extras] of [
  ['original transcript', { transcript: meaning }],
  ['input source', { inputSource: 'transcript' }],
  ['detected language', { detectedLanguage: 'english' }],
  ['guessed interpretation', { interpretedText: meaning }],
  ['invalid speaker state', { speaker: { status: 'administrator' } }],
  ['memory candidate', { candidate: { id: crypto.randomUUID(), content: '英语', key: 'language', kind: 'preference' } }],
  ['ended call', { endCall: true }],
  ['arbitrary question text', { reply: '你是想说英语吧？' }],
  ['invalid question id', { languageClarification: { ...clarification, id: 'not-an-id' } }],
  ['invalid expiry', { languageClarification: { ...clarification, expiresAt: 'tomorrow' } }],
  ['unexpected question fields', { languageClarification: { ...clarification, language: 'english' } }],
] as const) {
  test(`a clarification frame rejects ${label}`, async () => {
    await assert.rejects(readAudioTurnStream(questionResponse({ ...question, ...extras }), () => {}), error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
  });
}

test('a direct normal turn and a clarification following a transcript both fail closed', async () => {
  await assert.rejects(readAudioTurnStream(questionResponse(withoutTranscript), () => {}), error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
  await assert.rejects(readAudioTurnStream(response(first, question), () => {}), error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
});

test('a clarification retains valid speaker protection metadata without a fabricated transcript', async () => {
  for (const speaker of [{ status: 'demo' }, { status: 'unknown' }, { status: 'known', name: '虚构家人' }] as const) {
    const turn = { ...question, speaker };
    assert.deepEqual(await readAudioTurnStream(questionResponse(turn), () => {}), turn);
  }
  const markup = home({ inputText: '', reply: LANGUAGE_QUESTION, languageClarification: clarification, speaker: { status: 'unknown' }, speakerNeedsRejoin: true });
  for (const label of ['普通话', '客家话', '潮汕话', '粤语', '英语']) assert.match(markup, new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
});

test('a clarification must be the unique complete frame, not a prefix for another answer', async () => {
  await assert.rejects(readAudioTurnStream(questionResponse(question, frame(first)), () => {}), error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
  const incomplete = new Response(JSON.stringify({ type: 'turn', turn: question }), { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(readAudioTurnStream(incomplete, () => {}), error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
});

test('an expired clarification error asks for new audio and keeps its 409 status', async () => {
  const result = new Response(frame({ type: 'error', error: LANGUAGE_EXPIRED, code: 'LANGUAGE_CLARIFICATION_EXPIRED' }), { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(readAudioTurnStream(result, () => {}), error => error instanceof ApiError && error.code === 'LANGUAGE_CLARIFICATION_EXPIRED' && error.status === 409 && error.message === LANGUAGE_EXPIRED);
});

test('the language question remains visible with hidden reply captions and has exactly five one-time answers', () => {
  const markup = home({ inputText: '', reply: LANGUAGE_QUESTION, languageClarification: clarification, languageClarificationExpired: false, confirmLanguage: async () => {} }, { ...data, child: { ...data.child!, showCaptions: false } });
  assert.equal(markup.split(LANGUAGE_QUESTION).length - 1, 1);
  assert.match(markup, /回答刚才说的语言/);
  for (const label of ['普通话', '客家话', '潮汕话', '粤语', '英语']) assert.match(markup, new RegExp(`>${label}</button>`));
  assert.equal((markup.match(/>(?:普通话|客家话|潮汕话|粤语|英语)<\/button>/g) ?? []).length, 5);
  assert.doesNotMatch(markup, /transcript-card|我理解的意思|caption-placeholder|听错了，改一下|不满意|聊天语言/);
});

test('one-time answer buttons are disabled during work, expiry and context invalidation', () => {
  for (const options of [{ busy: true, expired: false }, { busy: false, expired: true }]) {
    const markup = render(React.createElement(LanguageClarificationChoices, { clarification, ...options, onConfirm: async () => {} }));
    assert.equal((markup.match(/disabled=""/g) ?? []).length, 5);
    if (options.expired) assert.match(markup, /语音已经过期，请重新说一次/);
  }
  const stale = home({ inputText: '', reply: LANGUAGE_QUESTION, languageClarification: clarification, syncReady: false });
  for (const label of ['普通话', '客家话', '潮汕话', '粤语', '英语']) assert.match(stale, new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
});

test('the photo entry remains available during automatic language chat', () => {
  const markup = home({}, { ...data, capabilities: { ...data.capabilities, vision: true } });
  assert.doesNotMatch(markup, /照片需要普通聊天模式|普通聊天可用/);
  assert.match(markup, /看照片|照片/);
  assert.match(markup, /aria-label="结束聊天"/);
});

test('a language confirmation is consumed once and cannot revive after cancellation or a new question', () => {
  const session = new LanguageClarificationSession();
  const now = Date.now();
  session.offer(clarification, 'call-a', 7);
  assert.deepEqual(session.take(clarification.id, 'english', 'call-a', 7, now), { clarificationId: clarification.id, language: 'english' });
  assert.equal(session.take(clarification.id, 'english', 'call-a', 7, now), undefined);
  session.offer(clarification, 'call-a', 7);
  session.clear();
  assert.equal(session.take(clarification.id, 'mandarin', 'call-a', 7, now), undefined);
  session.offer({ ...clarification, id: crypto.randomUUID() }, 'call-a', 8);
  assert.equal(session.take(clarification.id, 'hakka', 'call-a', 7, now), undefined);
});

test('a language confirmation cannot cross calls, generations, expiry or supported-language boundaries', () => {
  const session = new LanguageClarificationSession();
  session.offer(clarification, 'call-a', 7);
  assert.equal(session.take(clarification.id, 'english', 'call-b', 7), undefined);
  assert.equal(session.take(clarification.id, 'english', 'call-a', 8), undefined);
  assert.equal(session.take(clarification.id, 'french' as never, 'call-a', 7), undefined);
  assert.equal(session.take(clarification.id, 'mandarin', 'call-a', 7, Date.parse(clarification.expiresAt)), undefined);
  assert.equal(session.matches(clarification.id, 'call-a', 7), false);
  assert.equal(isLanguageClarification({ ...clarification, expiresAt: 123 }), false);
  assert.equal(isLanguageClarification(clarification), true);
});

test('language answers keep the original question id in either JSON or multipart audio submissions', () => {
  const context = languageAnswerContext(clarification, false, Date.parse(clarification.expiresAt) - 1);
  assert.deepEqual(context, { clarificationId: clarification.id });
  const body = JSON.parse(JSON.stringify({ text: '我说的是英语', ...context }));
  assert.equal(body.clarificationId, clarification.id);
  const form = new FormData();
  form.append('audio', new Blob(['synthetic-only'], { type: 'audio/wav' }), 'answer.wav');
  if (context) form.append('clarificationId', context.clarificationId);
  assert.equal(form.get('clarificationId'), clarification.id);
  assert.equal(languageAnswerContext(undefined), undefined);
});

test('a voice answer released after its question expires cannot become an ordinary new chat input', () => {
  const deadline = Date.parse(clarification.expiresAt);
  assert.ok(languageAnswerContext(clarification, false, deadline - 30_000));
  for (const now of [deadline, deadline + 1, deadline + 30_000]) {
    assert.throws(() => languageAnswerContext(clarification, false, now), error => error instanceof ApiError && error.code === 'LANGUAGE_CLARIFICATION_EXPIRED' && error.status === 409 && error.message.includes('我来说'));
  }
});

test('an already expired question stays blocked even if the local clock moves back', () => {
  assert.throws(() => languageAnswerContext(clarification, true, Date.parse(clarification.expiresAt) - 1), error => error instanceof ApiError && error.code === 'LANGUAGE_CLARIFICATION_EXPIRED');
});

test('a button confirmation expired in transit restores only its current question, never another task or invalidated context', () => {
  const error = new ApiError(LANGUAGE_EXPIRED, 409, 'LANGUAGE_CLARIFICATION_EXPIRED');
  const context = { question: clarification, callId: 'call-a', generation: 7 };
  const current = { callId: 'call-a', generation: 7 };
  assert.deepEqual(recoverExpiredLanguageQuestion(error, context, current), clarification);
  assert.throws(() => languageAnswerContext(recoverExpiredLanguageQuestion(error, context, current), true), value => value instanceof ApiError && value.code === 'LANGUAGE_CLARIFICATION_EXPIRED');
  assert.equal(recoverExpiredLanguageQuestion(error, undefined, current), undefined);
  assert.equal(recoverExpiredLanguageQuestion(new ApiError('内容已失效', 409, 'CONTEXT_CHANGED'), context, current), undefined);
  assert.equal(recoverExpiredLanguageQuestion(error, context, { ...current, callId: 'call-b' }), undefined);
  assert.equal(recoverExpiredLanguageQuestion(error, context, { ...current, generation: 8 }), undefined);
  assert.equal(recoverExpiredLanguageQuestion(error, context, { ...current, callId: undefined }), undefined);
});

test('a recent voice review is bounded to the final reply, and cannot be forged onto photos or clarification',async()=>{
  const metadata={inputSource:'transcript',detectedLanguage:'mandarin'} as const;
  const audioReview={replyId:base.replyId,expiresAt:new Date(Date.now()+60000).toISOString()};
  const turn={...base,...metadata,audioReview};
  assert.deepEqual(await readAudioTurnStream(response({...first,...metadata},turn),()=>{}),turn);
  for(const review of [{...audioReview,replyId:crypto.randomUUID()},{...audioReview,expiresAt:'tomorrow'},{...audioReview,buffer:'pretend-audio'}]){
    await assert.rejects(readAudioTurnStream(response({...first,...metadata},{...turn,audioReview:review}),()=>{}),error=>error instanceof ApiError&&error.code==='AUDIO_STREAM_INVALID');
  }
  await assert.rejects(readAudioTurnStream(response({...first,...metadata},{...turn,inputKind:'image'}),()=>{}),error=>error instanceof ApiError&&error.code==='AUDIO_STREAM_INVALID');
  assert.match(home({inputSource:'transcript',detectedLanguage:'mandarin',audioReview,retryAudioLanguage:async()=>{}}),/语言认错了/);
  assert.doesNotMatch(home({inputSource:'transcript',detectedLanguage:'mandarin'}),/语言认错了/);
  assert.doesNotMatch(home({inputKind:'image',audioReview}),/语言认错了/);
});
