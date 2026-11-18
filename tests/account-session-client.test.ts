import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../apps/web/src/lib/api.js';
import { createAccountSessionCheck, ACCOUNT_CHECK_INTERVAL, type AccountSession } from '../apps/web/src/lib/accountSession.js';
const valid: AccountSession = {signedIn:true,pending:false,childName:'虚构小星',hasPin:true};

test('foreground session check revokes on confirmed expiry only once and does not replay old authorization', async()=>{
 let revoked=0;const check=createAccountSessionCheck({read:async()=>{throw new ApiError('expired',401,'ACCOUNT_REQUIRED');},isCurrent:()=>true,onInvalidated:()=>revoked++});
 await check.check();await check.check();assert.equal(revoked,1);assert.equal(ACCOUNT_CHECK_INTERVAL,20_000);
});
test('temporary network/provider failure does not sign out an otherwise valid account',async()=>{
 for(const cause of [new Error('offline'),new ApiError('busy',503),new ApiError('bad input',400)]){
  let revoked=0;const check=createAccountSessionCheck({read:async()=>{throw cause;},isCurrent:()=>true,onInvalidated:()=>revoked++});
  await check.check();assert.equal(revoked,0);check.stop();
 }
});
test('session checks coalesce and disposed late 401 cannot sign out a subsequent login',async()=>{
 let resolve!:()=>void;let reads=0;let revoked=0;
 const read=new Promise<void>(done=>{resolve=done;});
 const check=createAccountSessionCheck({read:async()=>{reads++;await read;throw new ApiError('old session',401);},isCurrent:()=>true,onInvalidated:()=>revoked++});
 const first=check.check();await check.check();assert.equal(reads,1);check.stop();resolve();await first;assert.equal(revoked,0);
});
test('hidden/superseded authorization does not check or act on pending state',async()=>{
 let current=false;let reads=0;let revoked=0;
 const check=createAccountSessionCheck({read:async()=>{reads++;return valid;},isCurrent:()=>current,onInvalidated:()=>revoked++});
 await check.check();assert.equal(reads,0);current=true;await check.check();assert.equal(reads,1);assert.equal(revoked,0);check.stop();
});
test('paused or administratively disabled account 403 invalidates local use',async()=>{
 let revoked=0;const check=createAccountSessionCheck({read:async()=>{throw new ApiError('disabled',403);},isCurrent:()=>true,onInvalidated:()=>revoked++});
 await check.check();assert.equal(revoked,1);
});
