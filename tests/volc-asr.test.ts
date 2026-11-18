import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer, type ClientOptions } from 'ws';
import { createVolcAsr } from '../apps/server/src/volc-asr.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

const officialUrl = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const env = {
  VOLC_SPEECH_API_KEY: 'test-speech-key-only',
  VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration',
  VOLC_ASR_URL: officialUrl,
};

function wav(samples = 3_200): Buffer {
  const result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16_000, 24); result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) result.writeInt16LE((index % 200) * 100, 44 + index * 2);
  return result;
}

// Independent protocol peer: it checks the actual bytes transmitted through ws.
function response(payload: unknown, options: { flags?: number; compress?: boolean; type?: number; code?: number; event?: number } = {}): Buffer {
  const flags = options.flags ?? 1;
  const type = options.type ?? 9;
  let body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  if (options.compress !== false) body = gzipSync(body);
  const prefix = Buffer.alloc(4 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0) + (type === 15 ? 4 : 0) + 4);
  prefix.set([0x11, (type << 4) | flags, (type === 15 ? 0 : 0x10) | (options.compress === false ? 0 : 1), 0]);
  let position = 4;
  if (flags & 1) { prefix.writeInt32BE(flags & 2 ? -20 : 1, position); position += 4; }
  if (flags & 4) { prefix.writeInt32BE(options.event ?? 0, position); position += 4; }
  if (type === 15) { prefix.writeUInt32BE(options.code ?? 45000001, position); position += 4; }
  prefix.writeUInt32BE(body.length, position);
  return Buffer.concat([prefix, body]);
}

function request(data: WebSocket.RawData) {
  assert.ok(Buffer.isBuffer(data));
  assert.equal(data[0], 0x11);
  assert.equal(data[3], 0);
  const type = data[1] >> 4;
  const flags = data[1] & 15;
  assert.ok(flags === 1 || flags === 3);
  assert.equal(data[2], type === 1 ? 0x11 : 0x01);
  const seq = data.readInt32BE(4);
  assert.equal(seq < 0, flags === 3);
  assert.equal(data.readUInt32BE(8), data.length - 12);
  return { type, seq, final: flags === 3, body: gunzipSync(data.subarray(12)) };
}

async function peer(t: TestContext, handler: (socket: WebSocket, headers: import('node:http').IncomingHttpHeaders) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let connections = 0;
  server.on('connection', (socket, request) => { connections++; handler(socket, request.headers); });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    connections: () => connections,
    connect(url: string, options: ClientOptions) {
      assert.equal(url, officialUrl);
      assert.equal(options.followRedirects, false);
      assert.equal(options.perMessageDeflate, false);
      assert.equal(options.maxPayload, 256 * 1024);
      return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    },
  };
}

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, expected);
  assert.doesNotMatch(error.message, /test-speech-key|private-provider-message|secret-token/);
  return true;
};

