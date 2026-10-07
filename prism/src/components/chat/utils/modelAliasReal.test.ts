import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveAliasReal } from './modelAliasReal';

/**
 * 「别名 → 实际模型」只有一份判据:新鲜实测 > 配置映射。
 *
 * 网关把配置的 X 改写成 Y(实测新鲜、未过期)时,聊天芯片、模型菜单、`/models` 头部、
 * 定时任务下拉都显示 Y。哪一处另写一份"配置优先",两处就会对不上。
 */
describe('resolveAliasReal', () => {
  const configured = { sonnet: { configuredModel: 'model-x' }, default: { configuredModel: 'model-d' } };

  it('实测新鲜且与配置不一致(网关改写):以实测为准', () => {
    expect(resolveAliasReal('sonnet', { probed: { sonnet: { actualModel: 'model-y' } }, configured, stale: false })).toBe('model-y');
  });

  it('实测过期:用配置映射(settings 刚改过,配置才是新值)', () => {
    expect(resolveAliasReal('sonnet', { probed: { sonnet: { actualModel: 'model-y' } }, configured, stale: true })).toBe('model-x');
  });

  it('没实测过、或实测失败(actualModel 为 null):用配置映射', () => {
    expect(resolveAliasReal('sonnet', { probed: {}, configured, stale: false })).toBe('model-x');
    expect(resolveAliasReal('sonnet', { probed: { sonnet: { actualModel: null } }, configured, stale: false })).toBe('model-x');
  });

  it('两边都不知道就是 null(调用方退回显示别名)', () => {
    expect(resolveAliasReal('haiku', { probed: {}, configured, stale: false })).toBeNull();
  });
});

describe('各处都用这一份判据(接线)', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const chatInterface = read('../view/ChatInterface.tsx');
  const picker = read('../view/subcomponents/ModelPickerContent.tsx');
  const taskOptions = read('../../../hooks/useTaskLikeOptions.ts');

  it('聊天芯片与模型菜单别名行', () => {
    expect(chatInterface.match(/resolveAliasReal\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(chatInterface).not.toMatch(/\?\.actualModel/);
  });

  it('定时任务 / SkillWhet 的模型下拉(realOf)', () => {
    expect(taskOptions).toMatch(/const realOf = \(alias: string\): string \| null =>\s*resolveAliasReal\(alias, \{ probed, configured, stale \}\);/);
    // proposer / evaluator 冲突判定仍只看配置映射
    expect(taskOptions).toMatch(/configured\[value\]\?\.configuredModel/);
  });

  it('`/models` 弹窗头部的「→」', () => {
    expect(picker).toMatch(/const currentAliasReal = currentIsAlias \? resolveAliasReal\(currentValue, aliasSources\) : null;/);
  });
});
