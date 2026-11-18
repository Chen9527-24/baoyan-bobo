import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../apps/web/src/lib/api.ts';
import { FeedbackAttempt, feedbackError, submitFeedback, type FeedbackContext } from '../apps/web/src/lib/feedback.ts';

const context: FeedbackContext = { page: 'call', callState: 'processing', appVersion: '0.1.1' };
const audio = () => new Blob([new Uint8Array(100)], { type: 'audio/wav' });

test('uncertain feedback retries reuse the same operation, while changed text or recording uses a new operation', () => {
  let next = 0;
  const attempt = new FeedbackAttempt(() => `attempt-${++next}`);
  const clip = audio();
  const first = attempt.prepare('  no sound  ', clip, context);
  assert.equal(attempt.prepare('no sound', clip, { ...context }), first);
  assert.equal(attempt.prepare('different issue', clip, context).operationId, 'attempt-2');
  assert.equal(attempt.prepare('different issue', audio(), context).operationId, 'attempt-3');
});

test('feedback payload copies only the allowed page state and requires meaningful bounded text or audio', () => {
  const attempt = new FeedbackAttempt(() => 'test-key');
  const request = attempt.prepare('typing only', null, { ...context, chat: 'private', pin: 'secret', url: '?token=secret' } as FeedbackContext);
  assert.deepEqual(request.context, context);
  assert.equal(request.audio, null);
  assert.doesNotThrow(() => attempt.prepare('', audio(), context));
  assert.throws(() => attempt.prepare('  ', null, context), /写几个字/);
  assert.throws(() => attempt.prepare('字'.repeat(2001), null, context), /2000/);
  assert.throws(() => attempt.prepare('', new Blob(['voice'], { type: 'audio/webm' }), context), /录音格式/);
  assert.throws(() => attempt.prepare('', new Blob([new Uint8Array(1_000_001)], { type: 'audio/wav' }), context), /过大/);
});

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.fetch = mock;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } });
  try { await run(); }
  finally {
    globalThis.fetch = originalFetch;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('explicit feedback submit establishes a cookie first, then sends same-origin multipart without any model call', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const receipt = { id: 'feedback-1', createdAt: '2026-09-28T13:00:00Z' };
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(calls.length === 1 ? { ok: true } : receipt);
  }, async () => {
    const request = new FeedbackAttempt(() => 'attempt-1').prepare('no sound', audio(), context);
    assert.deepEqual(await submitFeedback(request, new AbortController().signal), receipt);
    assert.deepEqual(calls.map(call => call.url), ['/api/feedback/context', '/api/feedback']);
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.equal(calls[1].init?.credentials, 'same-origin');
    assert.equal(calls[1].init?.method, 'POST');
    assert.deepEqual(calls[1].init?.headers, {});
    const body = calls[1].init?.body as FormData;
    assert.deepEqual([...body.keys()], ['operationId', 'text', 'context', 'audio']);
    assert.equal(body.get('operationId'), 'attempt-1');
    assert.equal(body.get('text'), 'no sound');
    assert.deepEqual(JSON.parse(body.get('context') as string), context);
    assert.equal((body.get('audio') as File).type, 'audio/wav');
    assert.equal((body.get('audio') as File).name, 'feedback.wav');
  });
});

test('cancelling while the anonymous context is pending prevents the upload even if that GET arrives late', async () => {
  const controller = new AbortController();
  const urls: string[] = [];
  await withFetch(async input => { urls.push(String(input)); controller.abort(); return Response.json({ ok: true }); }, async () => {
    const draft = new FeedbackAttempt(() => 'same-key').prepare('text', null, context);
    await assert.rejects(submitFeedback(draft, controller.signal), { name: 'AbortError' });
    assert.deepEqual(urls, ['/api/feedback/context']);
  });
});

test('failed preparation never uploads and unknown submission results are not shown as success', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response('unavailable', { status: 503 }); }, async () => {
    await assert.rejects(submitFeedback(new FeedbackAttempt().prepare('hello', null, context), new AbortController().signal));
    assert.equal(calls, 1);
  });
  for (const body of [{}, { id: '<script>', createdAt: '2026-09-28' }, { id: 'ok', createdAt: 'invalid' }]) {
    let step = 0;
    await withFetch(async () => Response.json(++step === 1 ? { ok: true } : body), async () => {
      await assert.rejects(submitFeedback(new FeedbackAttempt().prepare('hello', null, context), new AbortController().signal), /尚未确认/);
    });
  }
});

test('timeout and network errors preserve uncertainty and direct same-content retry, while definite rejection retains the message', () => {
  for (const error of [new DOMException('timeout', 'AbortError'), new TypeError('network'), new ApiError('bad gateway', 502)]) {
    assert.match(feedbackError(error), /无法确认.*内容已保留.*避免重复/);
    assert.doesNotMatch(feedbackError(error), /提交成功啦|提交失败/);
  }
  assert.equal(feedbackError(new ApiError('反馈太频繁，请稍后再试。', 429)), '反馈太频繁，请稍后再试。');
});
