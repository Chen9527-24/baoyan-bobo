import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { accountKdfStatus, createAccountStore, type Account } from '../apps/server/src/account-store.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

const PASSWORD = 'River lantern forest #2026';
const NEW_PASSWORD = 'Lantern meadow silver #2027';
const LATER_PASSWORD = 'Quiet valley moonlight #2028';
const noop = () => {};
const code = (value: string) => (error: unknown) => error instanceof ApiError && error.code === value;
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE families(id TEXT PRIMARY KEY);
    CREATE TABLE devices(token_hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE);
    CREATE TABLE software_device_links(code_hash TEXT PRIMARY KEY,family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE);`);
  let time = Date.UTC(2026, 8, 30);
  let dbClosed = false;
  const store = createAccountStore({ db, now: () => time });
  const closeDb = () => { if (!dbClosed) { db.close(); dbClosed = true; } };
  t.after(() => { store.close(); closeDb(); });
  function family() { const id = randomUUID(); db.prepare('INSERT INTO families VALUES(?)').run(id); return id; }
  function device(familyId: string) { const id = randomUUID(); db.prepare('INSERT INTO devices VALUES(?,?)').run(id, familyId); return id; }
  const familyId = family(), deviceHash = device(familyId);
  const register = (name = 'TestParent', targetFamily = familyId, targetDevice = deviceHash, password = PASSWORD) => store.register({ familyId: targetFamily, deviceHash: targetDevice, username: name, password, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: noop });
  return { db, store, familyId, deviceHash, family, device, register, closeDb, advance: (ms: number) => { time += ms; } };
}

test('register salts and hashes password/code, normalizes username and persists device-bound session', async t => {
  const f = fixture(t), registered = await f.register();
  assert.equal(registered.account.username, 'testparent');
  assert.equal(registered.account.familyId, f.familyId);
  assert.equal(registered.account.passwordRevision, 1);
  assert.match(registered.recoveryCode, /^[A-Za-z0-9_-]{43}$/);
  const row = f.db.prepare('SELECT * FROM accounts').get() as any;
  assert.match(row.password_salt, /^[a-f0-9]{64}$/);
  assert.match(row.password_hash, /^[a-f0-9]{128}$/);
  assert.equal(row.recovery_hash, createHash('sha256').update(registered.recoveryCode).digest('hex'));
  assert.equal(JSON.stringify(row).includes(PASSWORD), false);
  assert.equal(JSON.stringify(row).includes(registered.recoveryCode), false);
  assert.equal(JSON.stringify(registered.account).includes('hash'), false);
  assert.deepEqual(f.store.summary(f.familyId, f.deviceHash), { bound: true, signedIn: true, username: 'testparent', childName:'虚构小雨',hasPin:true,expiresAt: '2026-10-30T00:00:00.000Z' });
  f.store.assertDevice(f.deviceHash);
  const authenticated = await f.store.authenticate({ username: 'TESTPARENT', password: PASSWORD, ip: '127.0.0.1' });
  assert.deepEqual(authenticated, registered.account);
  f.store.assertAccount(authenticated);
  const otherStore = createAccountStore({ db: f.db, now: () => Date.UTC(2026, 8, 30) });
  assert.equal(otherStore.summary(f.familyId, f.deviceHash).signedIn, true); otherStore.close();
});

test('registration rejects invalid lengths/control characters and duplicate account/family conflicts without new rows', async t => {
  const f = fixture(t);
  for (const password of ['', '1234567', 'a'.repeat(129), '12345678\n']) {
    await assert.rejects(f.register('TestParent', f.familyId, f.deviceHash, password), (error: any) => error.code === 'ACCOUNT_PASSWORD_INVALID');
  }
  for (const username of ['ab', '中文账号', 'parent@email.test', 'a'.repeat(33)]) await assert.rejects(f.register(username), code('ACCOUNT_USERNAME_INVALID'));
  await f.register('_Parent');
  const second = f.family(), secondDevice = f.device(second);
  await assert.rejects(f.register('_PARENT', second, secondDevice), code('ACCOUNT_CONFLICT'));
  await assert.rejects(f.register('otherparent'), code('ACCOUNT_CONFLICT'));
  assert.equal(Number((f.db.prepare('SELECT count(*) AS n FROM accounts').get() as any).n), 1);
});

test('unbound guests remain valid but accounts cannot attach or sign in across family devices', async t => {
  const f = fixture(t), registered = await f.register();
  const otherFamily = f.family(), otherDevice = f.device(otherFamily), sameGuest = f.device(f.familyId);
  f.store.assertDevice(otherDevice); f.store.assertDevice(sameGuest);
  assert.deepEqual(f.store.summary(otherFamily, otherDevice), { bound: false, signedIn: false });
  assert.equal(f.store.summary(f.familyId, otherDevice).signedIn, false);
  assert.equal(f.store.summary(f.familyId, sameGuest).signedIn, false);
  assert.throws(() => f.store.attach(registered.account.id, otherDevice), code('ACCOUNT_REQUIRED'));
  f.store.attach(registered.account.id, sameGuest);
  assert.equal(f.store.summary(f.familyId, sameGuest).signedIn, true);
});

test('deleting a device logs out its session; expired sessions cannot become guest and sweep revokes the device', async t => {
  const f = fixture(t), registered = await f.register(), secondDevice = f.device(f.familyId), guest = f.device(f.familyId);
  f.store.attach(registered.account.id, secondDevice);
  f.db.prepare('DELETE FROM devices WHERE token_hash=?').run(secondDevice);
  assert.equal(f.db.prepare('SELECT * FROM account_sessions WHERE device_hash=?').get(secondDevice), undefined);
  assert.equal(f.store.summary(f.familyId, secondDevice).signedIn, false);
  const currentDevice=f.device(f.familyId);f.store.attach(registered.account.id,currentDevice);
  f.advance(30 * 86_400_000);
  assert.throws(() => f.store.assertDevice(currentDevice), code('ACCOUNT_REQUIRED'));
  assert.equal(f.store.summary(f.familyId, f.deviceHash).signedIn, false);
  assert.deepEqual(f.store.sweep(), [{ familyId: f.familyId, deviceHash: currentDevice }]);
  assert.equal(f.db.prepare('SELECT * FROM devices WHERE token_hash=?').get(currentDevice), undefined);
  assert.ok(f.db.prepare('SELECT * FROM devices WHERE token_hash=?').get(guest));
  assert.equal(f.store.accountForFamily(f.familyId)?.id, registered.account.id);
});

test('a deleted account retains an invalid session marker until its device is revoked', async t => {
  const f = fixture(t), registered = await f.register();
  f.db.prepare('DELETE FROM accounts WHERE id=?').run(registered.account.id);
  assert.equal((f.db.prepare('SELECT account_id FROM account_sessions WHERE device_hash=?').get(f.deviceHash) as any).account_id, null);
  assert.throws(() => f.store.assertDevice(f.deviceHash), code('ACCOUNT_REQUIRED'));
  assert.deepEqual(f.store.sweep(), [{ familyId: f.familyId, deviceHash: f.deviceHash }]);
});

test('wrong password and unknown username use the same errors and never attach sessions', async t => {
  const f = fixture(t); await f.register();
  await assert.rejects(f.store.authenticate({ username: 'testparent', password: NEW_PASSWORD, ip: '192.0.2.1' }), code('ACCOUNT_AUTH_FAILED'));
  await assert.rejects(f.store.authenticate({ username: 'unknownparent', password: NEW_PASSWORD, ip: '192.0.2.1' }), code('ACCOUNT_AUTH_FAILED'));
  assert.equal(Number((f.db.prepare('SELECT count(*) AS n FROM account_sessions').get() as any).n), 1);
});

test('password change revokes every family device and link, returns expected new revision and rotates recovery', async t => {
  const f = fixture(t), registered = await f.register(), second = f.device(f.familyId), guest = f.device(f.familyId);
  const unaffectedFamily = f.family(), unaffectedDevice = f.device(unaffectedFamily);
  f.store.attach(registered.account.id, second);
  f.db.prepare('INSERT INTO software_device_links VALUES(?,?)').run('test-link', f.familyId);
  const changed = await f.store.changePassword({ accountId: registered.account.id, password: PASSWORD, newPassword: NEW_PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: noop });
  assert.deepEqual(new Set(changed.revokedDevices), new Set([second, guest]));
  assert.equal(changed.account.passwordRevision, 2); f.store.assertAccount(changed.account);
  assert.equal(f.db.prepare('SELECT * FROM devices WHERE family_id=?').get(f.familyId), undefined);
  assert.equal(f.db.prepare('SELECT * FROM account_sessions').get(), undefined);
  assert.equal(f.db.prepare('SELECT * FROM software_device_links').get(), undefined);
  assert.ok(f.db.prepare('SELECT * FROM devices WHERE token_hash=?').get(unaffectedDevice));
  await assert.rejects(f.store.authenticate({ username: 'testparent', password: PASSWORD, ip: '192.0.2.1' }), code('ACCOUNT_AUTH_FAILED'));
  const account = await f.store.authenticate({ username: 'testparent', password: NEW_PASSWORD, ip: '192.0.2.1' });
  assert.equal(account.passwordRevision, 2);
  assert.throws(() => f.store.assertAccount(registered.account), code('ACCOUNT_REQUIRED'));
  assert.notEqual(changed.recoveryCode, registered.recoveryCode);
});

test('recovery consumes its code once, revokes devices/links and requires a separate login', async t => {
  const f = fixture(t), registered = await f.register();
  f.device(f.familyId); f.db.prepare('INSERT INTO software_device_links VALUES(?,?)').run('recovery-link', f.familyId);
  const recovered = await f.store.recover({ username: 'TESTPARENT', recoveryCode: registered.recoveryCode, newPassword: NEW_PASSWORD, ip: '192.0.2.3' });
  assert.equal(recovered.ok, true); assert.equal(recovered.familyId, f.familyId); assert.equal(recovered.revokedDevices.length, 2);
  assert.equal(f.db.prepare('SELECT * FROM devices WHERE family_id=?').get(f.familyId), undefined);
  assert.equal(f.db.prepare('SELECT * FROM account_sessions').get(), undefined);
  assert.equal((f.db.prepare('SELECT recovery_hash FROM accounts').get() as any).recovery_hash, null);
  await assert.rejects(f.store.recover({ username: 'testparent', recoveryCode: registered.recoveryCode, newPassword: LATER_PASSWORD, ip: '192.0.2.3' }), code('ACCOUNT_AUTH_FAILED'));
  assert.equal((await f.store.authenticate({ username: 'testparent', password: NEW_PASSWORD, ip: '192.0.2.3' })).id, registered.account.id);
  assert.equal(f.store.summary(f.familyId, f.deviceHash).signedIn, false);
});

test('concurrent recoveries cannot both consume the same code or overwrite the winner password', async t => {
  const f = fixture(t), registered = await f.register();
  const passwords = [NEW_PASSWORD, LATER_PASSWORD];
  const outcomes = await Promise.allSettled(passwords.map(newPassword => f.store.recover({ username: 'testparent', recoveryCode: registered.recoveryCode, newPassword, ip: '192.0.2.4' })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const failed = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.code, 'ACCOUNT_AUTH_FAILED');
  const winner = outcomes.findIndex(outcome => outcome.status === 'fulfilled');
  assert.equal((await f.store.authenticate({ username: 'testparent', password: passwords[winner], ip: '192.0.2.4' })).passwordRevision, 2);
  await assert.rejects(f.store.authenticate({ username: 'testparent', password: passwords[1 - winner], ip: '192.0.2.4' }), code('ACCOUNT_AUTH_FAILED'));
});

test('rotating recovery requires the current password and leaves valid device sessions signed in', async t => {
  const f = fixture(t), registered = await f.register();
  const rotated = await f.store.rotateRecovery({ accountId: registered.account.id, password: PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: noop });
  assert.notEqual(rotated.recoveryCode, registered.recoveryCode);
  assert.equal(f.store.summary(f.familyId, f.deviceHash).signedIn, true);
  await assert.rejects(f.store.recover({ username: 'testparent', recoveryCode: registered.recoveryCode, newPassword: NEW_PASSWORD, ip: '192.0.2.5' }), code('ACCOUNT_AUTH_FAILED'));
  await f.store.recover({ username: 'testparent', recoveryCode: rotated.recoveryCode, newPassword: NEW_PASSWORD, ip: '192.0.2.5' });
});

test('authorization is rechecked after asynchronous hashing for register and password proof', async t => {
  const f = fixture(t); let allowed = true;
  const authorize = () => { if (!allowed) throw new ApiError(403, 'test authorization expired', 'PARENT_REQUIRED'); };
  const pending = f.store.register({ familyId: f.familyId, deviceHash: f.deviceHash, username: 'testparent', password: PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: authorize });
  allowed = false; await assert.rejects(pending, code('PARENT_REQUIRED'));
  assert.equal(f.store.accountForFamily(f.familyId), undefined);
  const registered = await f.register(); allowed = true;
  const proof = f.store.verifyPassword({ accountId: registered.account.id, password: PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: authorize });
  allowed = false; await assert.rejects(proof, code('PARENT_REQUIRED'));
});

test('password version changes while a proof is hashing invalidate its result', async t => {
  const f = fixture(t), registered = await f.register();
  const proof = f.store.verifyPassword({ accountId: registered.account.id, password: PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: noop });
  f.db.prepare('UPDATE accounts SET password_revision=password_revision+1 WHERE id=?').run(registered.account.id);
  await assert.rejects(proof, code('ACCOUNT_CHANGED'));
  assert.throws(() => f.store.assertDevice(f.deviceHash), code('ACCOUNT_REQUIRED'));
});

test('concurrent recovery rotation protects the version observed before the password KDF', async t => {
  const f = fixture(t), registered = await f.register();
  const outcomes = await Promise.allSettled(Array.from({ length: 2 }, () => f.store.rotateRecovery({ accountId: registered.account.id, password: PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: noop })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal((outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult).reason.code, 'ACCOUNT_CHANGED');
});

test('username and IP throttle persist across stores and store only hashed buckets', async t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) await assert.rejects(f.store.authenticate({ username: 'missingparent', password: PASSWORD, ip: '198.51.100.8' }), code('ACCOUNT_AUTH_FAILED'));
  const second = createAccountStore({ db: f.db, now: () => Date.UTC(2026, 8, 30) });
  await assert.rejects(second.authenticate({ username: 'MISSINGPARENT', password: PASSWORD, ip: '198.51.100.9' }), code('ACCOUNT_THROTTLED')); second.close();
  const stored = JSON.stringify(f.db.prepare('SELECT * FROM account_attempts').all());
  assert.equal(stored.includes('missingparent'), false); assert.equal(stored.includes('198.51.100.8'), false);
  const ipBucket = createHash('sha256').update('ip:198.51.100.10').digest('hex');
  f.db.prepare('INSERT INTO account_attempts VALUES(?,100,?)').run(ipBucket, Date.UTC(2026, 8, 30) + 15 * 60_000);
  await assert.rejects(f.store.authenticate({ username: 'anotherparent', password: PASSWORD, ip: '198.51.100.10' }), code('ACCOUNT_THROTTLED'));
  f.advance(15 * 60_000); f.store.sweep();
  await assert.rejects(f.store.authenticate({ username: 'missingparent', password: PASSWORD, ip: '198.51.100.8' }), code('ACCOUNT_AUTH_FAILED'));
});

test('KDF running and waiting work is bounded globally across independent stores', async t => {
  const f = fixture(t), second = createAccountStore({ db: f.db }); t.after(() => second.close());
  const tasks: Promise<unknown>[] = [];
  for (let i = 0; i < 12; i++) {
    const familyId = f.family(), deviceHash = f.device(familyId), store = i % 2 ? second : f.store;
    tasks.push(store.register({ familyId, deviceHash, username: `boundedparent${i}`, password: PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: noop }));
  }
  const status = accountKdfStatus();
  assert.equal(status.running, 2); assert.equal(status.queued, 8);
  const outcomes = await Promise.allSettled(tasks);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 10);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected' && outcome.reason.code === 'ACCOUNT_BUSY').length, 2);
  assert.equal(accountKdfStatus().running, 0); assert.equal(accountKdfStatus().queued, 0);
});

test('closing a store cancels queued/late hashing before any access to a closed database', async t => {
  const f = fixture(t), tasks: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) { const familyId = f.family(), deviceHash = f.device(familyId); tasks.push(f.store.register({ familyId, deviceHash, username: `closingparent${i}`, password: PASSWORD, contactPhone:'+12025550101',childName:'虚构小雨',pin:'123456',assertAuthorized: noop })); }
  const outcomes = Promise.allSettled(tasks); f.store.close();
  assert.throws(() => f.store.summary(f.familyId, f.deviceHash), code('SERVICE_STOPPED'));
  assert.equal(f.db.prepare('SELECT * FROM accounts').get(), undefined);
  f.closeDb();
  assert.equal((await outcomes).every(outcome => outcome.status === 'rejected' && outcome.reason.code === 'SERVICE_STOPPED'), true);
});

test('family withdrawal cascades accounts and sessions but cannot affect another family', async t => {
  const f = fixture(t), registered = await f.register();
  const otherFamily = f.family(), otherDevice = f.device(otherFamily), other = await f.register('OtherParent', otherFamily, otherDevice);
  f.db.prepare('DELETE FROM families WHERE id=?').run(f.familyId);
  assert.equal(f.store.accountForFamily(f.familyId), undefined);
  assert.equal(f.db.prepare('SELECT * FROM account_sessions WHERE device_hash=?').get(f.deviceHash), undefined);
  assert.throws(() => f.store.assertAccount(registered.account), code('ACCOUNT_REQUIRED'));
  assert.equal(f.store.accountForFamily(otherFamily)?.id, other.account.id);
  assert.equal(f.store.summary(otherFamily, otherDevice).signedIn, true);
});

test('eight-character numeric, repeated, common and username passwords register and authenticate', async t => {
  const f = fixture(t);
  for (const [index, password] of ['12345678', 'aaaaaaaa', 'password', 'simplepw', 'parent88'].entries()) {
    const target = f.family(), device = f.device(target), name = index === 4 ? 'parent88' : 'eight.' + index;
    const result = await f.register(name, target, device, password);
    const loggedIn = await f.store.authenticate({username:name,password,ip:'127.0.0.1'});
    assert.equal(loggedIn.id,result.account.id);
  }
});
