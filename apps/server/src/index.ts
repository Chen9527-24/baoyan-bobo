import 'dotenv/config';
import { createRuntime } from './runtime.js';

process.umask(0o077);
try {
  const runtime = createRuntime();
  runtime.server.once('error', () => {
    console.error('服务监听失败，请检查端口与运行配置。');
    void runtime.close().finally(() => { process.exitCode = 1; });
  });
  runtime.server.listen(runtime.config.port, runtime.config.host, () => console.log(`宝妍服务已启动（${runtime.config.production ? '生产构建' : '本机开发'}）。`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void runtime.close().catch(() => { console.error('服务关闭未完整完成。'); process.exitCode = 1; });
  });
} catch (error) {
  console.error('服务启动失败：', error instanceof Error ? error.message : '配置或存储不可用。');
  process.exitCode = 1;
}
