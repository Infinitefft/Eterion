import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { RagConfig } from './rag/types.js';

const DEFAULT_SYSTEM_PROMPT = '你是 Eterion 的 AI 助手。请准确、清晰地回答用户问题。';

export const MODEL_MAX_OUTPUT_TOKENS = 16384;

export interface Settings {
  host: string;
  port: number;
  defaultModelId: string;
  models: ModelConfig[];
  bochaApiKey: string;
  systemPrompt: string;
  modelTimeoutMs: number;
  runTimeoutMs: number;
  heartbeatMs: number;
  recordingEnabled: boolean;
  recordingPath: string;
  apiBaseUrl: string;
  rag?: RagConfig;
}

export interface ModelConfig {
  id: string;
  modelName: string;
  provider: string;
  providerName: string;
  iconUrl: string;
  apiKey: string;
  baseUrl: string;
  providerModel: string;
  // 项目的保守上下文预算，不代表厂商声明的最大窗口。
  contextWindow: number;
  // 总输入阈值，包含主提示词和工具定义，不包含尚未生成的输出。
  autoCompactTokenLimit: number;
}

const MODEL_DEFINITIONS = [
  {
    id: 'doubao-seed-2-1-pro',
    provider: 'doubao',
    providerName: '豆包',
    modelPrefix: 'DOUBAO_SEED_2_1_PRO',
    providerPrefix: 'DOUBAO',
    modelName: 'Doubao-Seed-2.1-pro',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    iconUrl: '/model-icons/doubao-seed-2-1-pro.png',
  },
  {
    id: 'deepseek-flash',
    provider: 'deepseek',
    providerName: 'DeepSeek',
    modelPrefix: 'DEEPSEEK_FLASH',
    providerPrefix: 'DEEPSEEK',
    modelName: 'DeepSeek-Flash',
    baseUrl: 'https://api.deepseek.com',
    iconUrl: '/model-icons/deepseek-v4-pro.png',
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    providerName: 'DeepSeek',
    modelPrefix: 'DEEPSEEK_V4_PRO',
    providerPrefix: 'DEEPSEEK',
    modelName: 'DeepSeek-V4-Pro',
    baseUrl: 'https://api.deepseek.com',
    iconUrl: '/model-icons/deepseek-v4-pro.png',
  },
  {
    id: 'minimax-m2-7',
    provider: 'minimax',
    providerName: 'MiniMax',
    modelPrefix: 'MINIMAX_M2_7',
    providerPrefix: 'MINIMAX',
    modelName: 'MiniMax M2.7',
    baseUrl: 'https://api.minimaxi.com/v1',
    iconUrl: '/model-icons/minimax-m2-7.png',
  },
];