test('ASR binary protocol: ACK, paced PCM chunks, negative final sequence, final result only', async (t) => {
  const input = wav(8_000);
  const received: Buffer[] = [];
  const sequences: number[] = [];
  const times: number[] = [];
  let socketClosed = false;
  let settled = false;
  const server = await peer(t, (socket, headers) => {
    assert.equal(headers['x-api-key'], env.VOLC_SPEECH_API_KEY);
    assert.equal(headers['x-api-resource-id'], 'volc.seedasr.sauc.duration');
    assert.equal(headers['x-api-app-key'], undefined);
    assert.match(String(headers['x-api-request-id']), /^[0-9a-f-]{36}$/);
    socket.on('close', () => { socketClosed = true; });
    socket.on('message', (data) => {
      const packet = request(data);
      if (packet.type === 1) {
        assert.equal(packet.seq, 1);
        const config = JSON.parse(packet.body.toString());
        assert.deepEqual(config.audio, { format: 'pcm', codec: 'raw', rate: 16_000, bits: 16, channel: 1 });
        assert.equal(config.request.result_type, 'full');
        assert.equal(config.request.enable_ddc, false);
        assert.equal(config.request.enable_speaker_info, undefined);
        assert.equal(config.request.enable_lid, undefined);
        assert.equal(config.user.uid, headers['x-api-request-id']);
        socket.send(response({ audio_info: { duration: 0 } }));
      } else {
        received.push(packet.body); sequences.push(packet.seq); times.push(Date.now());
        if (packet.final) {
          socket.send(response({ result: { text: '这只是中间结果' } }));
          setTimeout(() => {
            assert.equal(settled, false);
            socket.send(response({ result: { text: '  今天想看星星。  ' } }, { flags: 3 }));
          }, 10);
        }
      }
    });
  });
  const text = await createVolcAsr({ env, connect: server.connect }).transcribe(input, 'audio/wav').then((result) => { settled = true; return result; });
  assert.equal(text, '今天想看星星。');
  assert.deepEqual(sequences, [2, 3, -4]);
  assert.deepEqual(Buffer.concat(received), input.subarray(44));
  assert.ok(times[1] - times[0] >= 80 && times[2] - times[1] >= 80);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socketClosed, true);
  assert.equal(server.connections(), 1);
});

test('explicit 2.0 and legacy 1.0 resources use the same nostream protocol without substitution', async (t) => {
  const resources = ['volc.seedasr.sauc.duration', 'volc.bigasr.sauc.duration'];
  const observed: string[] = [];
  const server = await peer(t, (socket, headers) => {
    observed.push(String(headers['x-api-resource-id']));
    socket.on('message', (data) => {
      const frame = request(data);
      if (frame.type === 1) {
        assert.equal(JSON.parse(frame.body.toString()).request.model_name, 'bigmodel');
        socket.send(response({}));
      } else if (frame.final) {
        socket.send(response({ result: { text: '宝妍，你好。' } }, { flags: 3 }));
      }
    });
  });
  for (const resource of resources) {
    const asr = createVolcAsr({ env: { ...env, VOLC_ASR_RESOURCE_ID: resource }, connect: server.connect });
    assert.equal(asr.configured, true);
    assert.equal(await asr.transcribe(wav(), 'audio/wav'), '宝妍，你好。');
  }
  assert.deepEqual(observed, resources);
});

test('legacy authentication and fresh request identity; modern key takes precedence', async (t) => {
  const ids = new Set<string>();
  const observed: import('node:http').IncomingHttpHeaders[] = [];
  const server = await peer(t, (socket, headers) => {
    observed.push(headers); ids.add(String(headers['x-api-request-id']));
    socket.on('message', (data) => {
      const frame = request(data);
      socket.send(frame.type === 1 ? response({}) : response({ code: 20_000_000, result: { text: '你好' } }, { flags: 2, compress: false }));
    });
  });
  const legacy = { ...env, VOLC_SPEECH_API_KEY: undefined, VOLC_SPEECH_APP_ID: '123456', VOLC_SPEECH_ACCESS_TOKEN: 'secret-token' };
  await createVolcAsr({ env: legacy, connect: server.connect }).transcribe(wav(), 'audio/x-wav');
  await createVolcAsr({ env: { ...legacy, VOLC_SPEECH_API_KEY: env.VOLC_SPEECH_API_KEY }, connect: server.connect }).transcribe(wav(), 'audio/wav');
  assert.equal(observed[0]['x-api-app-key'], '123456'); assert.equal(observed[0]['x-api-access-key'], 'secret-token');
  assert.equal(observed[0]['x-api-key'], undefined);
  assert.equal(observed[1]['x-api-key'], env.VOLC_SPEECH_API_KEY); assert.equal(observed[1]['x-api-access-key'], undefined);
  assert.equal(ids.size, 2);
});

