import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

import { loadModelCatalog, type ModelConfig } from '../models/catalog.js';

const DEFAULT_SYSTEM_PROMPT = '你是 Eterion 的 AI 助手。请准确、清晰地回答用户问题。';

export interface Settings {
  host: string;
  port: number;
  defaultModelId: string;
  models: ModelConfig[];
  qianfanApiKey: string;
  systemPrompt: string;
  modelTimeoutMs: number;
  runTimeoutMs: number;
  heartbeatMs: number;
}

/** 从 agent/.env 加载配置，与命令从哪个目录启动无关。 */
export function loadSettings(environ?: NodeJS.ProcessEnv): Settings {
  if (!environ) {
    const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
    loadDotenv({ path: envPath, quiet: true });
    environ = process.env;
  }

  const models = loadModelCatalog(environ);
  if (models.length === 0) {
    throw new Error('at least one Agent model must be configured');
  }

  const defaultModelId = value(environ, 'DEFAULT_MODEL_ID', models[0]?.id);
  if (!models.some((model) => model.id === defaultModelId)) {
    throw new Error(`DEFAULT_MODEL_ID "${defaultModelId}" is not configured`);
  }

  return {
    host: value(environ, 'AGENT_HOST', '127.0.0.1'),
    port: parsePort(value(environ, 'AGENT_PORT', '8001')),
    defaultModelId,
    models,
    // 是否必须配置由 Agent Runtime 决定；Settings 只负责集中读取环境变量。
    qianfanApiKey: value(environ, 'QIANFAN_API_KEY'),
    systemPrompt: value(environ, 'SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT),
    modelTimeoutMs: parseDurationMs(
      value(environ, 'MODEL_TIMEOUT', '2m'),
      'MODEL_TIMEOUT',
    ),
    runTimeoutMs: parseDurationMs(
      value(environ, 'AGENT_RUN_TIMEOUT', '10m'),
      'AGENT_RUN_TIMEOUT',
    ),
    heartbeatMs: parseDurationMs(
      value(environ, 'AGENT_HEARTBEAT', '15s'),
      'AGENT_HEARTBEAT',
    ),
  };
}

function value(
  environ: NodeJS.ProcessEnv,
  key: string,
  fallback = '',
): string {
  return environ[key]?.trim() || fallback;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('AGENT_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseDurationMs(raw: string, key: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${key} must be a positive duration such as 15s, 2m, or 1h`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  const milliseconds = amount * multipliers[unit as keyof typeof multipliers];

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(`${key} must be positive`);
  }
  return milliseconds;
}