/** 从 agent/.env 加载配置，与命令从哪个目录启动无关。 */
export function loadSettings(environ?: NodeJS.ProcessEnv): Settings {
  if (!environ) {
    // import.meta.url 在 src/ 和 dist/ 下都只需向上一层定位 agent/.env。
    const envPath = fileURLToPath(new URL('../.env', import.meta.url));
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

  // 相对路径始终基于 agent/；源码和编译后的服务使用同一份外部提示词。
  const promptFile = value(environ, 'SYSTEM_PROMPT_FILE');
  let systemPrompt = value(environ, 'SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT);
  if (promptFile) {
    try {
      systemPrompt = readFileSync(resolve(
        fileURLToPath(new URL('../', import.meta.url)), promptFile,
      ), 'utf8').trim();
    } catch {
      throw new Error('SYSTEM_PROMPT_FILE could not be read');
    }
    if (!systemPrompt) throw new Error('SYSTEM_PROMPT_FILE must not be empty');
  }

  return {
    // 这里只读取配置，创建入库组件时才校验和连接，避免影响普通聊天。
    rag: {
      rerank: {
        apiKey: value(environ, 'RERANK_API_KEY'),
        url: value(environ, 'RERANK_URL'),
        threshold: Number(value(environ, 'RERANK_SCORE_THRESHOLD', '0.5')),
      },
      apiKey: value(environ, 'EMBEDDING_API_KEY'),
      baseUrl: value(environ, 'EMBEDDING_BASE_URL'),
      model: value(environ, 'EMBEDDING_MODEL', 'text-embedding-v4'),
      dimensions: Number(value(environ, 'EMBEDDING_DIMENSIONS', '1024')),
      databaseUrl: value(environ, 'DATABASE_URL'),
    },
    host: value(environ, 'AGENT_HOST', '127.0.0.1'),
    apiBaseUrl: value(environ, 'GO_API_BASE_URL', 'http://127.0.0.1:8080'),
    port: parsePort(value(environ, 'AGENT_PORT', '8001')),
    defaultModelId,
    models,
    // 是否必须配置由 Agent Runtime 决定；Settings 只负责集中读取环境变量。
    bochaApiKey: value(environ, 'BOCHA_API_KEY'),
    systemPrompt,
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
    recordingEnabled: parseRecordingEnabled(value(environ, 'AGENT_RECORDING_ENABLED', 'false')),
    // 相对路径基于 agent/，保证 src、dist 以及不同启动目录使用同一位置。
    recordingPath: resolve(
      fileURLToPath(new URL('../', import.meta.url)),
      value(environ, 'AGENT_RECORDING_DIR', '../.run-records'),
      'records.sqlite',
    ),
  };
}

export function toPublicModel(model: ModelConfig) {
  // 用白名单构造响应，不能把 API Key、Base URL 等内部配置直接发给前端。
  return {
    id: model.id,
    modelName: model.modelName,
    provider: model.provider,
    providerName: model.providerName,
    icon_url: model.iconUrl,
  };
}

function loadModelCatalog(environ: NodeJS.ProcessEnv): ModelConfig[] {
  const models: ModelConfig[] = [];

  for (const definition of MODEL_DEFINITIONS) {
    const providerModel = value(environ, `${definition.modelPrefix}_MODEL`);
    if (!providerModel) continue;

    const apiKey = value(environ, `${definition.providerPrefix}_API_KEY`);
    if (!apiKey) {
      throw new Error(`${definition.id} API key is required`);
    }

    models.push({
      id: definition.id,
      modelName: value(
        environ,
        `${definition.modelPrefix}_NAME`,
        definition.modelName,
      ),
      provider: definition.provider,
      providerName: definition.providerName,
      iconUrl: value(
        environ,
        `${definition.providerPrefix}_ICON_URL`,
        definition.iconUrl,
      ),
      apiKey,
      baseUrl: value(
        environ,
        `${definition.providerPrefix}_BASE_URL`,
        definition.baseUrl,
      ),
      providerModel,
      ...readContextBudget(environ, definition.modelPrefix),
    });
  }

  // 只在没有启用内置模型时读取通用配置，避免改变现有模型列表的优先级。
  if (models.length > 0) return models;

  const providerModel = value(environ, 'MODEL_NAME');
  const apiKey = value(environ, 'MODEL_API_KEY');

  if (!providerModel && !apiKey) return [];
  if (!providerModel || !apiKey) {
    throw new Error('MODEL_NAME and MODEL_API_KEY must be configured together');
  }

  return [
    {
      id: 'default',
      modelName: providerModel,
      provider: 'openai-compatible',
      providerName: 'OpenAI 兼容',
      iconUrl: '',
      apiKey,
      baseUrl: value(environ, 'MODEL_BASE_URL'),
      providerModel,
      ...readContextBudget(environ),
    },
  ];
}

function value(environ: NodeJS.ProcessEnv, key: string, fallback = ''): string {
  return environ[key]?.trim() || fallback;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('AGENT_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseContextWindow(raw: string): number {
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 16384) {
    throw new Error('MODEL_CONTEXT_WINDOW must be an integer of at least 16384');
  }
  return size;
}

function readContextBudget(environ: NodeJS.ProcessEnv, prefix = 'MODEL') {
  const contextWindow = parseContextWindow(value(environ, `${prefix}_CONTEXT_WINDOW`,
    value(environ, 'MODEL_CONTEXT_WINDOW', '32768')));
  const defaultCompactLimit = Math.min(20000, contextWindow - MODEL_MAX_OUTPUT_TOKENS - 4096);
  const autoCompactTokenLimit = Number(value(environ, `${prefix}_AUTO_COMPACT_TOKEN_LIMIT`,
    value(environ, 'MODEL_AUTO_COMPACT_TOKEN_LIMIT', String(defaultCompactLimit))));
  // 至少留出主模型输出和基础安全余量；工具结果的增长缓冲由各模型阈值决定。
  if (!Number.isSafeInteger(autoCompactTokenLimit) || autoCompactTokenLimit < 4096
    || autoCompactTokenLimit > contextWindow - MODEL_MAX_OUTPUT_TOKENS - 4096) {
    throw new Error(`${prefix}_AUTO_COMPACT_TOKEN_LIMIT must be an integer between 4096 and CONTEXT_WINDOW - ${MODEL_MAX_OUTPUT_TOKENS + 4096}`);
  }
  return { contextWindow, autoCompactTokenLimit };
}

function parseRecordingEnabled(raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('AGENT_RECORDING_ENABLED must be true or false');
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
