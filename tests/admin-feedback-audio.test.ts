import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp } from '../apps/server/src/app.js';
import { createAdminStore } from '../apps/server/src/admin-store.js';
const origin='http://localhost:5173';
function wav(){const b=Buffer.alloc(44+1600*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=0;i<1600;i++)b.writeInt16LE(Math.round(6000*Math.sin(i*Math.PI*2*440/16000)),44+i*2);return b;}
const binary=(res:NodeJS.ReadableStream,cb:(err:Error|null,body?:Buffer)=>void)=>{const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>cb(null,Buffer.concat(chunks)));res.on('error',cb);};
async function fixture(t:TestContext){
 const folder=mkdtempSync(join(tmpdir(),'baoyan-admin-audio-')),dataPath=join(folder,'fixture.sqlite');let at=1_800_000_000_000;
 const app=createApp({dataPath,now:()=>at,env:{}}),db=new DatabaseSync(dataPath);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
 const init=createAdminStore({db,now:()=>at}),ticket=init.createBootstrap();init.close();const admin=request.agent(app),guest=request.agent(app);
 await admin.post('/api/admin/bootstrap').set('Origin',origin).send({token:ticket.token,username:'audio.operator',password:'12345678'}).expect(200);
 await guest.get('/api/feedback/context').expect(200);const audio=wav();const report=(await guest.post('/api/feedback').set('Origin',origin).field('operationId',randomUUID()).field('text','合成反馈：声音突然停了').attach('audio',audio,{filename:'synthetic.wav',contentType:'audio/wav'}).expect(201)).body;
 t.after(()=>{app.locals.close();db.close();rmSync(folder,{recursive:true,force:true});});
 return{app,db,admin,guest,audio,id:report.id as string,expire:()=>{db.prepare('UPDATE feedback_reports SET expires_at=? WHERE id=?').run(at-1,report.id);}};
}
test('real HTTP feedback audio is byte-exact canonical WAV and never exposed to ordinary cookies',async t=>{
 const f=await fixture(t),path=`/api/admin/feedback/${f.id}/audio`;
 await f.guest.get(path).expect(401);await request(f.app).get(path).set('Cookie','baoyan_debug=not-an-admin; baoyan_parent=not-an-admin').expect(401);
 const list=await f.admin.get('/api/admin/feedback').expect(200);assert.equal(list.body.items[0].hasAudio,true);assert.equal(list.body.items[0].audioBytes,f.audio.length);assert.equal(JSON.stringify(list.body).includes('声音突然停了'),false);assert.equal(JSON.stringify(list.body).includes(f.audio.toString('base64')),false);
 const response=await f.admin.get(path).buffer(true).parse(binary).expect(200);assert.deepEqual(response.body,f.audio);assert.equal(response.headers['content-type'],'audio/wav');assert.equal(response.headers['content-disposition'],'inline; filename="feedback.wav"');assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(Number(response.headers['content-length']),f.audio.length);
 const audits=(await f.admin.get('/api/admin/audit').expect(200)).body.items;assert.equal(audits.filter((r:{action:string})=>r.action==='feedback.audio').length,1);assert.equal(JSON.stringify(audits).includes('声音突然停了'),false);
 await f.admin.post('/api/admin/logout').set('Origin',origin).send({}).expect(200);await f.admin.get(path).expect(401);
});
test('expired/deleted audio cannot be replayed and failed audit sends no audio',async t=>{
 const f=await fixture(t),path=`/api/admin/feedback/${f.id}/audio`;
 f.db.exec("CREATE TRIGGER fail_audio_audit BEFORE INSERT ON admin_audit WHEN NEW.action='feedback.audio' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
 const failure=await f.admin.get(path).expect(500);assert.match(failure.headers['content-type'],/application\/json/);assert.equal(failure.body.code,'INTERNAL_ERROR');assert.equal(failure.text.includes('RIFF'),false);
 f.db.exec('DROP TRIGGER fail_audio_audit');f.expire();await f.admin.get(path).expect(404);await f.admin.get(`/api/admin/feedback/${f.id}`).expect(404);assert.equal((await f.admin.get('/api/admin/feedback').expect(200)).body.total,0);
 f.db.prepare('DELETE FROM feedback_reports WHERE id=?').run(f.id);await f.admin.get(path).expect(404);
});
test('feedback status and operator audit share the actual SQLite transaction; source checks occur first',async t=>{
 const f=await fixture(t),path=`/api/admin/feedback/${f.id}/status`,payload={status:'resolved',revision:1,reason:'合成音频已核查',confirm:true};
 await f.admin.post(path).send(payload).expect(403);await f.admin.post(path).set('Origin','https://elsewhere.invalid').send(payload).expect(403);
 f.db.exec("CREATE TRIGGER fail_status_audit BEFORE INSERT ON admin_audit WHEN NEW.action='feedback.status' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
 await f.admin.post(path).set('Origin',origin).send(payload).expect(500);assert.equal(f.db.prepare('SELECT status FROM feedback_triage WHERE report_id=?').get(f.id)?.status,'open');assert.equal(f.db.prepare('SELECT count(*) n FROM feedback_triage_events WHERE report_id=?').get(f.id)?.n,0);assert.equal(f.db.isTransaction,false);
 f.db.exec('DROP TRIGGER fail_status_audit');await f.admin.post(path).set('Origin',origin).send(payload).expect(200);assert.equal(f.db.prepare("SELECT count(*) n FROM admin_audit WHERE action='feedback.status'").get()?.n,1);await f.admin.post(path).set('Origin',origin).send(payload).expect(409);
 assert.doesNotThrow(()=>f.app.locals.sweepExpiredState());assert.doesNotThrow(()=>f.app.locals.close());assert.doesNotThrow(()=>f.app.locals.close());assert.doesNotThrow(()=>f.app.locals.sweepExpiredState());
});