test('configuration is explicit and credentials cannot escape to arbitrary endpoints', async () => {
  for (const invalid of [
    {}, { ...env, VOLC_ASR_URL: undefined }, { ...env, VOLC_ASR_RESOURCE_ID: undefined },
    { ...env, VOLC_ASR_URL: 'wss://example.com/api/v3/sauc/bigmodel_nostream' },
    { ...env, VOLC_ASR_URL: `${officialUrl}?key=secret-token` },
    { ...env, VOLC_ASR_URL: officialUrl.replace('wss:', 'ws:') },
    { ...env, VOLC_SPEECH_API_KEY: 'bad\r\nX-Injected: true' },
    { ...env, VOLC_SPEECH_API_KEY: undefined, ARK_API_KEY: 'test-ark-key' },
    { ...env, VOLC_SPEECH_API_KEY: undefined, VOLC_SPEECH_APP_ID: '123' },
    { ...env, VOLC_ASR_RESOURCE_ID: 'volc.speech.dialog' },
  ]) {
    const asr = createVolcAsr({ env: invalid, connect: () => { throw new Error('must not connect'); } });
    assert.equal(asr.configured, false);
    await assert.rejects(asr.transcribe(wav(), 'audio/wav'), code('ASR_NOT_CONFIGURED'));
  }
});

test('WAV metadata, data length, encoding, rate, channels and 30-second limit are checked before connection', async () => {
  let connections = 0;
  const asr = createVolcAsr({ env, connect: () => { connections++; throw new Error('must not connect'); } });
  const mutations: Array<(audio: Buffer) => void> = [
    (a) => a.write('RIFX', 0), (a) => a.writeUInt32LE(0, 4), (a) => a.write('MP3 ', 8),
    (a) => a.writeUInt32LE(18, 16), (a) => a.writeUInt16LE(3, 20), (a) => a.writeUInt16LE(2, 22),
    (a) => a.writeUInt32LE(48_000, 24), (a) => a.writeUInt32LE(1, 28), (a) => a.writeUInt16LE(4, 32),
    (a) => a.writeUInt16LE(32, 34), (a) => a.write('JUNK', 36), (a) => a.writeUInt32LE(960_000, 40),
  ];
  for (const change of mutations) { const input = wav(); change(input); await assert.rejects(asr.transcribe(input, 'audio/wav'), code('ASR_AUDIO_INVALID')); }
  await assert.rejects(asr.transcribe(wav(), 'audio/webm'), code('ASR_AUDIO_INVALID'));
  await assert.rejects(asr.transcribe(Buffer.alloc(44), 'audio/wav'), code('ASR_AUDIO_INVALID'));
  await assert.rejects(asr.transcribe(wav(480_001), 'audio/wav'), code('ASR_AUDIO_TOO_LONG'));
  assert.equal(connections, 0);
});

test('provider business failures are sanitized and never retried', async (t) => {
  for (const [businessCode, expected] of [[45000002, 'ASR_EMPTY'], [45000151, 'ASR_AUDIO_INVALID'], [45000081, 'ASR_TIMEOUT'], [55000031, 'ASR_BUSY'], [45000001, 'ASR_UPSTREAM_FAILED']] as const) {
    const server = await peer(t, (socket) => socket.on('message', () => socket.send(response('private-provider-message test-speech-key secret-token', { type: 15, flags: 0, code: businessCode }))));
    await assert.rejects(createVolcAsr({ env, connect: server.connect }).transcribe(wav(), 'audio/wav'), code(expected));
    assert.equal(server.connections(), 1);
  }
});

test('bad/oversized frames and compressed expansion are rejected', async (t) => {
  const wrongLength = response({}); wrongLength.writeUInt32BE(1, 8);
  const badCompression = response({}); badCompression[2] = 0x12;
  const badVersion = response({}); badVersion[0] = 0x21;
  const cases = [
    Buffer.alloc(3), wrongLength, badCompression, badVersion,
    response({ result: { text: 'x'.repeat(1_001) } }),
    response({ junk: 'x'.repeat(256 * 1024) }),
    response('{invalid JSON', { compress: false }),
    response({ result: { text: 'premature final' } }, { flags: 3 }),
    response({ result: [{ text: 'unexpected structure' }] }),
  ];
  for (const frame of cases) {
    const server = await peer(t, (socket) => socket.once('message', () => socket.send(frame)));
    await assert.rejects(createVolcAsr({ env, connect: server.connect }).transcribe(wav(), 'audio/wav'), code('ASR_PROTOCOL_ERROR'));
  }
});

