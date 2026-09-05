import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

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

export interface ModelConfig {
  id: string;
  modelName: string;
  provider: string;
  providerName: string;
  iconUrl: string;
  apiKey: string;
  baseUrl: string;
  providerModel: string;
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
