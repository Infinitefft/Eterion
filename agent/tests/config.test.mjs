import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings, toPublicModel } from '../dist/config.js';

const genericEnviron = { MODEL_NAME: 'test-model', MODEL_API_KEY: 'test-key' };

test('显式环境配置不读取本地 .env，默认值保持不变', () => {
  assert.throws(() => loadSettings({}), /at least one Agent model must be configured/);

  const settings = loadSettings(genericEnviron);
  assert.equal(settings.host, '127.0.0.1');
  assert.equal(settings.port, 8001);
  assert.equal(settings.defaultModelId, 'default');
  assert.equal(settings.qianfanApiKey, '');
  assert.equal(settings.modelTimeoutMs, 120_000);
  assert.equal(settings.runTimeoutMs, 600_000);
  assert.equal(settings.heartbeatMs, 15_000);
});

test('内置模型优先于通用模型，并保持目录顺序及默认模型选择', () => {
  const settings = loadSettings({
    // 内置模型启用后，不应验证这份不完整的通用模型配置。
    MODEL_NAME: 'unused-model',
    DOUBAO_SEED_2_1_PRO_MODEL: 'test-doubao',
    DOUBAO_API_KEY: 'test-key',
    DEEPSEEK_V4_PRO_MODEL: 'test-deepseek',
    DEEPSEEK_API_KEY: 'test-key',
    DEFAULT_MODEL_ID: 'deepseek-v4-pro',
  });

  assert.deepEqual(settings.models.map((model) => model.id), [
    'doubao-seed-2-1-pro',
    'deepseek-v4-pro',
  ]);
  assert.equal(settings.defaultModelId, 'deepseek-v4-pro');
  assert.equal(settings.models[0].baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
});

test('环境变量会去除空白，空字符串仍使用默认值', () => {
  const settings = loadSettings({
    MODEL_NAME: ' test-model ',
    MODEL_API_KEY: ' test-key ',
    AGENT_HOST: '   ',
    AGENT_PORT: ' 9000 ',
    DEFAULT_MODEL_ID: '  ',
    QIANFAN_API_KEY: ' search-test-key ',
  });

  assert.equal(settings.models[0].providerModel, 'test-model');
  assert.equal(settings.models[0].apiKey, 'test-key');
  assert.equal(settings.host, '127.0.0.1');
  assert.equal(settings.port, 9000);
  assert.equal(settings.defaultModelId, 'default');
  assert.equal(settings.qianfanApiKey, 'search-test-key');
});

test('缺失 Key、未配置的默认模型和非法端口保持原有错误', () => {
  assert.throws(() => loadSettings({ MODEL_NAME: 'test-model' }),
    /MODEL_NAME and MODEL_API_KEY must be configured together/);
  assert.throws(() => loadSettings({ DEEPSEEK_V4_PRO_MODEL: 'test-deepseek' }),
    /deepseek-v4-pro API key is required/);
  assert.throws(() => loadSettings({ ...genericEnviron, DEFAULT_MODEL_ID: 'missing' }),
    /DEFAULT_MODEL_ID "missing" is not configured/);

  for (const port of ['0', '65536', '1.5', 'invalid']) {
    assert.throws(() => loadSettings({ ...genericEnviron, AGENT_PORT: port }),
      /AGENT_PORT must be an integer between 1 and 65535/);
  }
});

test('持续时间保留 ms、s、m、h 单位及小数语义', () => {
  for (const [duration, milliseconds] of [
    ['0.5ms', 0.5], ['1.5s', 1500], ['2.5m', 150_000], ['0.5h', 1_800_000],
  ]) {
    const settings = loadSettings({ ...genericEnviron, MODEL_TIMEOUT: duration });
    assert.equal(settings.modelTimeoutMs, milliseconds);
  }

  assert.throws(() => loadSettings({ ...genericEnviron, MODEL_TIMEOUT: '0s' }),
    /MODEL_TIMEOUT must be positive/);
  assert.throws(() => loadSettings({ ...genericEnviron, MODEL_TIMEOUT: '100' }),
    /MODEL_TIMEOUT must be a positive duration/);
});

test('公开模型信息只包含前端字段，不泄漏内部配置', () => {
  const settings = loadSettings({ ...genericEnviron, MODEL_BASE_URL: 'https://example.com/private' });
  const publicModel = toPublicModel(settings.models[0]);

  assert.deepEqual(publicModel, {
    id: 'default',
    modelName: 'test-model',
    provider: 'openai-compatible',
    providerName: 'OpenAI 兼容',
    icon_url: '',
  });
});
