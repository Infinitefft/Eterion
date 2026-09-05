import { createApp } from './server.js';
import { loadSettings } from './config.js';
import { createDirectRuntime } from './runtime/direct.js';

async function main(): Promise<void> {
  const settings = loadSettings();
  const runtime = createDirectRuntime(settings);
  const app = createApp(settings, runtime);

  await app.listen({ host: settings.host, port: settings.port });
}

main().catch((error: unknown) => {
  console.error('Agent service failed to start', error);
  process.exitCode = 1;
});
