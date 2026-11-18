import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import { createAdminStore } from '../apps/server/src/admin-store.js';
import { createAdminRouter } from '../apps/server/src/admin-router.js';
import { ApiError } from '../apps/server/src/provider-errors.js';
const origin='https://bobo.example';
function fixture(){const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE families(id TEXT PRIMARY KEY);CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,family_id TEXT,created_at INTEGER,password_revision INTEGER);CREATE TABLE devices(token_hash TEXT PRIMARY KEY,family_id TEXT);CREATE TABLE members(id TEXT,family_id TEXT);CREATE TABLE calls(id TEXT,ended_at INTEGER);CREATE TABLE guardian_members(account_id TEXT);CREATE TABLE account_sessions(device_hash TEXT,account_id TEXT);`);const store=createAdminStore({db}),app=express();app.use(cookieParser());app.use(express.json());app.use('/api/admin',createAdminRouter({store,allowedOrigins:[origin],secureCookie:true}).router);app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(err instanceof ApiError)res.status(err.status).json({error:err.message,code:err.code});else res.status(500).json({error:'failure'});});return{app,db,store,close:()=>{store.close();db.close();}};}
test('admin HTTP is isolated from family/debug cookies, and every mutation requires Origin',async()=>{const f=fixture();try{
 for(const path of ['/overview','/accounts','/families','/audit']){const response=await request(f.app).get('/api/admin'+path).set('Cookie','baoyan_debug=fiction; baoyan_parent=fiction; baoyan_account=fiction');assert.equal(response.status,401,path);}
 for(const path of ['/bootstrap','/login','/logout','/password','/recover','/accounts/invalid/status','/families/invalid/status','/accounts/invalid/recovery']){const response=await request(f.app).post('/api/admin'+path).send({});assert.equal(response.status,403,path);}
 for(const path of ['/logout','/password','/accounts/invalid/status','/families/invalid/status','/accounts/invalid/recovery']){const response=await request(f.app).post('/api/admin'+path).set('Origin',origin).send({});assert.equal(response.status,401,path);}
 const session=await request(f.app).get('/api/admin/session');assert.deepEqual(session.body,{initialized:false,authenticated:false});assert.equal(session.headers['cache-control'],'no-store');
}finally{f.close();}});
test('admin HTTP bootstrap sets a scoped secure cookie, no response token leak, logout clears it',async()=>{const f=fixture();try{
 const ticket=f.store.createBootstrap();const response=await request(f.app).post('/api/admin/bootstrap').set('Origin',origin).send({token:ticket.token,username:'owner',password:'12345678'});assert.equal(response.status,200);assert.equal(response.body.authenticated,true);assert.equal('token'in response.body,false);const setCookie=String(response.headers['set-cookie']?.[0]);assert.match(setCookie,/Path=\/api\/admin/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Strict/);const cookie=setCookie.split(';')[0]!;
 const overview=await request(f.app).get('/api/admin/overview').set('Cookie',cookie);assert.equal(overview.status,200);assert.equal(overview.body.accounts.total,0);
 const logout=await request(f.app).post('/api/admin/logout').set('Origin',origin).set('Cookie',cookie).send({});assert.equal(logout.status,200);assert.equal((await request(f.app).get('/api/admin/overview').set('Cookie',cookie)).status,401);
}finally{f.close();}});
