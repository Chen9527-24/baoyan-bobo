import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdminAccount, AdminFamily } from '../apps/web/src/lib/admin.js';
import type { Bootstrap } from '../apps/web/src/lib/types.js';

register('data:text/javascript,' + encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
  return nextLoad(url, context);
}`), import.meta.url);
const { AdminAccountCard, AdminFamilyCard } = await import('../apps/web/src/components/AdminPanel.js');
const { AccountOnboarding } = await import('../apps/web/src/components/AccountOnboarding.js');
const { AccountPanel } = await import('../apps/web/src/components/AccountPanel.js');
const noop = () => {};
function render(element: React.ReactElement) {
  const runtime = globalThis as unknown as { React?: typeof React };
  const previous = runtime.React;
  try { runtime.React = React; return renderToStaticMarkup(element); }
  finally { if (previous) runtime.React = previous; else delete runtime.React; }
}
const family: AdminFamily = {
  id: 'fictional-family', status: 'active', revision: 0, accountCount: 2, memberCount: 1, deviceCount: 2,
  displayName: '虚构小星的家庭', childNames: ['虚构小星', '虚构小月'],
  contacts: [
    { accountId: 'account-a', username: 'fictional.owner', guardian: false, contactPhone: '+12025550101' },
    { accountId: 'account-b', username: 'fictional.guardian', guardian: true, contactPhone: '' },
  ],
};
const account: AdminAccount = {
  id: 'account-a', username: 'fictional.owner', familyId: family.id, guardian: false,
  createdAt: '2026-10-14T00:00:00Z', status: 'active', revision: 0, deviceCount: 1,
  contactPhone: '+12025550101', familyName: family.displayName, childNames: family.childNames,
};
const data: Bootstrap = {
  configured: true, mode: 'demo', capabilities: { chat: false, asr: false, tts: false, voiceprint: false },
  child: { id: 'fictional-child', nickname: '虚构小星', ageGroup: '6-8', outfit: 'mint', showCaptions: true, memoryEnabled: true, voiceEnabled: true, sessionMinutes: 10, dailyMinutes: 20 },
  parentAuthorized: true, memoryCount: 0, memberCount: 0, globalMemories: [], remainingDailySeconds: 1200,
};

test('family card leads with current child name and keeps each contact tied to its own account', () => {
  const markup = render(React.createElement(AdminFamilyCard, { item: family, onStatus: noop }));
  assert.ok(markup.indexOf('虚构小星的家庭') < markup.indexOf('家庭编号'));
  for (const value of ['虚构小星、虚构小月', 'fictional.owner', 'fictional.guardian', '+12025550101', '未填写手机号', '家庭创建者', '关联家长', '未经短信验证', '1 位已登记家人']) assert.ok(markup.includes(value), value);
  assert.equal((markup.match(/\+12025550101/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /href="tel:|已验证|已认证手机号/);
});
test('family without contacts shows an honest empty state and escapes untrusted nicknames', () => {
  const markup = render(React.createElement(AdminFamilyCard, { item: { ...family, displayName: '<script>虚构昵称</script>的家庭', contacts: [], childNames: [] }, onStatus: noop }));
  assert.match(markup, /暂无已绑定账号，未填写手机号/);
  assert.match(markup, /尚未设置孩子昵称/);
  assert.match(markup, /&lt;script&gt;虚构昵称&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>|\+12025550101/);
});
test('account card distinguishes family, account identity and self-reported phone', () => {
  const markup = render(React.createElement(AdminAccountCard, { item: account, onRecovery: noop, onStatus: noop }));
  for (const value of ['虚构小星的家庭', '联系电话', '+12025550101', '自填 · 未验证', '账号编号', '家庭编号']) assert.ok(markup.includes(value), value);
  const empty = render(React.createElement(AdminAccountCard, { item: { ...account, contactPhone: '', familyId: null, familyName: '', childNames: [] }, onRecovery: noop, onStatus: noop }));
  assert.match(empty, /未填写/); assert.match(empty, /尚未加入家庭/); assert.doesNotMatch(empty, /\+12025550101|自填 · 未验证/);
});
test('both account registration entries require telephone and retain no SMS or complexity requirements', () => {
  const pages = [
    render(React.createElement(AccountOnboarding, { data: { ...data, configured: false, child: null }, onLogin: noop, onComplete: noop, onCreate: noop, onBusyChange: noop })),
    render(React.createElement(AccountPanel, { data, initialAction: 'register', onSessionChange: noop, onBusyChange: noop })),
  ];
  for (const markup of pages) {
    const field = markup.match(/<input[^>]*type="tel"[^>]*>/)?.[0];
    assert.ok(field); assert.match(field, /required=/); assert.match(field, /inputMode="tel"/);
    assert.match(markup, /联系手机号/); assert.match(markup, /仅用于运营联系，不做短信验证/);
    assert.doesNotMatch(markup, /发送验证码|获取验证码|必须包含/);
  }
});
test('only signed-in and parent-authorized accounts mount their own contact editor', () => {
  const signedIn = { bound: true, signedIn: true, username: 'fictional.owner', guardian: true };
  const allowed = render(React.createElement(AccountPanel, { data: { ...data, account: signedIn }, onSessionChange: noop, onBusyChange: noop }));
  assert.match(allowed, /本人联系电话/); assert.match(allowed, /账号 fictional.owner 的联系方式/); assert.match(allowed, /不用于登录或找回密码/);
  for (const limited of [{ ...data, account: { ...signedIn, signedIn: false } }, { ...data, account: signedIn, parentAuthorized: false }, data]) {
    const markup = render(React.createElement(AccountPanel, { data: limited, onSessionChange: noop, onBusyChange: noop }));
    assert.doesNotMatch(markup, /本人联系电话|正在读取本人联系方式/);
  }
});
