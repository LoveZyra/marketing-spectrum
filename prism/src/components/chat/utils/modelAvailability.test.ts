import { describe, expect, it } from 'vitest';

import type { ProviderModelOption, ProviderModelsDefinition } from '../../../types/app';

import { availableFirst, canFixWithKey, fallbackModel, isModelAvailable, pickStoredModel } from './modelAvailability';

const catalog = (value: string, extra: Partial<ProviderModelOption> = {}): ProviderModelOption => ({ value, label: value, group: 'catalog', ...extra });
const noKey = { available: false, unavailableReason: '网关「OpenRouter」需要你自己的 key —— 在 设置 → 模型网关 里填' };
const disabledGateway = { available: false, unavailableReason: '网关「OpenRouter」已停用' };

describe('hq 模型能不能用', () => {
  it('缺省 = 能用;只有 available: false 才算不能用', () => {
    expect(isModelAvailable(catalog('a'))).toBe(true);
    expect(isModelAvailable(catalog('a', { available: true }))).toBe(true);
    expect(isModelAvailable(catalog('a', noKey))).toBe(false);
    expect(isModelAvailable(null)).toBe(true);
  });

  it('「去填 key」只给填了 key 就能用的;网关停用 / 不见了不给', () => {
    expect(canFixWithKey(catalog('a', noKey))).toBe(true);
    // 有原因码时按码判 —— 网关停用即使原因里写了 key 也不给入口
    expect(canFixWithKey(catalog('a', { available: false, unavailableCode: 'no_key', unavailableReason: '…' }))).toBe(true);
    expect(canFixWithKey(catalog('a', { available: false, unavailableCode: 'gateway_disabled', unavailableReason: 'key 相关' }))).toBe(false);
    expect(canFixWithKey(catalog('a', { available: false, unavailableCode: 'gateway_missing' }))).toBe(false);
    expect(canFixWithKey(catalog('a', { available: false, unavailableReason: '私有网关「我的」还没有 key' }))).toBe(true);
    expect(canFixWithKey(catalog('a', { available: false }))).toBe(true);
    expect(canFixWithKey(catalog('a', disabledGateway))).toBe(false);
    expect(canFixWithKey(catalog('a', { available: false, unavailableReason: '挂的网关已经不存在了' }))).toBe(false);
    expect(canFixWithKey(catalog('a'))).toBe(false);
  });

  it('能用的排前面,两段各自保持原顺序', () => {
    const list = [catalog('p1', { private: true, ...noKey }), catalog('p2', { private: true }), catalog('a', noKey), catalog('b')];
    expect(availableFirst(list).map((option) => option.value)).toEqual(['p2', 'b', 'p1', 'a']);
  });
});

describe('hq 自动挑模型时不挑不可用的', () => {
  const definition = (OPTIONS: ProviderModelOption[], DEFAULT: string): ProviderModelsDefinition => ({ OPTIONS, DEFAULT });

  it('DEFAULT 能用(或不在列表里,比如别名 default)→ 原样用', () => {
    expect(fallbackModel(definition([catalog('glm'), catalog('ds')], 'ds'))).toBe('ds');
    expect(fallbackModel(definition([catalog('glm')], 'default'))).toBe('default');
  });

  it('DEFAULT 不能用 → 能用的推荐 → 能用的目录模型 → 能用的任何一个', () => {
    const options = [catalog('or-model', noKey), catalog('glm'), catalog('kimi', { recommended: true }), { value: 'sonnet', label: 'Sonnet', group: 'alias' as const }];
    expect(fallbackModel(definition(options, 'or-model'))).toBe('kimi');
    expect(fallbackModel(definition(options.filter((option) => option.value !== 'kimi'), 'or-model'))).toBe('glm');
    expect(fallbackModel(definition([catalog('or-model', noKey), { value: 'sonnet', label: 'Sonnet', group: 'alias' as const }], 'or-model'))).toBe('sonnet');
  });

  it('一个能用的都没有 → 原样给 DEFAULT(发送时服务端说清楚)', () => {
    expect(fallbackModel(definition([catalog('x', noKey), catalog('y', disabledGateway)], 'x'))).toBe('x');
  });

  it('存着的还在列表里 → 不换,哪怕它此刻不可用(不悄悄换模型)', () => {
    const def = definition([catalog('glm'), catalog('or-model', noKey)], 'glm');
    expect(pickStoredModel('or-model', 'or-model', def)).toBe('or-model');
    expect(pickStoredModel('glm', 'or-model', def)).toBe('glm');
  });

  it('第一次打开(没存过)→ 服务端默认;默认不能用就挑能用的', () => {
    expect(pickStoredModel(null, 'default', definition([catalog('glm'), catalog('ds')], 'ds'))).toBe('ds');
    expect(pickStoredModel(null, 'default', definition([catalog('or-model', noKey), catalog('ds')], 'or-model'))).toBe('ds');
  });

  it('存着的从列表里没了 → 当前值还在就留着,否则退回默认(不挑不可用的)', () => {
    const def = definition([catalog('glm'), catalog('or-model', noKey), catalog('ds')], 'or-model');
    expect(pickStoredModel('retired', 'glm', def)).toBe('glm');
    expect(pickStoredModel('retired', 'retired', def)).toBe('glm');
  });
});
