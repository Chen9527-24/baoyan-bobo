import express, { type Express } from 'express';
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createApp } from './app.js';

type Env = Record<string, string | undefined>;
export function runtimeConfig(env: Env) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数。');
  if (production) {
    const host = env.PUBLIC_HOST ?? '';
    if (host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
        || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) {
      throw new Error('PUBLIC_HOST 必须是实际使用的公网域名，不含协议、端口或路径。');
    }
    if (env.ALLOWED_ORIGINS !== `https://${host}`) throw new Error('ALLOWED_ORIGINS 必须且只能为 https://PUBLIC_HOST 对应的同域来源。');
    if (!env.DATA_PATH || !isAbsolute(env.DATA_PATH)) throw new Error('生产环境必须提供指向持久卷的绝对 DATA_PATH。');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('HOST 只允许 127.0.0.1 或容器内的 0.0.0.0。');
  return { production, serveWeb: production || env.SERVE_WEB === 'true', port, host };
}

/** One process owns SQLite and all call state. No cluster/workers or Vite in production. */
export function createRuntime(options: { env?: Env; app?: Express; webRoot?: string; shutdownTimeoutMs?: number } = {}) {
  const env = options.env ?? process.env;
  const config = runtimeConfig(env);
  const webRoot = resolve(options.webRoot ?? 'apps/web/dist');
  const index = resolve(webRoot, 'index.html');
  if (config.serveWeb && (!existsSync(index) || !statSync(index).isFile())) {
    throw new Error('生产网页未构建：请先执行 npm run build。');
  }
  const application = options.app ?? createApp({ env });
  const app = express();
  app.disable('x-powered-by');
  let closing = false;
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' });
    if (closing) { res.set('Connection', 'close').status(503).json({ error: '服务正在重启，请稍后重试。', code: 'SERVICE_STOPPED' }); return; }
    next();
  });
  app.use(application);
  // Never turn an unknown API, secret path or development fixture into the SPA page.
  app.use('/api', (_req, res) => { res.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' }); });
  if (config.serveWeb) {
    app.get(['/', '/index.html', '/admin', '/admin/'], (_req, res) => { res.set('Cache-Control', 'no-store').sendFile(index); });
    app.use('/assets', express.static(resolve(webRoot, 'assets'), { dotfiles: 'deny', index: false, fallthrough: true,
      maxAge: '1y', immutable: true }));
  }
  app.use((_req, res) => { res.status(404).type('text').send('Not found'); });
  const server = createServer(app);
  server.headersTimeout = 15_000;
  server.requestTimeout = 75_000;
  server.keepAliveTimeout = 5_000;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = new Promise<void>((done, reject) => {
      let failure: unknown;
      // Close SSE and cancel suppliers BEFORE waiting for HTTP connections to drain.
      try { application.locals.close?.(); } catch (error) { failure = error; }
      const deadline = setTimeout(() => server.closeAllConnections(), Math.min(10_000, Math.max(1, options.shutdownTimeoutMs ?? 10_000)));
      deadline.unref();
      server.close(error => {
        clearTimeout(deadline);
        if (failure) reject(failure);
        else if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else done();
      });
    });
    return closePromise;
  };
  return { server, config, close };
}
