import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { resolveAliasMapping } from '@/modules/providers/list/claude/claude-settings-mapping.service.js';

/**
 * 别名 → 配置层模型的纯解析。/models 卡片的「配置」行和 chip 的回退显示都靠它,
 * 语义必须与 CLI 的解析链一致:别名走 ANTHROPIC_DEFAULT_<别名>_MODEL;default 走
 * settings "model"(可再经别名递归一层)→ ANTHROPIC_MODEL → 无。
 */
describe('resolveAliasMapping —— 配置层别名解析', () => {
  const settings = {
    model: 'sonnet',
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-sonnet-5',
    },
  };

  test('具体别名按各自的 env 覆盖解析', () => {
    assert.equal(resolveAliasMapping(settings, 'sonnet').configuredModel, 'kimi-k3');
    assert.equal(resolveAliasMapping(settings, 'opus').configuredModel, 'glm-5.2');
    assert.equal(resolveAliasMapping(settings, 'haiku').configuredModel, 'deepseek-v4-flash');
    assert.equal(resolveAliasMapping(settings, 'fable').configuredModel, 'claude-sonnet-5');
  });

  test('[1m] 变体与基础别名共用同一条覆盖', () => {
    assert.equal(resolveAliasMapping(settings, 'sonnet[1m]').configuredModel, 'kimi-k3');
    assert.equal(resolveAliasMapping(settings, 'opus[1m]').configuredModel, 'glm-5.2');
  });

  test('default 走 "model" 配置,别名再经它的 env 覆盖(用户实际链路)', () => {
    const mapping = resolveAliasMapping(settings, 'default');
    assert.equal(mapping.configuredModel, 'kimi-k3');
    assert.match(mapping.source ?? '', /"model": sonnet/);
  });

  test('default:"model" 是具体模型名时直接采用', () => {
    assert.equal(
      resolveAliasMapping({ model: 'glm-5.2', env: {} }, 'default').configuredModel,
      'glm-5.2',
    );
  });

  test('default:没配 "model" 时落到 ANTHROPIC_MODEL', () => {
    assert.equal(
      resolveAliasMapping({ env: { ANTHROPIC_MODEL: 'deepseek-v4-flash' } }, 'default').configuredModel,
      'deepseek-v4-flash',
    );
  });

  test('没有任何覆盖:configuredModel 为 null(CLI 内置 + 网关决定)', () => {
    assert.equal(resolveAliasMapping({}, 'sonnet').configuredModel, null);
    assert.equal(resolveAliasMapping({}, 'default').configuredModel, null);
    assert.equal(resolveAliasMapping({}, 'unknown-alias').configuredModel, null);
  });
});
