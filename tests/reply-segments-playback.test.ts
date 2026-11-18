import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { AudioController, type PlaybackResult } from '../apps/web/src/audio.ts';
import { ApiError } from '../apps/web/src/lib/api.ts';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream.ts';
import { createFirstAudioObserver } from '../apps/web/src/lib/clientLatency.ts';
import { fetchReplySpeech, interruptReplyPlayback, presentReplySegmentsWithPlayback, type ReplyReveal } from '../apps/web/src/lib/replyPlayback.ts';
import { LanguageClarificationSession } from '../apps/web/src/lib/languageClarification.ts';
import { replySegmentEmotion, replySegmentsForTurn, validateReplySegments } from '../apps/web/src/lib/replySegments.ts';
import { fetchReplySpeechStream } from '../apps/web/src/lib/speechStream.ts';
import type { ReplySegment, Turn } from '../apps/web/src/lib/types.ts';

const segments: ReplySegment[] = [
  { text: '画了一下午却弄湿了，真扫兴。', expression: 'gentle' },
  { text: '今天不想重画，就先不画了。', expression: 'natural' },
  { text: '想换点事情做的时候，我陪你想。', expression: 'bright' },
];
const reply = segments.map(segment => segment.text).join('\n\n');
const base: Turn = { reply, replySegments: segments, replyId: crypto.randomUUID(), mode: 'live', transcript: '我画了一下午，被水弄湿了。', memoryRevision: 1, globalRevision: 0, speakerRevision: 0 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  let current = true;
  const events: string[] = [], reveals: { text: string; mode: ReplyReveal; expression?: string }[] = [];
  const outputs: ReturnType<typeof deferred<PlaybackResult>>[] = [], starts: (() => void)[] = [];
  const options = {
    reply, segments, isCurrent: () => current,
    playback: (segment: ReplySegment, index: number, onStart: () => void) => {
      events.push(`request:${index}:${segment.expression}`); starts.push(onStart);
      const output = deferred<PlaybackResult>(); outputs.push(output); return output.promise;
    },
    preparing: (index: number) => { events.push(`preparing:${index}`); },
    reveal: (text: string, mode: ReplyReveal, segment?: ReplySegment) => { reveals.push({ text, mode, expression: segment?.expression }); events.push(`reveal:${mode}`); },
    speaking: (index: number) => { events.push(`speaking:${index}`); },
    ready: () => { events.push('ready'); },
    failed: (_error: unknown, afterStart: boolean) => { events.push(`failed:${afterStart}`); },
  };
  return { events, reveals, outputs, starts, options, cancel: () => { current = false; } };
}

function sourceArrow(path: string, name: string) {
  const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrowFunction(node.initializer)) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(file); assert.ok(found, `${name} is wired in ${path}`);
  return found.getText(file);
}

test('an adjustment opened after the first spoken segment captures the full answer before hanging up', async () => {
  const h = harness();
  const call = { reply: '', fullReply: reply, inputKind: 'text', interpretedText: '', inputText: base.transcript, conversationMode: { mode: 'auto' } };
  let draft: { question: string; actualReply: string } | undefined, opened = 0;
  // Execute the actual App callback: its draft must survive openParent ending the call.
  const suggest = new Function('data', 'call', 'parentNavigationBusy', 'setCalibrationDraft', 'openParent', `return ${sourceArrow('../apps/web/src/App.tsx', 'suggestReply')};`)(
    { child: { ageGroup: '6-8' } }, call, { current: false },
    (value: typeof draft) => { draft = value; },
    () => { opened++; h.cancel(); call.reply = ''; call.fullReply = ''; },
  ) as () => void;
  const pending = presentReplySegmentsWithPlayback({ ...h.options, reveal: (text, mode, segment) => { call.reply = text; h.options.reveal(text, mode, segment); } });
  suggest(); assert.equal(opened, 0, 'the complete answer is not an early visible preview');
  h.starts[0]!(); assert.equal(call.reply, segments[0]!.text);
  suggest();
  assert.equal(opened, 1); assert.deepEqual(draft, { question: base.transcript, actualReply: reply, ageGroup: '6-8', title: '聊天回复调整', category: '接话自然度' });
  assert.notEqual(draft?.actualReply, h.reveals[0]!.text);
  h.outputs[0]!.resolve('ended'); await pending; h.starts[0]!();
  assert.equal(h.outputs.length, 1, 'opening adjustment cancels later segments');
  assert.equal(call.reply, ''); assert.equal(call.fullReply, ''); assert.equal(draft?.actualReply, reply);
});

