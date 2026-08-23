import { DEFAULT_MODEL_CAPABILITIES, type ModelCapabilities } from './capabilities.js';

interface ModelDefinition {
  id: string;
  provider: string;
  providerName: string;
  modelPrefix: string;
  providerPrefix: string;
  modelName: string;
  baseUrl: string;
  iconUrl: string;
  capabilities: Readonly<ModelCapabilities>;
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
  capabilities: Readonly<ModelCapabilities>;
}

const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    id: 'doubao-seed-2-1-pro',
    provider: 'doubao',
    providerName: '豆包',
    modelPrefix: 'DOUBAO_SEED_2_1_PRO',
    providerPrefix: 'DOUBAO',
    modelName: 'Doubao-Seed-2.1-pro',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    iconUrl: '/model-icons/doubao-seed-2-1-pro.png',
    capabilities: DEFAULT_MODEL_CAPABILITIES,
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
    capabilities: DEFAULT_MODEL_CAPABILITIES,
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
    capabilities: DEFAULT_MODEL_CAPABILITIES,
  },
];

export function loadModelCatalog(environ: NodeJS.ProcessEnv): ModelConfig[] {
  const knownModels = loadKnownModels(environ);
  return knownModels.length > 0 ? knownModels : loadGenericModel(environ);
}

export function toPublicModel(model: ModelConfig) {
  // capabilities 暂不对前端公开，避免 UI 依赖未经验证的模型能力。
  return {
    id: model.id,
    modelName: model.modelName,
    provider: model.provider,
    providerName: model.providerName,
    icon_url: model.iconUrl,
  };
}

function loadKnownModels(environ: NodeJS.ProcessEnv): ModelConfig[] {
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
      capabilities: definition.capabilities,
    });
  }

  return models;
}

function loadGenericModel(environ: NodeJS.ProcessEnv): ModelConfig[] {
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
      capabilities: DEFAULT_MODEL_CAPABILITIES,
    },
  ];
}

function value(environ: NodeJS.ProcessEnv, key: string, fallback = ''): string {
  return environ[key]?.trim() || fallback;
}
