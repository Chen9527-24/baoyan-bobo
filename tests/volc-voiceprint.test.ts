import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createVolcVoiceprint, voiceprintAsrParameters, parseVoiceprintSpeaker } from '../apps/server/src/volc-voiceprint.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

const origin = 'https://baoyan.fixture.testing';
const env = { VOLC_VOICEPRINT_ENABLED: 'true', VOLC_VOICEPRINT_API_KEY: 'synthetic-voiceprint-key', VOLC_VOICEPRINT_AUDIO_ORIGIN: origin };
const speakerId = randomUUID(), groupId = randomUUID(), templateId = randomUUID(), audioId = randomUUID();
const audioUrl = `${origin}/api/voiceprint/audio/${audioId}?expires=1790760000000&signature=${'a'.repeat(64)}`;
const response = (Result: Record<string, unknown>) => Response.json({ ResponseMetadata: { RequestId: 'synthetic' }, Result });
const input = { speakerId, groupId, audioUrl };
const apiError = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test('voiceprint capability needs explicit enable, dedicated credentials and trusted audio origin', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return response({ Code: 1000, SpeakId: templateId }); }) as typeof fetch;
  for (const missing of [ {}, { ...env, VOLC_VOICEPRINT_ENABLED: 'false' }, { ...env, VOLC_VOICEPRINT_ENABLED: '' },
    { ...env, VOLC_VOICEPRINT_API_KEY: '', VOLC_SPEECH_API_KEY: 'existing-asr-key', ARK_API_KEY: 'ark' },
    { ...env, VOLC_VOICEPRINT_AUDIO_ORIGIN: '' }, { ...env, VOLC_VOICEPRINT_AUDIO_ORIGIN: 'http://localhost:3001' },
    { ...env, VOLC_VOICEPRINT_AUDIO_ORIGIN: 'https://127.0.0.1' },
    { ...env, VOLC_VOICEPRINT_AUDIO_ORIGIN: 'https://user:secret@baoyan.fixture.testing' },
    { ...env, VOLC_VOICEPRINT_AUDIO_ORIGIN: `${origin}/path` },
    { ...env, VOLC_VOICEPRINT_API_KEY: 'injected\r\nHeader: yes' } ]) {
    const adapter = createVolcVoiceprint({ env: missing, fetch: fetcher });
    assert.equal(adapter.configured, false);
    await assert.rejects(adapter.register(input), error => error instanceof ApiError);
  }
  assert.equal(calls, 0);
});

test('creation follows official UpdateVoiceprint contract and only anonymous names', async () => {
  let target = ''; let init: RequestInit | undefined;
  const adapter = createVolcVoiceprint({ env, fetch: (async (url, request) => { target = String(url); init = request; return response({ Code: 1000, SpeakId: templateId }); }) as typeof fetch });
  assert.deepEqual(await adapter.register(input), { templateId });
  assert.equal(target, 'https://openspeech.bytedance.com/api/proxy/invoke/?Action=UpdateVoiceprint');
  assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal instanceof AbortSignal);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('X-Api-Key'), env.VOLC_VOICEPRINT_API_KEY);
  assert.equal(headers.get('X-Api-App-Id'), null); assert.equal(headers.get('X-Api-Resource-Id'), null);
  assert.deepEqual(JSON.parse(String(init?.body)), { Action: 0, AudioUrl: audioUrl, SpeakerName: speakerId, GroupId: groupId });
});

test('management uses canonical trailing-slash route directly; unexpected redirects never receive a second credentialed request', async () => {
  let calls = 0;
  const adapter = createVolcVoiceprint({ env, fetch: (async (url, init) => {
    calls++; const target = new URL(String(url));
    assert.equal(target.pathname, '/api/proxy/invoke/'); assert.equal(init?.redirect, 'manual');
    return response({ Code: 1000, GroupId: groupId });
  }) as typeof fetch });
  assert.equal(await adapter.createGroup({ groupName: speakerId }), groupId);
  assert.equal(calls, 1, 'canonical route needs no redirect replay');
  for (const location of ['https://evil.invalid/api/proxy/invoke/', 'https://openspeech.bytedance.com/other', '/api/proxy/invoke/?Action=CreateVoiceprintGroup']) {
    let redirects = 0;
    const blocked = createVolcVoiceprint({ env, fetch: (async (_url, init) => { redirects++; assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 307, headers: { Location: location } }); }) as typeof fetch });
    await assert.rejects(blocked.createGroup({ groupName: speakerId }), apiError('VOICEPRINT_PROVIDER_ERROR'));
    assert.equal(redirects, 1, 'credentials are never automatically replayed');
  }
});