test('an invalidated full answer cannot be reused from a remaining partial subtitle', () => {
  let captured = false;
  const suggest = new Function('data', 'call', 'parentNavigationBusy', 'setCalibrationDraft', 'openParent', `return ${sourceArrow('../apps/web/src/App.tsx', 'suggestReply')};`)(
    { child: { ageGroup: '6-8' } },
    { reply: segments[0]!.text, fullReply: '', inputKind: 'text', inputText: base.transcript, conversationMode: { mode: 'auto' } },
    { current: false }, () => { captured = true; }, () => { throw new Error('invalidated answer opened adjustment'); },
  ) as () => void;
  suggest(); assert.equal(captured, false);
});

test('the hook keeps full-answer state outside progressive reveal and clears it at reply resets', () => {
  const hook = readFileSync(new URL('../apps/web/src/hooks/useCall.ts', import.meta.url), 'utf8');
  const play = sourceArrow('../apps/web/src/hooks/useCall.ts', 'play');
  const accepting = play.indexOf('setFullReply(turn.reply)');
  const currentGuard = play.indexOf('if(!current||!isCurrent())return;');
  assert.ok(currentGuard >= 0 && accepting > currentGuard);
  const prefix = 'const play = ', parsed = ts.createSourceFile('play.ts', `${prefix}${play};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const root = (parsed.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer as ts.ArrowFunction;
  const checkAwait = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return; // Deferred playback callbacks do not suspend the accepting hook.
    if (ts.isAwaitExpression(node)) assert.ok(node.getStart(parsed) >= prefix.length + accepting, 'the current-generation guard and answer capture must be synchronous');
    ts.forEachChild(node, checkAwait);
  };
  checkAwait(root.body);
  assert.doesNotMatch(sourceArrow('../apps/web/src/hooks/useCall.ts', 'reveal'), /setFullReply/, 'cumulative captions cannot replace the accepted full answer');
  assert.match(hook, /return \{state,call,remaining,muted,reply,fullReply,/);
  assert.doesNotMatch(hook, /setReply\(''\);(?!setFullReply\(''\);)/, 'every existing visible-reply reset must clear the complete answer too');
  assert.equal([...hook.matchAll(/setFullReply\(turn\.reply\)/g)].length, 1, 'only the accepted current turn can populate the full answer');
  assert.match(sourceArrow('../apps/web/src/hooks/useCall.ts', 'failed'), /if\(!permitsTextFallback\(err\)\)setFullReply\(''\)/);
  assert.match(sourceArrow('../apps/web/src/hooks/useCall.ts', 'reviseMemory'), /\+\+epoch\.current[\s\S]*setFullReply\(''\)/);
  const nativePicker = hook.slice(hook.indexOf('suspendForNativePicker.current=()=>'), hook.indexOf('const end='));
  assert.match(nativePicker, /interruptReplyPlayback[\s\S]*setFullReply\(''\)/);
});

test('accepts only bounded exact-content plans and copies their text/expression without control fields', () => {
  const parsed = validateReplySegments(reply, segments)!;
  assert.deepEqual(parsed, segments); assert.notEqual(parsed, segments); assert.notEqual(parsed[0], segments[0]);
  assert.deepEqual(replySegmentsForTurn(base), segments);
  assert.deepEqual(['natural', 'bright', 'gentle', 'clear'].map(value => replySegmentEmotion(value as ReplySegment['expression'])), ['warm', 'happy', 'calm', 'thoughtful']);
  assert.equal(validateReplySegments('字'.repeat(600), [{ text: '字'.repeat(600), expression: 'natural' }])?.length, 1);
  assert.equal(validateReplySegments('字'.repeat(601), [{ text: '字'.repeat(601), expression: 'natural' }]), undefined);
});

test('mismatched, unknown, empty and unbounded plans fall back to the complete legacy reply', () => {
  for (const plan of [undefined, null, 'gentle', [], [...segments, segments[0]], [{ text: reply, expression: 'sad' }], [{ text: reply, expression: ['gentle'] }], [{ text: reply, expression: 'gentle', instructions: 'change voice' }], [{ text: ` ${reply}`, expression: 'gentle' }], [{ text: '', expression: 'gentle' }], [{ text: `${reply}\u0000`, expression: 'natural' }], [{ text: '不同正文', expression: 'natural' }]]) {
    assert.equal(replySegmentsForTurn({ ...base, replySegments: plan as ReplySegment[] }), undefined);
  }
  assert.equal(validateReplySegments(reply.replaceAll('\n\n', '\n'), segments), undefined);
});

test('story, learning, translation and language confirmation keep the old one-audio behavior', () => {
  for (const extra of [
    { story: { id: 'story' } }, { learning: { topic: 'english' } },
    { languageClarification: { id: 'question' } }, { conversationMode: { mode: 'dialect', dialect: 'hakka', behavior: 'translate' } },
  ]) assert.equal(replySegmentsForTurn({ ...base, ...extra } as Turn), undefined);
});

test('each real segment start reveals only accumulated text and listening returns once at the end', async () => {
  const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
  assert.deepEqual(h.events, ['preparing:0', 'request:0:gentle']); assert.deepEqual(h.reveals, []);
  for (let index = 0; index < segments.length; index++) {
    assert.equal(h.outputs.length, index + 1, 'a later segment is not prefetched');
    h.starts[index]!(); h.starts[index]!();
    assert.equal(h.reveals.length, index + 1, 'duplicate playing events cannot reveal twice');
    assert.equal(h.reveals[index]!.text, segments.slice(0, index + 1).map(segment => segment.text).join('\n\n'));
    assert.equal(h.reveals[index]!.expression, segments[index]!.expression);
    assert.equal(h.events.includes('ready'), false);
    h.outputs[index]!.resolve('ended'); await tick();
    h.starts[index]!(); // an old onplaying cannot revive the previous segment
    assert.equal(h.reveals.length, index + 1);
  }
  await pending; assert.equal(h.events.filter(event => event === 'ready').length, 1);
  assert.equal(h.reveals.at(-1)!.text, reply);
});

test('text-only devices show the complete reply immediately without fake speech phases', async () => {
  const h = harness();
  await presentReplySegmentsWithPlayback({ ...h.options, playback: undefined });
  assert.deepEqual(h.events, ['reveal:text-only', 'ready']);
  assert.equal(h.reveals[0]!.text, reply);
});

test('a failure before any sound reveals the complete answer and never starts later segments', async () => {
  const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
  h.outputs[0]!.reject(new ApiError('voice unavailable', 502)); await pending;
  h.starts[0]!();
  assert.deepEqual(h.events, ['preparing:0', 'request:0:gentle', 'reveal:text-only', 'failed:false']);
  assert.deepEqual(h.reveals, [{ text: reply, mode: 'text-only', expression: undefined }]);
});

test('partial failure exposes readable remaining text without repeating spoken segments or advancing', async () => {
  for (const startSecond of [false, true]) {
    const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
    h.starts[0]!(); h.outputs[0]!.resolve('ended'); await tick();
    if (startSecond) h.starts[1]!();
    h.outputs[1]!.reject(new Error('audio disconnected')); await pending;
    h.starts[1]!();
    assert.equal(h.outputs.length, 2); assert.equal(h.reveals.at(-1)!.text, reply); assert.equal(h.reveals.at(-1)!.mode, 'text-only');
    assert.equal(h.events.at(-1), 'failed:true'); assert.equal(h.events.includes('ready'), false);
    assert.equal(h.events.filter(event => event.startsWith('request:0')).length, 1);
  }
});

test('silent media ending is a voice failure and does not trigger the next paragraph', async () => {
  const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
  h.outputs[0]!.resolve('ended'); await pending;
  assert.equal(h.outputs.length, 1); assert.equal(h.events.at(-1), 'failed:false'); assert.equal(h.reveals[0]!.text, reply);
});

test('permission/context/expiry rejections never reveal withheld text or remaining segments', async () => {
  for (const error of [new ApiError('changed', 409, 'CONTEXT_CHANGED'), new ApiError('expired', 410, 'REPLY_EXPIRED'), new ApiError('auth', 401), new ApiError('forbidden', 403), new DOMException('cancelled', 'AbortError')]) {
    const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
    h.outputs[0]!.reject(error); await pending; h.starts[0]!();
    assert.deepEqual(h.reveals, []); assert.equal(h.outputs.length, 1); assert.equal(h.events.at(-1), 'failed:false');
  }
});

test('mid-reply context rejection does not display the withheld tail even before invalidation arrives', async () => {
  const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
  h.starts[0]!(); h.outputs[0]!.resolve('ended'); await tick();
  h.outputs[1]!.reject(new ApiError('changed', 409, 'CONTEXT_CHANGED')); await pending; h.starts[1]!();
  assert.equal(h.reveals.length, 1); assert.equal(h.reveals[0]!.text, segments[0]!.text); assert.equal(h.events.at(-1), 'failed:true');
});

test('hangup/retry/replacement drops late audio, publication, errors and further requests', async () => {
  for (const afterFirst of [false, true]) for (const outcome of ['ended', 'failed'] as const) {
    const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
    if (afterFirst) { h.starts[0]!(); h.outputs[0]!.resolve('ended'); await tick(); }
    const currentIndex = afterFirst ? 1 : 0, oldEvents = [...h.events], oldReveals = [...h.reveals];
    h.cancel(); h.starts[currentIndex]!();
    if (outcome === 'ended') h.outputs[currentIndex]!.resolve('ended'); else h.outputs[currentIndex]!.reject(new Error('late failure'));
    await pending;
    assert.deepEqual(h.events, oldEvents); assert.deepEqual(h.reveals, oldReveals); assert.equal(h.outputs.length, currentIndex + 1);
  }
});

test('an explicitly cancelled segment stops the plan without fallback or normal completion', async () => {
  const h = harness(), pending = presentReplySegmentsWithPlayback(h.options);
  h.outputs[0]!.resolve('cancelled'); await pending; h.starts[0]!();
  assert.deepEqual(h.events, ['preparing:0', 'request:0:gentle']); assert.deepEqual(h.reveals, []);
});

test('opening the native picker invalidates a pending TTS download before abort and cannot resume old speech on chooser return', async () => {
  const h = harness(), epoch = { current: 4 }, controller = new AbortController(), request = { current: controller };
  const downloaded = deferred<Response>(); let audioStarts = 0, cancellations = 0, activity = true;
  const current = () => epoch.current === 4;
  const pending = presentReplySegmentsWithPlayback({ ...h.options, isCurrent: current, playback: async (_segment, _index, onStart) => {
    const blob = await fetchReplySpeech('call', base.replyId, controller.signal, 1000, async () => downloaded.promise, undefined, 0);
    if (!current()) return 'cancelled';
    assert.ok(blob.size); audioStarts++; onStart(); return 'ended';
  } });
  // An abort observer is allowed to be synchronous; it must already see the old epoch as invalid.
  controller.signal.addEventListener('abort', () => { assert.equal(current(), false); });
  const change = interruptReplyPlayback({ epoch, request, clearActivity: () => { activity = false; }, cancelAudio: () => { cancellations++; } });
  assert.deepEqual(change, { previousGeneration: 4, generation: 5 });
  downloaded.resolve(new Response('late audio')); await pending;
  assert.equal(audioStarts, 0); assert.equal(cancellations, 1); assert.equal(activity, false);
  assert.deepEqual(h.reveals, []); assert.deepEqual(h.events, ['preparing:0']);
  assert.equal(epoch.current, 5, 'closing or cancelling the chooser never restores the previous epoch');
});

test('native picker interruption stops a spoken plan and a synchronous late start cannot reveal the next paragraph', async () => {
  const h = harness(), epoch = { current: 9 }, controller = new AbortController();
  const pending = presentReplySegmentsWithPlayback({ ...h.options, isCurrent: () => epoch.current === 9 });
  h.starts[0]!(); h.outputs[0]!.resolve('ended'); await tick();
  controller.signal.addEventListener('abort', () => h.starts[1]!());
  interruptReplyPlayback({ epoch, request: { current: controller }, clearActivity() {}, cancelAudio() {} });
  h.outputs[1]!.resolve('cancelled'); await pending; h.starts[1]!();
  assert.equal(h.reveals.length, 1); assert.equal(h.reveals[0]!.text, segments[0]!.text); assert.equal(h.outputs.length, 2);
  assert.equal(h.events.includes('ready'), false);
});

test('a cancelled image chooser can rebind the same pending language question without extending expiry or calling the server', () => {
  const session = new LanguageClarificationSession(), epoch = { current: 7 }, question = { id: crypto.randomUUID(), expiresAt: new Date(2000).toISOString() };
  session.offer(question, 'same-call', epoch.current);
  const { previousGeneration, generation } = interruptReplyPlayback({ epoch, request: { current: null }, clearActivity() {}, cancelAudio() {} });
  assert.equal(session.matches(question.id, 'same-call', previousGeneration), true);
  const rebound = { ...question }; session.offer(rebound, 'same-call', generation);
  assert.equal(session.matches(question.id, 'same-call', previousGeneration), false);
  assert.equal(session.matches(question.id, 'same-call', generation), true); assert.equal(rebound.expiresAt, question.expiresAt);
  assert.deepEqual(session.take(question.id, 'hakka', 'same-call', generation, 1999), { clarificationId: question.id, language: 'hakka' });
  session.offer(rebound, 'same-call', generation);
  assert.equal(session.take(question.id, 'hakka', 'same-call', generation, 2000), undefined);
});

test('first-audio latency is reported only once across paragraph starts and buffering resumes', async () => {
  const h = harness(), observed: unknown[] = [];
  const observer = createFirstAudioObserver({ startedAt: 10, replyId: base.replyId, isCurrent: h.options.isCurrent, now: () => 520, report: async value => { observed.push(value); } });
  const pending = presentReplySegmentsWithPlayback({ ...h.options, speaking: index => { observer(); h.options.speaking(index); } });
  for (let index = 0; index < segments.length; index++) { h.starts[index]!(); h.starts[index]!(); h.outputs[index]!.resolve('ended'); await tick(); }
  await pending;
  assert.deepEqual(observed, [{ replyId: base.replyId, milliseconds: 510 }]);
});

test('both speech transports send only registered reply ID and bounded segment index', async () => {
  const sent: unknown[] = [];
  const request: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    if (new Headers(init?.headers).get('accept') === 'application/x-ndjson') return new Response([
      { type: 'format', format: 'pcm_s16le', sampleRate: 24000, channels: 1 }, { type: 'audio', data: 'AQI=' }, { type: 'done' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
    return new Response('audio');
  };
  await fetchReplySpeech('call', base.replyId, undefined, 100, request, undefined, 1);
  for await (const _chunk of fetchReplySpeechStream('call', base.replyId, undefined, 100, request, undefined, 2)) { /* consume synthetic PCM */ }
  assert.deepEqual(sent, [{ replyId: base.replyId, segmentIndex: 1 }, { replyId: base.replyId, segmentIndex: 2 }]);
  for (const invalid of [-1, 3, 1.5, NaN, Infinity]) {
    await assert.rejects(fetchReplySpeech('call', base.replyId, undefined, 100, request, undefined, invalid), /段落无效/);
    await assert.rejects(async () => { for await (const _chunk of fetchReplySpeechStream('call', base.replyId, undefined, 100, request, undefined, invalid)) { /* unreachable */ } }, /段落无效/);
  }
  assert.equal(sent.length, 2, 'invalid indices never reach the server');
});

test('audio turn parser keeps valid plans but discards malformed plans without corrupting complete reply', async () => {
  const frame = (turn: unknown) => new Response(JSON.stringify({ type: 'transcript', text: base.transcript }) + '\n' + JSON.stringify({ type: 'turn', turn }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  assert.deepEqual(await readAudioTurnStream(frame(base), () => {}), base);
  for (const plan of [[{ text: 'wrong', expression: 'gentle' }], [{ text: reply, expression: 'natural', tts: 'untrusted' }], 'wrong', [], [...segments, segments[0]]]) {
    const parsed = await readAudioTurnStream(frame({ ...base, replySegments: plan }), () => {});
    assert.equal(parsed.reply, reply); assert.equal(parsed.replySegments, undefined);
  }
});

test('a spoken image-language confirmation preserves its original image and speech provenance through segmented playback', async () => {
  for (const [inputSource, detectedLanguage] of [['transcript', 'english'], ['interpretation', 'hakka']] as const) {
    const turn: Turn = { ...base, inputKind: 'image', inputSource, detectedLanguage,
      ...(inputSource === 'interpretation' ? { interpretedText: base.transcript } : {}) };
    const first = { type: 'transcript', text: turn.transcript, inputSource, detectedLanguage };
    const body = JSON.stringify(first) + '\n' + JSON.stringify({ type: 'turn', turn }) + '\n';
    const seen: unknown[] = [];
    const parsed = await readAudioTurnStream(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), (text, metadata) => seen.push({ text, ...metadata }));
    assert.deepEqual(parsed, turn);
    assert.deepEqual(seen, [{ text: turn.transcript, inputSource, detectedLanguage }]);
    const h = harness(), plan = replySegmentsForTurn(parsed)!;
    const pending = presentReplySegmentsWithPlayback({ ...h.options, reply: parsed.reply, segments: plan });
    assert.deepEqual(h.reveals, []);
    for (let index = 0; index < plan.length; index++) { h.starts[index]!(); h.outputs[index]!.resolve('ended'); await tick(); }
    await pending;
    assert.equal(h.reveals.at(-1)!.text, parsed.reply); assert.equal(parsed.inputKind, 'image');
    assert.equal(parsed.inputSource, inputSource); assert.equal(parsed.detectedLanguage, detectedLanguage);
  }
});

test('an image marker cannot hide a changed transcript source or carry a coerced input kind', async () => {
  const first = { type: 'transcript', text: base.transcript, inputSource: 'interpretation', detectedLanguage: 'chaoshan' };
  for (const changes of [{ inputKind: ['image'] }, { inputKind: 'text' }, { inputKind: 'video' }, { inputSource: 'transcript' }, { detectedLanguage: 'english' }]) {
    const turn = { ...base, inputKind: 'image', inputSource: 'interpretation', detectedLanguage: 'chaoshan', interpretedText: base.transcript, ...changes };
    const body = JSON.stringify(first) + '\n' + JSON.stringify({ type: 'turn', turn }) + '\n';
    await assert.rejects(readAudioTurnStream(new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }), () => {}),
      error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
  }
});

test('actual media activity stops in the gap while subtitles and delivery wait for the next playing event', async () => {
  const elements: HTMLAudioElement[] = [], activities: boolean[] = [], h = harness();
  const audio = new AudioController({ createAudioElement: () => {
    const element = { onplaying: null, onwaiting: null, onpause: null, onended: null, onerror: null, play: async () => {}, pause() {}, removeAttribute() {}, load() {} } as unknown as HTMLAudioElement;
    elements.push(element); return element;
  }, createObjectURL: () => 'blob:synthetic-only', revokeObjectURL() {} });
  const pending = presentReplySegmentsWithPlayback({ ...h.options, playback: (_segment, _index, onStart) => audio.playBlob(new Blob(['synthetic']), { onStart, onActivityChange: value => activities.push(value) }) });
  for (let index = 0; index < segments.length; index++) {
    const element = elements[index]!;
    assert.equal(h.reveals.length, index); assert.equal(activities.at(-1) ?? false, false);
    element.onplaying?.call(element, new Event('playing'));
    assert.equal(h.reveals.length, index + 1); assert.equal(activities.at(-1), true);
    element.onwaiting?.call(element, new Event('waiting')); assert.equal(activities.at(-1), false);
    element.onplaying?.call(element, new Event('playing')); assert.equal(h.reveals.length, index + 1);
    element.onended?.call(element, new Event('ended')); await tick();
    assert.equal(activities.at(-1), false);
  }
  await pending; assert.equal(h.events.at(-1), 'ready'); audio.dispose();
});