test('close without final never returns partial text; empty final never reuses an earlier transcript', async (t) => {
  for (const emptyFinal of [false, true]) {
    const server = await peer(t, (socket) => socket.on('message', (data) => {
      if (request(data).type === 1) socket.send(response({}));
      else {
        socket.send(response({ result: { text: '旧的中间结果' } }));
        if (emptyFinal) socket.send(response({ result: { text: '' } }, { flags: 3 }));
        else socket.close();
      }
    }));
    await assert.rejects(createVolcAsr({ env, connect: server.connect }).transcribe(wav(), 'audio/wav'), code(emptyFinal ? 'ASR_EMPTY' : 'ASR_CONNECTION_CLOSED'));
  }
});

test('abort stops paced upload, closes socket, and cannot deliver a late final', async (t) => {
  const controller = new AbortController();
  let audioPackets = 0;
  let closed = false;
  const server = await peer(t, (socket) => {
    socket.on('close', () => { closed = true; });
    socket.on('message', (data) => {
      if (request(data).type === 1) socket.send(response({}));
      else {
        audioPackets++; controller.abort();
        socket.send(response({ result: { text: '取消之后的结果' } }, { flags: 3 }));
      }
    });
  });
  await assert.rejects(createVolcAsr({ env, connect: server.connect }).transcribe(wav(9_600), 'audio/wav', controller.signal), code('ASR_CANCELLED'));
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(audioPackets, 1); assert.equal(closed, true); assert.equal(server.connections(), 1);
  await assert.rejects(createVolcAsr({ env, connect: () => { throw new Error('must not connect'); } }).transcribe(wav(), 'audio/wav', controller.signal), code('ASR_CANCELLED'));
});