test('legacy authentication is complete and independent from existing ASR keys', async () => {
  let headers = new Headers();
  const legacy = { ...env, VOLC_VOICEPRINT_API_KEY: '', VOLC_VOICEPRINT_APP_ID: 'synthetic-app', VOLC_VOICEPRINT_ACCESS_KEY: 'synthetic-token' };
  const adapter = createVolcVoiceprint({ env: legacy, fetch: (async (_url, init) => { headers = new Headers(init?.headers); return response({ Code: 1000, SpeakId: templateId }); }) as typeof fetch });
  await adapter.register(input);
  assert.equal(headers.get('X-Api-Key'), null); assert.equal(headers.get('X-Api-App-Id'), 'synthetic-app');
  assert.equal(headers.get('X-Api-Access-Key'), 'synthetic-token');
  assert.equal(createVolcVoiceprint({ env: { ...legacy, VOLC_VOICEPRINT_ACCESS_KEY: '' } }).configured, false);
});

test('signed audio validation blocks arbitrary URL forwarding and query secrets', async () => {
  let calls = 0;
  const adapter = createVolcVoiceprint({ env, fetch: (async () => { calls++; return response({ Code: 1000, SpeakId: templateId }); }) as typeof fetch });
  for (const url of [ 'https://evil.invalid/private.wav', audioUrl.replace(origin, 'http://baoyan.fixture.testing'),
    audioUrl.replace('/api/voiceprint/audio/', '/admin/'), `${audioUrl}&password=hidden`, `${audioUrl}#fragment`,
    audioUrl.replace('signature=', 'missing='), audioUrl.replace('1790760000000', 'NaN') ]) {
    await assert.rejects(adapter.register({ ...input, audioUrl: url }), apiError('INVALID_INPUT'));
  }
  await assert.rejects(adapter.register({ ...input, speakerId: '爸爸' }), apiError('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('group creation and soft-delete use documented management operations', async () => {
  const sent: { url: string; body: any }[] = [];
  const adapter = createVolcVoiceprint({ env, fetch: (async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return response({ Code: 1000, GroupId: groupId });
  }) as typeof fetch });
  assert.equal(await adapter.createGroup({ groupName: speakerId }), groupId);
  assert.deepEqual(await adapter.remove({ templateId }), { supplierDeletion: 'soft_deleted' });
  assert.deepEqual(sent[0].body, { GroupName: speakerId }); assert.match(sent[0].url, /Action=CreateVoiceprintGroup$/);
  assert.deepEqual(sent[1].body, { Action: 2, SpeakId: templateId });
});

test('group receipts accept only documented GroupId and observed GroupID UUID aliases without ambiguity', async () => {
  for (const fields of [{ GroupId: groupId }, { GroupID: groupId }, { GroupId: groupId, GroupID: groupId }]) {
    const adapter = createVolcVoiceprint({ env, fetch: (async () => response({ Code: 1000, ...fields })) as typeof fetch });
    assert.equal(await adapter.createGroup({ groupName: speakerId }), groupId);
  }
  for (const fields of [{ GroupId: groupId, GroupID: randomUUID() }, { GroupId: groupId, GroupID: 'invalid' },
    { GroupId: undefined, GroupID: 'invalid' }, { GroupID: groupId.replaceAll('-', '') }, { groupId }, {}]) {
    const adapter = createVolcVoiceprint({ env, fetch: (async () => response({ Code: 1000, ...fields })) as typeof fetch });
    await assert.rejects(adapter.createGroup({ groupName: speakerId }), apiError('VOICEPRINT_PROVIDER_ERROR'));
  }
});

test('template receipt and group-scoped cleanup lookup share strict SpeakId/SpeakID alias validation', async () => {
  for (const fields of [{ SpeakId: templateId }, { SpeakID: templateId }, { SpeakId: templateId, SpeakID: templateId }]) {
    const adapter = createVolcVoiceprint({ env, fetch: (async (url) => response(String(url).endsWith('Action=ListVoiceprint')
      ? { Code: 1000, AudioEmbedding: [{ ...fields, SpeakerName: speakerId, Status: 1 }] }
      : { Code: 1000, ...fields })) as typeof fetch });
    assert.deepEqual(await adapter.register(input), { templateId });
    assert.equal(await adapter.find({ speakerId, groupId }), templateId);
  }
  for (const fields of [{ SpeakId: templateId, SpeakID: randomUUID() }, { SpeakID: 'invalid' },
    { SpeakId: templateId, SpeakID: 'invalid' }, { SpeakID: templateId.replaceAll('-', '') }, { speakId: templateId }]) {
    const adapter = createVolcVoiceprint({ env, fetch: (async (url) => response(String(url).endsWith('Action=ListVoiceprint')
      ? { Code: 1000, AudioEmbedding: [{ ...fields, SpeakerName: speakerId, Status: 1 }] }
      : { Code: 1000, ...fields })) as typeof fetch });
    await assert.rejects(adapter.register(input), apiError('VOICEPRINT_PROVIDER_ERROR'));
    await assert.rejects(adapter.find({ speakerId, groupId }), apiError('VOICEPRINT_PROVIDER_ERROR'));
  }
});

test('cleanup lookup is restricted to one explicit family group and strips vendor vectors', async () => {
  let body: any;
  const adapter = createVolcVoiceprint({ env, fetch: (async (_url, init) => {
    body = JSON.parse(String(init?.body)); return response({ Code: 1000, AudioEmbedding: [
      { SpeakId: templateId, SpeakerName: speakerId, Status: 1, Embedding: [1, 2], AudioUrl: 'private' },
      { SpeakId: randomUUID(), SpeakerName: randomUUID(), Status: 1 } ] });
  }) as typeof fetch });
  assert.equal(await adapter.find({ speakerId, groupId }), templateId);
  assert.deepEqual(body, { GroupId: groupId, Limit: 50, Offset: 0 });
  assert.equal(await adapter.find({ speakerId: randomUUID(), groupId }), undefined);
});

test('provider malformed/error/status responses are bounded and never expose upstream secrets', async () => {
  for (const reply of [response({ Code: 1002, Message: 'sensitive vendor detail' }),
    Response.json({ ResponseMetadata: { Error: { Code: 'Forbidden', Message: 'sensitive' } }, Result: { Code: 1000, SpeakId: templateId } }),
    response({ Code: 1000, SpeakId: 'invalid' }), new Response('not JSON', { headers: { 'content-type': 'text/plain' } }),
    new Response('blocked', { status: 403 }), new Response('a'.repeat(300_000), { headers: { 'content-type': 'application/json' } })]) {
    const adapter = createVolcVoiceprint({ env, fetch: (async () => reply) as typeof fetch });
    await assert.rejects(adapter.register(input), error => error instanceof ApiError && !error.message.includes('sensitive'));
  }
});

test('trusted failure diagnostics contain only fixed metadata and never print hostile upstream fields or request secrets', async () => {
  const output: string[] = []; const original = console.warn;
  console.warn = (...values: unknown[]) => { output.push(values.map(String).join(' ')); };
  const secret = 'HOSTILE_RAW_SECRET';
  try {
    const replies = [
      new Response(secret, { status: 307, headers: { Location: `https://evil.invalid/${secret}` } }),
      new Response(secret, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      Response.json({ ResponseMetadata: { Error: { Code: `PermissionDenied-${secret}`, Message: secret } }, Result: { Code: 1002, SpeakId: secret, AudioUrl: audioUrl, Embedding: [secret] } }),
      Response.json({ ResponseMetadata: { Error: { Code: `Unknown-${secret}`, Message: secret } }, Result: { Code: secret } }),
      response({ Code: 1000, GroupId: secret }),
    ];
    for (const reply of replies) {
      const adapter = createVolcVoiceprint({ env, fetch: (async () => reply) as typeof fetch });
      await assert.rejects(adapter.createGroup({ groupName: speakerId }), apiError('VOICEPRINT_PROVIDER_ERROR'));
    }
    assert.equal(output.length, replies.length);
    assert.equal(output.join('\n').includes(secret), false); assert.equal(output.join('\n').includes(env.VOLC_VOICEPRINT_API_KEY), false);
    assert.equal(output.join('\n').includes(speakerId), false); assert.equal(output.join('\n').includes(audioUrl), false);
    assert.deepEqual(output.map(line => JSON.parse(line).category), ['redirect', 'non_json', 'permission', 'unknown', 'response_shape']);
    for (const line of output) {
      const entry = JSON.parse(line); assert.deepEqual(Object.keys(entry).sort(), ['action', 'businessCode', 'category', 'httpStatus', 'type']);
      assert.equal(entry.type, 'voiceprint_provider_failure'); assert.equal(entry.action, 'CreateVoiceprintGroup');
    }
  } finally { console.warn = original; }
});

test('pre-abort sends no request; abort and timeout surface promptly when transport ignores signal', async () => {
  const aborted = new AbortController(); aborted.abort(); let calls = 0;
  const adapter = createVolcVoiceprint({ env, timeoutMs: 5, fetch: (async () => { calls++; return new Promise<Response>(() => {}); }) as typeof fetch });
  await assert.rejects(adapter.register({ ...input, signal: aborted.signal }), apiError('REQUEST_ABORTED')); assert.equal(calls, 0);
  await assert.rejects(adapter.register(input), apiError('VOICEPRINT_TIMEOUT')); assert.equal(calls, 1);
});

test('cancelled late registration receipt is delivered only to cleanup callback', async () => {
  let release!: (response: Response) => void; const late: string[] = [];
  const controller = new AbortController();
  const adapter = createVolcVoiceprint({ env, fetch: (async () => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch });
  const registration = adapter.register({ ...input, signal: controller.signal, onLateRegistration: result => late.push(result.templateId) });
  controller.abort(); await assert.rejects(registration, apiError('REQUEST_ABORTED'));
  release(response({ Code: 1000, SpeakId: templateId })); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(late, [templateId]);
});

test('late compatible template receipt remains cleanup-only and conflicting aliases never enter cleanup callback', async () => {
  for (const fields of [{ SpeakID: templateId }, { SpeakId: templateId, SpeakID: randomUUID() }]) {
    let release!: (response: Response) => void; const late: string[] = [];
    const controller = new AbortController();
    const adapter = createVolcVoiceprint({ env, fetch: (async () => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch });
    const registration = adapter.register({ ...input, signal: controller.signal, onLateRegistration: result => late.push(result.templateId) });
    controller.abort(); await assert.rejects(registration, apiError('REQUEST_ABORTED'));
    release(response({ Code: 1000, ...fields })); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(late, 'SpeakId' in fields ? [] : [templateId]);
  }
});

test('short-turn recognition supplies only the official ASR request fragment', () => {
  assert.deepEqual(voiceprintAsrParameters(groupId), { enable_nonstream: true, enable_speaker_info: true,
    show_utterances: true, ssd_mode: 2, voiceprints: [{ id: '', group_id: groupId }] });
  assert.throws(() => voiceprintAsrParameters('any-house'), apiError('INVALID_INPUT'));
});

test('speaker parsing refuses unknown, missing and multiple speakers rather than choosing highest', () => {
  const utterance = (speaker_id: string) => ({ text: '虚构测试', additions: { speaker_id } });
  assert.equal(parseVoiceprintSpeaker({ result: { utterances: [utterance(speakerId), utterance(speakerId)] } }), speakerId);
  for (const payload of [ {}, { utterances: [] }, { utterances: [utterance('0')] },
    { utterances: [utterance(speakerId), utterance(randomUUID())] },
    { utterances: [{ text: '测试' }] }, { utterances: [{ ...utterance(speakerId), overlap: true }] } ])
    assert.equal(parseVoiceprintSpeaker(payload), undefined);
});
