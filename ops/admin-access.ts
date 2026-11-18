/** Trusted server CLI. The one-time link is written only to a new private file, never stdout. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, openSync, writeFileSync, closeSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, basename, join } from 'node:path';
import { createAdminStore } from '../apps/server/src/admin-store.js';
const dataPath=process.env.DATA_PATH,origin=process.env.ADMIN_PUBLIC_ORIGIN;
const args=process.argv.slice(2),output=args[0]==='--output'&&args.length===2?args[1]:undefined;
if(!dataPath||dataPath===':memory:'||!existsSync(dataPath))throw new Error('请以 DATA_PATH 指定已部署的数据库。');
if(!origin)throw new Error('请以 ADMIN_PUBLIC_ORIGIN 指定后台的 HTTPS 来源。');
const url=new URL(origin);
if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('后台来源须为纯 HTTPS 域名。');
if(!output||!isAbsolute(output)||!output.endsWith('.html'))throw new Error('请以 --output 指定新的绝对路径 HTML 私密交接文件。');
const parent=dirname(output),resolved=realpathSync(parent),stat=lstatSync(parent);
if(stat.isSymbolicLink()||!stat.isDirectory()||resolved!==parent)throw new Error('交接文件的目录不能含符号链接。');
const filePath=join(resolved,basename(output));
const fd=openSync(filePath,'wx',0o600);
let complete=false;
try{
  const db=new DatabaseSync(dataPath);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_operators'").get())throw new Error('请先部署支持运营管理的版本。');
    const store=createAdminStore({db});const result=store.createBootstrap();
    // origin is a parsed HTTPS authority; the only other interpolated value is a base64url token.
    const link=`${url.origin}/admin#setup=${result.token}`;
    writeFileSync(fd,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>宝妍运营后台初始化</title><body><h1>设置你的运营管理员账号</h1><p>此链接20分钟内有效，只能使用一次。请勿转发。打开后由你自己设置账号名与至少8位密码。</p><p><a href="${link}" rel="noreferrer">打开运营后台并设置账号</a></p><p>设置成功后请删除这份私密文件。账号不与内测调试或家庭账号混用。</p></body></html>`,'utf8');
    store.close();complete=true;process.stdout.write('已生成私密初始化交接文件。\n');
  }finally{db.close();}
}finally{closeSync(fd);if(!complete)unlinkSync(filePath);}
