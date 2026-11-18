import assert from 'node:assert/strict';
import test from 'node:test';
import { accountRecoveryUrl, adminGet, adminListQuery, adminPost, adminRoute, adminTime, parseAdminLaunch } from '../apps/web/src/lib/admin.js';
import { ApiError } from '../apps/web/src/lib/api.js';
const token = 'a'.repeat(43);

test('admin launch handles one fragment secret and rejects ambiguous or malformed links', () => {
  assert.deepEqual(parseAdminLaunch(`#setup=${token}`), { kind: 'setup', token });
  assert.deepEqual(parseAdminLaunch(`#recover=${token}`), { kind: 'recover', token });
  for (const input of ['', '#', '?setup=secret', '#setup=', '#setup=short', `#setup=${token}&recover=${token}`, '#recover=%3Cscript%3E', '#setup='+'x'.repeat(201)]) assert.equal(parseAdminLaunch(input), null, input);
});
test('recovery URL is a same-origin fragment link and never a query token', () => {
  const link = new URL(accountRecoveryUrl('https://bobo.test', token));
  assert.equal(link.origin, 'https://bobo.test'); assert.equal(link.pathname, '/admin'); assert.equal(link.search, ''); assert.equal(link.hash, `#recover=${token}`);
  assert.throws(() => accountRecoveryUrl('https://bobo.test', 'x/y?bad#'));
});
test('list queries omit empty status and safely encode search plus pagination', () => {
  const all = new URLSearchParams(adminListQuery(0, '', ''));
  assert.equal(all.has('status'), false); assert.equal(all.get('offset'), '0'); assert.equal(all.get('limit'), '20');
  const searched = new URLSearchParams(adminListQuery(20, '  用户&status=disabled  ', 'active'));
  assert.equal(searched.get('q'), '用户&status=disabled'); assert.equal(searched.getAll('status').length, 1); assert.equal(searched.get('status'), 'active'); assert.equal(searched.get('offset'), '20');
});
test('admin navigation recognizes only dedicated route and formats missing dates safely', () => {
  assert.equal(adminRoute('/admin'), true); assert.equal(adminRoute('/admin/'), true);
  for (const path of ['/', '/administrator', '/admin-other', '/admin/recover', '/parent']) assert.equal(adminRoute(path), false);
  assert.equal(adminTime(undefined), '—'); assert.equal(adminTime(null), '—'); assert.equal(adminTime('no-date'), '—');
  assert.match(adminTime('2026-10-14T00:00:00.000Z'), /8:00:00|08:00:00/);
});
test('admin reads use distinct namespace, no-store and same-origin credentials', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const requests: { path: string; init: RequestInit }[] = [];
  Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
  globalThis.fetch = async (path, init) => { requests.push({ path: String(path), init: init! }); return new Response(JSON.stringify({ initialized: false, authenticated: false }), { headers: { 'Content-Type': 'application/json' } }); };
  try {
    await adminGet('/session'); await adminPost('/accounts/test/status', { revision: 3, reason: '用户要求', status: 'disabled', confirm: true });
    assert.equal(requests[0]!.path, '/api/admin/session'); assert.equal(requests[0]!.init.cache, 'no-store'); assert.equal(requests[0]!.init.credentials, 'same-origin');
    assert.equal(requests[1]!.path, '/api/admin/accounts/test/status'); assert.equal(requests[1]!.init.method, 'POST'); assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { revision: 3, reason: '用户要求', status: 'disabled', confirm: true });
    assert.equal(requests.some(item => item.path.startsWith('/api/parent') || item.path.startsWith('/api/debug')), false);
  } finally { Object.assign(globalThis, { window: previousWindow }); globalThis.fetch = previousFetch; }
});
test('admin authorization failures preserve status for immediate UI session lock', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '请重新登录', code: 'ADMIN_REQUIRED' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  try { await assert.rejects(adminGet('/accounts'), error => error instanceof ApiError && error.status === 401 && error.code === 'ADMIN_REQUIRED'); }
  finally { Object.assign(globalThis, { window: previousWindow }); globalThis.fetch = previousFetch; }
});