test('one total timeout also covers a server that never acknowledges configuration', async (t) => {
  let closed = false;
  const server = await peer(t, (socket) => { socket.on('close', () => { closed = true; }); });
  await assert.rejects(createVolcAsr({ env, connect: server.connect, timeoutMs: 150 }).transcribe(wav(), 'audio/wav'), code('ASR_TIMEOUT'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, true); assert.equal(server.connections(), 1);
});

test('authentication rejection does not expose headers/body or follow redirects', async (t) => {
  const http = createServer((_req, res) => { res.writeHead(403); res.end('secret-token private-provider-message'); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const asr = createVolcAsr({ env, connect: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}`, options) });
  await assert.rejects(asr.transcribe(wav(), 'audio/wav'), code('ASR_AUTH_FAILED'));
});

test('abort during a stalled handshake settles promptly and closes the underlying connection', async (t) => {
  const controller = new AbortController();
  const http = createServer();
  const sockets = new Set<import('node:net').Socket>();
  let closed = false;
  http.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => { closed = true; sockets.delete(socket); }); });
  http.on('upgrade', (_request, socket) => {
    // Upgraded HTTP sockets allow half-open connections; acknowledge the client's FIN.
    socket.on('end', () => { closed = true; socket.end(); });
    socket.resume(); controller.abort();
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); http.close(() => resolve()); }));
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const asr = createVolcAsr({ env, connect: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}`, options) });
  await assert.rejects(asr.transcribe(wav(), 'audio/wav', controller.signal), code('ASR_CANCELLED'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, true);
});

test('language-aware ASR enables LID only for its own method and keeps old detailed results compatible', async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const payload = { result: { text: '  今天画了一朵花。  ', additions: { lid_lang: 'speech_mand', log_id: 'not-a-routing-field' } } };
  const server = await peer(t, socket => socket.on('message', data => {
    const packet = request(data);
    if (packet.type === 1) { requests.push(JSON.parse(packet.body.toString()).request); socket.send(response({})); }
    else if (packet.final) socket.send(response(payload, { flags: 3 }));
  }));
  const asr = createVolcAsr({ env, connect: server.connect });
  assert.equal(await asr.transcribe(wav(), 'audio/wav'), '今天画了一朵花。');
  assert.deepEqual(await asr.transcribeDetailed(wav(), 'audio/wav'), { text: '今天画了一朵花。', payload });
  assert.deepEqual(await asr.transcribeWithLanguage(wav(), 'audio/wav'), {
    text: '今天画了一朵花。', payload, language: { kind: 'mandarin', code: 'speech_mand' },
  });
  assert.deepEqual(requests.map(value => value.enable_lid), [undefined, undefined, true]);
  assert.deepEqual(requests.map(value => value.show_utterances), [undefined, undefined, true]);
  for (const value of requests) {
    assert.equal(value.enable_auto_lang, undefined);
    assert.equal(value.enable_emotion_detection, undefined);
    assert.equal(value.corpus, undefined);
  }
  assert.equal(server.connections(), 3);
});

test('language metadata is read from bounded official-style positions and keeps Minnan separate from Chaoshan', async (t) => {
  const cases = [
    [{ additions: { lid_lang: 'speech_dia_chao' }, result: { text: '识别文字' } }, { kind: 'chaoshan', code: 'speech_dia_chao' }],
    [{ result: { text: '识别文字', additions: { lang_code: 'speech_dia_hak' } } }, { kind: 'hakka', code: 'speech_dia_hak' }],
    [{ result: { text: '识别文字' }, audio_info: { additions: { language_code: 'zh-CN' } } }, { kind: 'mandarin', code: 'speech_mand' }],
    [{ result: { text: '识别文字', additions: JSON.stringify({ lid_lang: 'speech_dia_nan' }) } }, { kind: 'other-dialect', code: 'speech_dia_nan' }],
    [{ result: { text: '识别文字', utterances: [{ additions: { lid_lang: 'speech_dia_wuu' } }] } }, { kind: 'other-dialect', code: 'speech_dia_wuu' }],
    [{ result: { text: '识别文字', lid_lang: 'speech_mand' }, additions: { lang_code: 'zh-CN' } }, { kind: 'mandarin', code: 'speech_mand' }],
    [{ result: { text: '识别文字', additions: { language_code: 'hak' } } }, { kind: 'hakka', code: 'speech_dia_hak' }],
    [{ result: { text: 'hello', additions: { lid_lang: 'speech_en' } } }, { kind: 'english', code: 'speech_en' }],
    [{ result: { text: '我而家准备食饭。', additions: { lid_lang: 'speech_dia_cant' } } }, { kind: 'cantonese', code: 'speech_dia_cant' }],
    [{ result: { text: '我而家准备食饭。', additions: { language_code: 'yue-CN' } } }, { kind: 'cantonese', code: 'speech_dia_cant' }],
    [{ result: { text: '我而家准备食饭。', utterances: [{ additions: { lang_code: 'yue' } }] } }, { kind: 'cantonese', code: 'speech_dia_cant' }],
  ] as const;
  for (const [payload, expected] of cases) {
    const server = await peer(t, socket => socket.on('message', data => {
      const packet = request(data);
      if (packet.type === 1) socket.send(response({}));
      else if (packet.final) socket.send(response(payload, { flags: 3 }));
    }));
    assert.deepEqual((await createVolcAsr({ env, connect: server.connect }).transcribeWithLanguage(wav(), 'audio/wav')).language, expected);
    assert.equal(server.connections(), 1);
  }
});

test('English classification accepts only the documented spoken label and existing en-US alias without changing request languages', async (t) => {
  const payloads = [
    { result: { text: '  Hello, BaoYan.  ', additions: { lid_lang: 'speech_en' } } },
    { audio_info: { additions: { language_code: 'en-US' } }, result: { text: '  Hello, BaoYan.  ' } },
    { additions: { lid_lang: ' SPEECH_EN ' }, result: { text: '  Hello, BaoYan.  ', utterances: [
      { additions: JSON.stringify({ lang_code: 'en-US' }) },
    ] } },
  ];
  for (const payload of payloads) {
    const server = await peer(t, socket => socket.on('message', data => {
      const packet = request(data);
      if (packet.type === 1) {
        const config = JSON.parse(packet.body.toString());
        assert.equal(config.request.enable_lid, true);
        assert.equal(config.request.language, undefined);
        assert.equal(config.request.enable_auto_lang, undefined);
        assert.equal(config.audio.language, undefined);
        socket.send(response({}));
      } else if (packet.final) socket.send(response(payload, { flags: 3 }));
    }));
    const asr = createVolcAsr({ env, connect: server.connect });
    assert.deepEqual(await asr.transcribeWithLanguage(wav(), 'audio/wav'), {
      text: 'Hello, BaoYan.', payload, language: { kind: 'english', code: 'speech_en' },
    });
    assert.equal(server.connections(), 1);
  }
});

test('unsupported English spellings, other languages, singing and mixed speech never become English', async (t) => {
  const cases = [
    [{ additions: { lid_lang: 'en' } }, { kind: 'unknown' }],
    [{ additions: { lid_lang: 'speech_eng' } }, { kind: 'unknown' }],
    [{ additions: { lid_lang: 'speech_dia_yue' } }, { kind: 'unknown' }],
    [{ additions: { lid_lang: 'en-GB' } }, { kind: 'unknown' }],
    [{ additions: { lid_lang: 'singing_en' } }, { kind: 'unknown', code: 'singing_en' }],
    [{ additions: { lid_lang: 'speech_ja' } }, { kind: 'unknown', code: 'speech_ja' }],
    [{ additions: { lid_lang: 'speech_en', lang_code: 'speech_mand' } }, { kind: 'unknown' }],
    [{ additions: { lid_lang: 'speech_en', language_code: 'speech_eng' } }, { kind: 'unknown' }],
    [{ additions: { lid_lang: 'speech_en' }, utterances: [
      { additions: { lid_lang: 'speech_en' } }, { additions: { lid_lang: 'speech_dia_chao' } },
    ] }, { kind: 'unknown' }],
    [{ additions: { lid_lang: 'speech_en speech_mand' } }, { kind: 'unknown' }],
  ] as const;
  for (const [metadata, expected] of cases) {
    const server = await peer(t, socket => socket.on('message', data => {
      const packet = request(data);
      socket.send(packet.type === 1 ? response({}) : response({ result: { text: 'Hello, I speak English.', ...metadata } }, { flags: 3 }));
    }));
    assert.deepEqual((await createVolcAsr({ env, connect: server.connect }).transcribeWithLanguage(wav(), 'audio/wav')).language, expected);
    assert.equal(server.connections(), 1);
  }
});

test('a valid English label without text is metadata only; legacy transcribers still reject empty speech', async (t) => {
  const payload = { result: { text: '  ', additions: { lid_lang: 'speech_en' } } };
  const server = await peer(t, socket => socket.on('message', data => {
    socket.send(request(data).type === 1 ? response({}) : response(payload, { flags: 3 }));
  }));
  const asr = createVolcAsr({ env, connect: server.connect });
  assert.deepEqual(await asr.transcribeWithLanguage(wav(), 'audio/wav'), {
    text: '', payload, language: { kind: 'english', code: 'speech_en' },
  });
  await assert.rejects(asr.transcribe(wav(), 'audio/wav'), code('ASR_EMPTY'));
  await assert.rejects(asr.transcribeDetailed(wav(), 'audio/wav'), code('ASR_EMPTY'));
  assert.equal(server.connections(), 3);
});

test('a final valid dialect tag without words can select a raw-audio fallback while old methods remain ASR_EMPTY', async (t) => {
  for (const payload of [{ additions: { lid_lang: 'speech_dia_chao' } }, { result: { text: '  ', additions: { lid_lang: 'speech_dia_hak' } } }]) {
    const server = await peer(t, socket => socket.on('message', data => {
      const packet = request(data);
      if (packet.type === 1) socket.send(response({}));
      else if (packet.final) socket.send(response(payload, { flags: 3 }));
    }));
    const asr = createVolcAsr({ env, connect: server.connect });
    const result = await asr.transcribeWithLanguage(wav(), 'audio/wav');
    assert.equal(result.text, '');
    assert.ok(result.language.kind === 'chaoshan' || result.language.kind === 'hakka');
    assert.deepEqual(result.payload, payload);
    await assert.rejects(asr.transcribe(wav(), 'audio/wav'), code('ASR_EMPTY'));
    await assert.rejects(asr.transcribeDetailed(wav(), 'audio/wav'), code('ASR_EMPTY'));
    assert.equal(server.connections(), 3);
  }
});

test('unknown or malformed language metadata never guesses a language from fluent text and cannot justify empty speech', async (t) => {
  const cases = [
    {}, { lid_lang: '' }, { lid_lang: 'others' }, { lid_lang: 'other_langs' },
    { lid_lang: 'speech_dia_invented' }, { lid_lang: ['speech_dia_chao'] },
    { lid_lang: { language: 'speech_mand' } }, { lid_lang: 'x'.repeat(65) },
    '{bad json', JSON.stringify({ note: 'speech_dia_hak' }),
  ];
  for (const additions of cases) {
    let withText = true;
    const server = await peer(t, socket => socket.on('message', data => {
      const packet = request(data);
      if (packet.type === 1) socket.send(response({}));
      else if (packet.final) socket.send(response({ result: { text: withText ? '我正在说潮汕话。' : '', additions } }, { flags: 3 }));
    }));
    const asr = createVolcAsr({ env, connect: server.connect });
    assert.deepEqual((await asr.transcribeWithLanguage(wav(), 'audio/wav')).language, { kind: 'unknown' });
    withText = false;
    await assert.rejects(asr.transcribeWithLanguage(wav(), 'audio/wav'), code('ASR_EMPTY'));
    assert.equal(server.connections(), 2);
  }
});

test('conflicting or mixed final language tags return unknown rather than choosing whichever appears first', async (t) => {
  const cases = [
    { lid_lang: 'speech_mand', lang_code: 'speech_dia_chao' },
    { lid_lang: 'speech_dia_hak', language_code: 'unrecognised' },
  ];
  for (const additions of cases) {
    const server = await peer(t, socket => socket.on('message', data => {
      const packet = request(data);
      socket.send(packet.type === 1 ? response({}) : response({ result: { text: '一段文字', additions } }, { flags: 3 }));
    }));
    assert.deepEqual((await createVolcAsr({ env, connect: server.connect }).transcribeWithLanguage(wav(), 'audio/wav')).language, { kind: 'unknown' });
  }
  const mixed = await peer(t, socket => socket.on('message', data => {
    const packet = request(data);
    socket.send(packet.type === 1 ? response({}) : response({ result: { text: '混合的一段话', utterances: [
      { additions: { lid_lang: 'speech_dia_hak' } }, { additions: { lid_lang: 'speech_mand' } },
    ] } }, { flags: 3 }));
  }));
  assert.deepEqual((await createVolcAsr({ env, connect: mixed.connect }).transcribeWithLanguage(wav(), 'audio/wav')).language, { kind: 'unknown' });
});

test('language classification uses the final response only and never carries an earlier label into an empty final', async (t) => {
  const server = await peer(t, socket => socket.on('message', data => {
    const packet = request(data);
    if (packet.type === 1) socket.send(response({ additions: { lid_lang: 'speech_dia_chao' } }));
    else if (packet.final) {
      socket.send(response({ result: { text: '旧中间结果', additions: { lid_lang: 'speech_dia_hak' } } }));
      socket.send(response({ result: { text: '' } }, { flags: 3 }));
    }
  }));
  await assert.rejects(createVolcAsr({ env, connect: server.connect }).transcribeWithLanguage(wav(), 'audio/wav'), code('ASR_EMPTY'));
  assert.equal(server.connections(), 1);
});

test('optional language metadata is bounded without recursively searching unrelated payload content', async (t) => {
  const cases = [
    { additions: ' '.repeat(4_097), text: '一段文字' },
    { additions: { arbitrary: { lid_lang: 'speech_dia_chao' } }, text: '一段文字' },
    { additions: { lid_lang: 'speech_dia_chao' }, utterances: Array.from({ length: 65 }, () => ({ additions: { lid_lang: 'speech_dia_chao' } })), text: '一段文字' },
  ];
  for (const result of cases) {
    const server = await peer(t, socket => socket.on('message', data => {
      socket.send(request(data).type === 1 ? response({}) : response({ result }, { flags: 3 }));
    }));
    assert.deepEqual((await createVolcAsr({ env, connect: server.connect }).transcribeWithLanguage(wav(), 'audio/wav')).language, { kind: 'unknown' });
  }
});

test('language-aware ASR can retain same-call speaker payload and existing asynchronous transport parameters', async (t) => {
  const parameters = { enable_nonstream: true, enable_speaker_info: true, show_utterances: true, ssd_mode: 2,
    voiceprints: [{ id: '', group_id: 'synthetic-test-group' }] };
  const payload = { result: { text: '你好', additions: { lid_lang: 'speech_mand' }, utterances: [{ speaker: 'synthetic-speaker' }] } };
  const server = await peer(t, socket => socket.on('message', data => {
    const packet = request(data);
    if (packet.type === 1) {
      const config = JSON.parse(packet.body.toString()).request;
      for (const [key, value] of Object.entries(parameters)) assert.deepEqual(config[key], value);
      assert.equal(config.enable_lid, true);
      socket.send(response({}));
    } else if (packet.final) socket.send(response(payload, { flags: 3 }));
  }));
  const asr = createVolcAsr({ env, connect(url, options) {
    assert.equal(url, 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async');
    return server.connect(officialUrl, options);
  } });
  assert.deepEqual(await asr.transcribeWithLanguage(wav(), 'audio/wav', undefined, parameters), {
    text: '你好', payload, language: { kind: 'mandarin', code: 'speech_mand' },
  });
  assert.equal(server.connections(), 1);
});

test('language-aware ASR preserves cancellation and does not retry a provider error even when a label is available', async (t) => {
  const controller = new AbortController();
  let packets = 0;
  const aborted = await peer(t, socket => socket.on('message', data => {
    const packet = request(data);
    if (packet.type === 1) socket.send(response({}));
    else { packets++; controller.abort(); socket.send(response({ result: { additions: { lid_lang: 'speech_dia_chao' } } }, { flags: 3 })); }
  }));
  await assert.rejects(createVolcAsr({ env, connect: aborted.connect }).transcribeWithLanguage(wav(9_600), 'audio/wav', controller.signal), code('ASR_CANCELLED'));
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(packets, 1); assert.equal(aborted.connections(), 1);
  const failure = await peer(t, socket => socket.on('message', data => {
    socket.send(request(data).type === 1 ? response({}) : response({ code: 45000002, result: { additions: { lid_lang: 'speech_dia_chao' } } }, { flags: 3 }));
  }));
  await assert.rejects(createVolcAsr({ env, connect: failure.connect }).transcribeWithLanguage(wav(), 'audio/wav'), code('ASR_EMPTY'));
  assert.equal(failure.connections(), 1);
});
