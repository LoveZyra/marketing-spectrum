import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  applyModelConfigUpdate,
  buildModelConfigView,
} from '../list/claude/claude-model-config.service.js';

const SETTINGS = {
  model: 'sonnet',
  env: {
    ANTHROPIC_BASE_URL: 'https://oneai.example.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-secret-never-leak',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
  },
  permissions: { defaultMode: 'bypassPermissions' },
};

describe('buildModelConfigView', () => {
  test('白名单字段;token 只报有无,值绝不出现', () => {
    const view = buildModelConfigView(structuredClone(SETTINGS), { exists: true, mtimeMs: 123 });
    assert.equal(view.defaultModel, 'sonnet');
    assert.equal(view.mappings.sonnet, 'kimi-k3');
    assert.equal(view.mappings.opus, 'glm-5.2');
    assert.equal(view.mappings.haiku, null);
    assert.equal(view.baseUrl, 'https://oneai.example.com/anthropic');
    assert.equal(view.hasAuthToken, true);
    assert.ok(!JSON.stringify(view).includes('sk-secret-never-leak'), 'token 值不得进入视图');
  });
});

describe('applyModelConfigUpdate', () => {
  test('设置/清除映射与 default;无关字段(含 token)逐位保留', () => {
    const next = applyModelConfigUpdate(structuredClone(SETTINGS), {
      defaultModel: 'haiku',
      mappings: { sonnet: 'deepseek-v4', opus: null, haiku: 'kimi-k3' },
    });
    const env = next.env as Record<string, unknown>;
    assert.equal(next.model, 'haiku');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4');
    assert.ok(!('ANTHROPIC_DEFAULT_OPUS_MODEL' in env), 'null 应删除该 env 键');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k3');
    // 红线:动映射绝不能弄丢 token / BASE_URL / 其他配置
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-secret-never-leak');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://oneai.example.com/anthropic');
    assert.deepEqual(next.permissions, { defaultMode: 'bypassPermissions' });
  });

  test('defaultModel: null 删除 "model" 键;undefined 不动;空串按删除', () => {
    assert.ok(!('model' in applyModelConfigUpdate(structuredClone(SETTINGS), { defaultModel: null })));
    assert.equal(applyModelConfigUpdate(structuredClone(SETTINGS), {}).model, 'sonnet');
    assert.ok(!('model' in applyModelConfigUpdate(structuredClone(SETTINGS), { defaultModel: '  ' })));
  });

  test('从空 settings 起步也能写(保存会创建文件的场景)', () => {
    const next = applyModelConfigUpdate({}, { mappings: { fable: 'claude-sonnet-5' } });
    assert.equal((next.env as Record<string, unknown>).ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-sonnet-5');
  });
});
