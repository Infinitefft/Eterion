import { createApp } from './server.js';
import { loadSettings } from './config.js';
import { createAgentRuntime } from './runtime/agent-runtime.js';

/** 组装 Agent Runtime 与 HTTP 服务；Direct 实现仍保留为可手动切换的基线。 */
async function main(): Promise<void> {
  const settings = loadSettings();
  const runtime = createAgentRuntime(settings);
  const app = createApp(settings, runtime);

  await app.listen({ host: settings.host, port: settings.port });
  // 通过 Fastify 的 onClose 释放 RAG 连接池，避免强制退出跳过清理。
  const shutdown = () => {
    void app.close().catch(() => {
      console.error('Agent service shutdown failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('Agent service failed to start', error);
  process.exitCode = 1;
});
