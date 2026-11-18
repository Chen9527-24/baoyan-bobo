import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, runtimeConfig } from '../apps/server/src/runtime.js';

const production = (dataPath: string) => ({ NODE_ENV: 'production', PUBLIC_HOST: 'trial.fixture.testing',
  ALLOWED_ORIGINS: 'https://trial.fixture.testing', DATA_PATH: dataPath, TRIAL_ENABLED: 'true', TRIAL_ENDS_AT: '2099-01-01T00:00:00+08:00' });
function dir(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), 'baoyan-deployment-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
async function listen(runtime: ReturnType<typeof createRuntime>) {
  await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const address = runtime.server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('production requires a real same-domain HTTPS origin, persistent path and built web files', t => {
  const root = dir(t); const env = production(join(root, 'data.sqlite'));
  assert.throws(() => runtimeConfig({ ...env, PUBLIC_HOST: 'localhost' }), /PUBLIC_HOST/);
  assert.throws(() => runtimeConfig({ ...env, PUBLIC_HOST: '127.0.0.1' }), /PUBLIC_HOST/);
  assert.throws(() => runtimeConfig({ ...env, ALLOWED_ORIGINS: 'http://trial.fixture.testing' }), /ALLOWED_ORIGINS/);
  assert.throws(() => runtimeConfig({ ...env, ALLOWED_ORIGINS: 'https://trial.fixture.testing,https://other.com' }), /ALLOWED_ORIGINS/);
  assert.throws(() => runtimeConfig({ ...env, DATA_PATH: '.data/local.sqlite' }), /DATA_PATH/);
  assert.throws(() => createRuntime({ env, webRoot: root }), /未构建/);
});

test('production serves built HTML/assets and real health, but no API fallback, directory listing, source or secrets', async t => {
  const root = dir(t); mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'index.html'), '<!doctype html><title>built app</title>');
  writeFileSync(join(root, 'assets', 'app-test123.js'), 'console.log("built");');
  writeFileSync(join(root, '.env'), 'PRIVATE=must-not-serve'); writeFileSync(join(root, 'source.ts'), 'must-not-serve');
  const runtime = createRuntime({ env: production(join(root, 'test.sqlite')), webRoot: root }); t.after(() => runtime.close());
  const base = await listen(runtime);
  const home = await fetch(`${base}/`); assert.equal(home.status, 200); assert.match(await home.text(), /built app/);
  assert.equal(home.headers.get('cache-control'), 'no-store'); assert.equal(home.headers.get('x-robots-tag'), 'noindex, nofollow');
  for (const path of ['/admin', '/admin/']) { const entry = await fetch(`${base}${path}`); assert.equal(entry.status, 200); assert.match(await entry.text(), /built app/); assert.equal(entry.headers.get('cache-control'), 'no-store'); }
  const asset = await fetch(`${base}/assets/app-test123.js`); assert.equal(asset.status, 200); assert.match(asset.headers.get('cache-control')!, /immutable/);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  assert.equal((await (await fetch(`${base}/api/bootstrap`)).json()).capabilities.chat, false, 'test does not inherit provider credentials');
  for (const path of ['/.env', '/source.ts', '/src/main.tsx', '/assets/', '/hold-check.html', '/audio-check.html']) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  const missing = await fetch(`${base}/api/unknown`); assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type')!, /json/); assert.equal((await missing.json()).code, 'NOT_FOUND');
});

test('local built preview is opt-in and remains possible without production cookies or providers', async t => {
  const root = dir(t); writeFileSync(join(root, 'index.html'), '<title>local preview</title>');
  assert.equal(runtimeConfig({}).serveWeb, false);
  const runtime = createRuntime({ env: { NODE_ENV: 'development', SERVE_WEB: 'true', DATA_PATH: join(root, 'preview.sqlite') }, webRoot: root });
  t.after(() => runtime.close()); const base = await listen(runtime); assert.equal((await fetch(`${base}/`)).status, 200);
});

test('shutdown ends SSE before waiting for HTTP close and is idempotent', async t => {
  const app = express(); let subscriber: import('express').Response | undefined, closes = 0;
  app.get('/api/events', (_req, res) => { subscriber = res; res.type('text/event-stream').flushHeaders(); res.write(': ready\n\n'); });
  app.locals.close = () => { closes++; subscriber?.end(); };
  const runtime = createRuntime({ env: {}, app, shutdownTimeoutMs: 100 }); t.after(() => runtime.close()); const base = await listen(runtime);
  const response = await fetch(`${base}/api/events`); const reader = response.body!.getReader(); await reader.read();
  const first = runtime.close(); assert.equal(first, runtime.close()); await first;
  assert.equal(closes, 1); assert.equal((await reader.read()).done, true); reader.releaseLock();
});

test('shutdown has a bounded drain for a stuck HTTP response', async t => {
  const app = express(); let closeCalled = false;
  app.get('/stuck', (_req, res) => { res.type('text').flushHeaders(); res.write('pending'); }); app.locals.close = () => { closeCalled = true; };
  const runtime = createRuntime({ env: {}, app, shutdownTimeoutMs: 30 }); t.after(() => runtime.close()); const base = await listen(runtime);
  const response = await fetch(`${base}/stuck`); const drain = response.text().catch(() => 'closed');
  const started = Date.now(); await runtime.close(); assert.ok(closeCalled); assert.ok(Date.now() - started < 1500); await drain;
});
