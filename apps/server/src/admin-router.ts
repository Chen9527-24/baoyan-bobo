import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './provider-errors.js';
import type { AdminStore, AdminActor } from './admin-store.js';
export const ADMIN_COOKIE = 'baoyan_admin';
const text = z.string().max(128);
const credentials = z.object({ username:z.string().max(32),password:text }).strict();
const confirmation = z.object({revision:z.number().int().min(0),reason:z.string().min(2).max(200),confirm:z.literal(true)});
function parse<T>(schema:z.ZodType<T>,value:unknown){const result=schema.safeParse(value);if(!result.success)throw new ApiError(400,'输入不符合要求，请检查后重试','INVALID_INPUT');return result.data;}
export function createAdminRouter({store,allowedOrigins,secureCookie=false,overview}: {store:AdminStore;allowedOrigins:Set<string>|string[];secureCookie?:boolean;overview?: (actor:AdminActor)=>Record<string,unknown>}) {
  const router=Router(),origins=new Set(allowedOrigins),cookie={httpOnly:true,sameSite:'strict' as const,secure:secureCookie,path:'/api/admin'};
  const authorize=(req:Request)=>store.authorize(req.cookies?.[ADMIN_COOKIE]);
  const setCookie=(res:import('express').Response,result:{token:string;expiresAt:string})=>res.cookie(ADMIN_COOKIE,result.token,{...cookie,expires:new Date(result.expiresAt)});
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!origins.has(req.get('Origin')??''))throw new ApiError(403,'请求来源未获允许','ORIGIN_REJECTED');next();});
  router.get('/session',(req,res)=>res.json(store.status(req.cookies?.[ADMIN_COOKIE])));
  router.post('/bootstrap',async(req,res)=>{const input=parse(credentials.extend({token:z.string().length(43)}).strict(),req.body);const result=await store.bootstrap({...input,ip:req.ip??'unknown'});setCookie(res,result);res.json(store.status(result.token));});
  router.post('/login',async(req,res)=>{const input=parse(credentials,req.body);const result=await store.login({...input,ip:req.ip??'unknown'});setCookie(res,result);res.json(store.status(result.token));});
  router.post('/logout',(req,res)=>{const actor=authorize(req);parse(z.object({}).strict(),req.body??{});store.logout(actor);res.clearCookie(ADMIN_COOKIE,cookie);res.json({ok:true});});
  router.post('/password',async(req,res)=>{const actor=authorize(req),input=parse(z.object({password:text,newPassword:text}).strict(),req.body);await store.changePassword(actor,{...input,ip:req.ip??'unknown'});res.clearCookie(ADMIN_COOKIE,cookie);res.json({ok:true});});
  router.post('/recover',async(req,res)=>{const input=parse(z.object({token:z.string().length(43),newPassword:text}).strict(),req.body);res.json(await store.recover({...input,ip:req.ip??'unknown'}));});
  router.get('/overview',(req,res)=>{const actor=authorize(req);res.json({...store.overview(actor),...overview?.(actor)});});
  router.get('/accounts',(req,res)=>res.json(store.accounts(authorize(req),req.query)));
  router.get('/families',(req,res)=>res.json(store.families(authorize(req),req.query)));
  router.get('/audit',(req,res)=>res.json(store.listAudit(authorize(req),req.query)));
  router.post('/accounts/:id/status',(req,res)=>{const actor=authorize(req),input=parse(confirmation.extend({status:z.enum(['active','disabled'])}).strict(),req.body);res.json(store.setAccountStatus(actor,parse(z.string().uuid(),req.params.id),input));});
  router.post('/families/:id/status',(req,res)=>{const actor=authorize(req),input=parse(confirmation.extend({status:z.enum(['active','paused'])}).strict(),req.body);res.json(store.setFamilyStatus(actor,parse(z.string().uuid(),req.params.id),input));});
  router.post('/accounts/:id/recovery',(req,res)=>{const actor=authorize(req),input=parse(confirmation.strict(),req.body);res.json(store.issueRecovery(actor,parse(z.string().uuid(),req.params.id),input));});
  return {router,authorize};
}
