import { createApp } from './server.js';
import { loadSettings } from './config.js';
import { createAgentRuntime } from './runtime/agent.js';

/** 组装 Agent Runtime 与 HTTP 服务；Direct 实现仍保留为可手动切换的基线。 */
async function main(): Promise<void> {
  const settings = loadSettings();
  const runtime = createAgentRuntime(settings);
  const app = createApp(settings, runtime);

  await app.listen({ host: settings.host, port: settings.port });
}

main().catch((error: unknown) => {
  console.error('Agent service failed to start', error);
  process.exitCode = 1;
});
