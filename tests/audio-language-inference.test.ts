import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, AUDIO_LANGUAGE_TASK } from '../apps/server/src/providers.ts';

const lite = 'doubao-seed-2-1-lite-260915';
const pro = 'doubao-seed-2-1-pro-260915';
const env = {
  CHAT_PROVIDER: 'volc', CHAT_API_BASE_URL: 'https://synthetic-audio.invalid/api/v3', CHAT_API_KEY: 'synthetic-only',
  CHAT_MODEL: lite, VOLC_TEXT_CHAT_MODEL: pro,
  ASR_PROVIDER: 'volc', VOLC_SPEECH_API_KEY: 'synthetic-only',
  VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration',
  VOLC_ASR_URL: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
};
const understood = { status: 'understood', language: 'mandarin', text: '我把纸飞机放在桌上了。' };
function wav() {
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let index = 44; index < bytes.length; index += 2) bytes.writeInt16LE(index % 2000, index);
  return bytes;
}
function completion(value: unknown, finish: unknown = 'stop') {
  return Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] });
}
const errorCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

for (const [language, text] of [
  ['mandarin', '好呀。'], ['english', 'My paper plane is on the table.'],
  ['chaoshan', '我准备吃完饭洗碗，然后和朋友出去。'], ['hakka', '我今天想和哥哥一起玩。'],
  ['cantonese', '我现在准备吃饭，晚上十点回家。'],
]) test(`raw-audio inference accepts ${language} with faithful text and uses Lite only`, async () => {
  let calls = 0;
  const original = wav(), before = Buffer.from(original);
  const provider = createProviders({ env, fetch: (async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://synthetic-audio.invalid/api/v3/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, lite); assert.notEqual(body.model, pro);
    assert.equal(body.temperature, 0); assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages[0], { role: 'system', content: AUDIO_LANGUAGE_TASK });
    assert.match(body.messages[0].content, /自动语种判断/);
    assert.deepEqual(body.messages[1].content[0], { type: 'input_audio', input_audio: { data: before.toString('base64'), format: 'wav' } });
    assert.deepEqual(body.messages[1].content[1], { type: 'text', text: '请按上述规则判断并理解这一句原音。' });
    assert.equal(body.messages[1].content.length, 2);
    assert.equal(init?.redirect, 'error');
    return completion({ status: 'understood', language, text });
  }) as typeof fetch });
  assert.equal(provider.capabilities.autoLanguage, true);
  assert.deepEqual(await provider.inferAudioLanguage(original, 'audio/wav'), { status: 'understood', language, text });
  assert.deepEqual(original, before); assert.equal(calls, 1);
});

for (const value of [
  { status: 'uncertain', language: 'unknown', text: '' },
  { status: 'uncertain', language: 'other', text: '' },
  { status: 'inaudible', language: 'unknown', text: '' },
]) test(`raw-audio inference preserves explicit ${value.status}/${value.language} without invented text`, async () => {
  let calls = 0;
  const provider = createProviders({ env, fetch: (async () => { calls++; return completion(value); }) as typeof fetch });
  assert.deepEqual(await provider.inferAudioLanguage(wav(), 'audio/wav'), value);
  assert.equal(calls, 1);
});

const invalidCases: Array<[string, unknown]> = [
  ['missing text', { status: 'understood', language: 'mandarin' }],
  ['extra reply', { ...understood, reply: '替用户做决定。' }],
  ['extra confidence', { ...understood, confidence: 1 }],
  ['array', [understood]], ['null', null], ['string', 'understood'],
  ['unknown status', { ...understood, status: 'accepted' }],
  ['unknown language', { ...understood, language: 'zh-CN' }],
  ['array language', { ...understood, language: ['mandarin'] }],
  ['object text', { ...understood, text: { content: '不是真实转写' } }],
  ['empty understood', { ...understood, text: '' }],
  ['whitespace understood', { ...understood, text: '  ' }],
  ['too long understood', { ...understood, text: '字'.repeat(601) }],
  ['NUL control', { ...understood, text: '正文\u0000隐藏内容' }],
  ['newline control', { ...understood, text: '正文\n隐藏内容' }],
  ['DEL control', { ...understood, text: '正文\u007f隐藏内容' }],
  ['C1 control', { ...understood, text: '正文\u0085隐藏内容' }],
  ['unknown understood', { ...understood, language: 'unknown' }],
  ['other understood', { ...understood, language: 'other' }],
  ['uncertain supported language', { status: 'uncertain', language: 'mandarin', text: '' }],
  ['uncertain invented text', { status: 'uncertain', language: 'unknown', text: '我猜是在说再见' }],
  ['uncertain whitespace', { status: 'uncertain', language: 'other', text: ' ' }],
  ['inaudible known language', { status: 'inaudible', language: 'english', text: '' }],
  ['inaudible other language', { status: 'inaudible', language: 'other', text: '' }],
  ['inaudible text', { status: 'inaudible', language: 'unknown', text: '好呀' }],
];
for (const [label, value] of invalidCases) test(`raw-audio inference rejects ${label} without fallback`, async () => {
  let calls = 0;
  const provider = createProviders({ env, fetch: (async () => { calls++; return completion(value); }) as typeof fetch });
  await assert.rejects(provider.inferAudioLanguage(wav(), 'audio/wav'), errorCode('AUDIO_LANGUAGE_INVALID'));
  assert.equal(calls, 1);
});

