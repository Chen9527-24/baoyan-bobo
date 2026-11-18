import test from 'node:test';
import assert from 'node:assert/strict';
import { readAudioTurnStream } from '../apps/web/src/lib/audioTurnStream.ts';
import { ApiError } from '../apps/web/src/lib/api.ts';

const transcript = '我说：今天想画一朵花🌸。';
const turn = { reply: '好呀，我们先画花瓣。', replyId: 'a33435b7-1c60-4c48-94d1-2e78b6a9b873', mode: 'live', memoryRevision: 1, globalRevision: 1, speakerRevision: 0, transcript };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const transcriptLine = line({ type: 'transcript', text: transcript });
const turnLine = line({ type: 'turn', turn });
const response = (body: string, headers = { 'Content-Type': 'application/x-ndjson' }) => new Response(body, { headers });

test('transcript callback runs before final response arrives, across fragmented UTF-8 and CRLF', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  const seen: string[] = []; let finished = false;
  let observed!: () => void; const ready = new Promise<void>(resolve => { observed = resolve; });
  const result = readAudioTurnStream(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } }), text => {
    seen.push(text); observed();
  }).then(value => { finished = true; return value; });
  const bytes = new TextEncoder().encode(transcriptLine.replace(/\n$/, '\r\n'));
  for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
  await ready; assert.deepEqual(seen, [transcript]); assert.equal(finished, false);
  stream.enqueue(new TextEncoder().encode(turnLine)); stream.close();
  assert.deepEqual(await result, turn);
});

test('validated optional candidate, speaker and endCall are retained', async () => {
  const details = { ...turn, candidate: { id: crypto.randomUUID(), content: '我喜欢花', key: 'personal.flower', kind: 'preference', action: 'forget', memoryId: crypto.randomUUID() }, speaker: { status: 'demo', name: '妈妈' }, endCall: true };
  assert.deepEqual(await readAudioTurnStream(response(transcriptLine + line({ type: 'turn', turn: details })), () => {}), details);
});

for (const [label, body] of Object.entries({
  'missing final frame': transcriptLine,
  'missing final newline': transcriptLine + turnLine.trimEnd(),
  'turn before transcript': turnLine,
  'duplicate transcript': transcriptLine + transcriptLine + turnLine,
  'duplicate turn': transcriptLine + turnLine + turnLine,
  'trailing unknown frame': transcriptLine + turnLine + line({ type: 'noop' }),
  'unknown frame': line({ type: 'audio', data: 'untrusted' }),
  'extra frame property': line({ type: 'transcript', text: transcript, html: '<script>bad()</script>' }),
  'prototype key': '{"type":"transcript","text":"hello","__proto__":{"polluted":true}}\n',
  'mismatched transcript': transcriptLine + line({ type: 'turn', turn: { ...turn, transcript: '别人说的话' } }),
  'invalid turn': transcriptLine + line({ type: 'turn', turn: { ...turn, memoryRevision: -1 } }),
  'coerced mode': transcriptLine + line({ type: 'turn', turn: { ...turn, mode: ['live'] } }),
  'nested malicious candidate': transcriptLine + line({ type: 'turn', turn: { ...turn, candidate: { id: crypto.randomUUID(), content: '花', key: 'x', kind: ['preference'] } } }),
  'oversized transcript': line({ type: 'transcript', text: '字'.repeat(1001) }),
  'oversized unterminated line': 'x'.repeat(17 * 1024),
  'oversized multibyte line': '字'.repeat(6000),
  'oversized response': 'x'.repeat(33 * 1024),
  'malformed JSON': '{"type":\n',
})) {
  test(`rejects ${label}`, async () => {
    await assert.rejects(readAudioTurnStream(response(body), () => {}), error => error instanceof ApiError && error.code === 'AUDIO_STREAM_INVALID');
  });
}

test('stream error preserves safe message and context status after showing transcript', async () => {
  const seen: string[] = [];
  await assert.rejects(readAudioTurnStream(response(transcriptLine + line({ type: 'error', error: '内容已失效，请重新发起', code: 'CONTEXT_CHANGED' })), text => seen.push(text)),
    error => error instanceof ApiError && error.status === 409 && error.code === 'CONTEXT_CHANGED');
  assert.deepEqual(seen, [transcript]);
});

test('ordinary JSON HTTP error is preserved without firing transcript callback', async () => {
  let called = false;
  await assert.rejects(readAudioTurnStream(Response.json({ error: '本次通话已结束，请重新开始', code: 'CALL_EXPIRED' }, { status: 410 }), () => { called = true; }),
    error => error instanceof ApiError && error.status === 410 && error.code === 'CALL_EXPIRED');
  assert.equal(called, false);
});

test('wrong MIME, invalid UTF-8 and oversized advertised body are rejected and cancel readers', async () => {
  await assert.rejects(readAudioTurnStream(response(transcriptLine + turnLine, { 'Content-Type': 'text/html' }), () => {}));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(0xff)); }, cancel() { cancelled = true; } });
  await assert.rejects(readAudioTurnStream(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {}));
  assert.equal(cancelled, true);
  await assert.rejects(readAudioTurnStream(new Response(transcriptLine + turnLine, { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Length': '1000000' } }), () => {}));
});

test('reader network failure after transcript rejects instead of treating partial text as a completed turn', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>; let seen!: () => void;
  const received = new Promise<void>(resolve => { seen = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  const result = readAudioTurnStream(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }), () => seen());
  stream.enqueue(new TextEncoder().encode(transcriptLine)); await received;
  stream.error(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(result, error => error instanceof DOMException && error.name === 'AbortError');
});
