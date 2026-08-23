import { createApp } from './api/app.js';
import { loadSettings } from './config/settings.js';
import { DirectModelRuntime } from './runtime/direct.js';

async function main(): Promise<void> {
  const settings = loadSettings();
  const runtime = new DirectModelRuntime(settings);
  const app = createApp(settings, runtime);

  await app.listen({ host: settings.host, port: settings.port });
}

main().catch((error: unknown) => {
  console.error('Agent service failed to start', error);
  process.exitCode = 1;
});