test('raw-audio inference accepts exactly 600 characters and trims only outer spaces', async () => {
  const value = { ...understood, text: ' ' + '字'.repeat(598) + ' ' };
  const provider = createProviders({ env, fetch: (async () => completion(value)) as typeof fetch });
  assert.deepEqual(await provider.inferAudioLanguage(wav(), 'audio/x-wav'), { ...understood, text: '字'.repeat(598) });
});

for (const finish of ['length', 'content_filter', 'tool_calls', null, undefined])
  test(`raw-audio inference rejects incomplete completion ${String(finish)}`, async () => {
    const provider = createProviders({ env, fetch: (async () => Response.json({ choices: [{ ...(finish !== undefined ? { finish_reason: finish } : {}), message: { content: JSON.stringify(understood) } }] })) as typeof fetch });
    await assert.rejects(provider.inferAudioLanguage(wav(), 'audio/wav'), errorCode('PROVIDER_INCOMPLETE'));
  });

for (const content of ['not JSON', '```json\n{}\n```', { status: 'understood' }, '', JSON.stringify({ ...understood, text: '字'.repeat(6001) })])
  test(`raw-audio inference rejects malformed content ${typeof content}/${String(content).length}`, async () => {
    const provider = createProviders({ env, fetch: (async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })) as typeof fetch });
    await assert.rejects(provider.inferAudioLanguage(wav(), 'audio/wav'), errorCode('AUDIO_LANGUAGE_INVALID'));
  });

test('raw-audio inference validates WAV PCM and capability before any upload', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return completion(understood); }) as typeof fetch;
  const provider = createProviders({ env, fetch: fetcher });
  const wrongRate = wav(); wrongRate.writeUInt32LE(48000, 24);
  for (const [audio, mime] of [[Buffer.from('not-wav'), 'audio/wav'], [wav(), 'audio/mp4'], [wrongRate, 'audio/wav']] as const)
    await assert.rejects(provider.inferAudioLanguage(audio, mime), errorCode('ASR_AUDIO_INVALID'));
  for (const override of [{ ASR_PROVIDER: 'openai' }, { CHAT_MODEL: pro }, { VOLC_SPEECH_API_KEY: '' }, { CHAT_PROVIDER: 'openai' }]) {
    const disabled = createProviders({ env: { ...env, ...override }, fetch: fetcher });
    assert.equal(disabled.capabilities.autoLanguage, false);
    await assert.rejects(disabled.inferAudioLanguage(wav(), 'audio/wav'), errorCode('AUTO_LANGUAGE_NOT_CONFIGURED'));
  }
  assert.equal(calls, 0);
});

test('raw-audio inference stops an already cancelled request before upload', async () => {
  let calls = 0;
  const provider = createProviders({ env, fetch: (async () => { calls++; return completion(understood); }) as typeof fetch });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.inferAudioLanguage(wav(), 'audio/wav', controller.signal), errorCode('PROVIDER_CANCELLED'));
  assert.equal(calls, 0);
});

test('raw-audio inference propagates cancellation and discards a late valid reply', async () => {
  const controller = new AbortController(); let calls = 0;
  const provider = createProviders({ env, fetch: (async (_url, init) => {
    calls++; assert.equal(init?.signal?.aborted, false);
    controller.abort(); assert.equal(init?.signal?.aborted, true);
    return completion(understood);
  }) as typeof fetch });
  await assert.rejects(provider.inferAudioLanguage(wav(), 'audio/wav', controller.signal), errorCode('PROVIDER_CANCELLED'));
  assert.equal(calls, 1);
});

test('raw-audio inference reports cancellation when the transport rejects after abort', async () => {
  const controller = new AbortController();
  const provider = createProviders({ env, fetch: (async () => { controller.abort(); throw new DOMException('private remote details', 'AbortError'); }) as typeof fetch });
  await assert.rejects(provider.inferAudioLanguage(wav(), 'audio/wav', controller.signal), errorCode('PROVIDER_CANCELLED'));
});

test('raw-audio inference does not retry or expose failed upstream traces', async () => {
  let calls = 0;
  const provider = createProviders({ env, fetch: (async () => { calls++; return new Response('PRIVATE_REMOTE_TRACE', { status: 503 }); }) as typeof fetch });
  await assert.rejects(provider.inferAudioLanguage(wav(), 'audio/wav'), (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE_REMOTE_TRACE'));
  assert.equal(calls, 1);
});
