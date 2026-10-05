import { describe, expect, it } from 'vitest';

import { effectiveEffort, effortToStore, nextEnabledIndex, splitModelMenu } from './modelEffortMenu';

const glm = { value: 'glm-5.2', label: 'GLM 5.2', group: 'catalog' as const, recommended: true, effort: { default: 'high', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }] } };
const ds = { value: 'deepseek-v4', label: 'DeepSeek V4', group: 'catalog' as const };
const kimi = { value: 'kimi-k2.5', label: 'Kimi K2.5', group: 'catalog' as const, recommended: true };
const sonnet = { value: 'sonnet', label: 'Sonnet', group: 'alias' as const };

describe('ho 模型 + 档位菜单', () => {
  it('实际档位:支持就用选的,default / 不支持就用模型默认,没有档位就 null', () => {
    expect(effectiveEffort(glm, 'low')).toBe('low');
    expect(effectiveEffort(glm, 'default')).toBe('high');
    expect(effectiveEffort(glm, 'xhigh')).toBe('high');
    expect(effectiveEffort(ds, 'high')).toBeNull();
    expect(effectiveEffort({ ...glm, effort: { values: [{ value: 'low' }] } }, 'default')).toBeNull();
  });

  it('选到模型默认档就存 default', () => {
    expect(effortToStore(glm, 'high')).toBe('default');
    expect(effortToStore(glm, 'max')).toBe('max');
    expect(effortToStore(ds, 'low')).toBe('low');
  });

  it('上面一节 = 当前 + 推荐;其余进更多模型;目录里有模型时别名不当选项', () => {
    const split = splitModelMenu([glm, ds, kimi, sonnet], 'deepseek-v4');
    expect(split.primary.map((option) => option.value)).toEqual(['deepseek-v4', 'glm-5.2', 'kimi-k2.5']);
    expect(split.more.map((option) => option.value)).toEqual([]);
    expect(split.aliases).toEqual([]);
  });

  it('目录里的非推荐模型进更多模型,别名哪一节都不出现', () => {
    const split = splitModelMenu([glm, ds, { ...kimi, recommended: false }, sonnet, { value: 'haiku', label: 'Haiku', group: 'alias' as const }], 'glm-5.2');
    expect(split.primary.map((option) => option.value)).toEqual(['glm-5.2']);
    expect(split.more.map((option) => option.value)).toEqual(['deepseek-v4', 'kimi-k2.5']);
    expect(split.aliases).toEqual([]);
  });

  it('目录为空(只有别名分组):别名照旧是可选项', () => {
    const split = splitModelMenu([sonnet, { value: 'opus', label: 'Opus', group: 'alias' as const }], 'sonnet');
    expect(split.primary.map((option) => option.value)).toEqual(['sonnet']);
    expect(split.aliases.map((option) => option.value)).toEqual(['opus']);
  });

  it('当前是别名、目录里没有推荐:上面一节给别名 + 第一个目录模型', () => {
    const split = splitModelMenu([ds, { ...kimi, recommended: false }, sonnet], 'sonnet');
    expect(split.primary.map((option) => option.value)).toEqual(['sonnet', 'deepseek-v4']);
    expect(split.more.map((option) => option.value)).toEqual(['kimi-k2.5']);
    expect(split.aliases).toEqual([]);
  });

  it('老服务端没有分组:全当别名', () => {
    const split = splitModelMenu([{ value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' }], 'opus');
    expect(split.primary.map((option) => option.value)).toEqual(['opus']);
    expect(split.aliases.map((option) => option.value)).toEqual(['haiku']);
  });
});

describe('hq 私有模型 / 不能用的模型', () => {
  const noKey = { available: false, unavailableReason: '网关「OpenRouter」需要你自己的 key' };
  const mine = { value: 'my-model', label: 'My Model', group: 'catalog' as const, private: true, gatewayId: 7, gatewayName: '我的网关' };
  const orRec = { value: 'or-claude', label: 'OR Claude', group: 'catalog' as const, recommended: true, gatewayId: 3, gatewayName: 'OpenRouter', ...noKey };

  it('私有模型进上面一节(不收进更多模型),不占推荐名额', () => {
    const recs = ['r1', 'r2', 'r3', 'r4', 'r5'].map((value) => ({ value, label: value, group: 'catalog' as const, recommended: true }));
    const split = splitModelMenu([mine, { ...mine, value: 'my-2' }, ...recs, ds], 'deepseek-v4');
    expect(split.primary.map((option) => option.value)).toEqual(['deepseek-v4', 'my-model', 'my-2', 'r1', 'r2', 'r3', 'r4']);
    expect(split.more.map((option) => option.value)).toEqual(['r5']);
  });

  it('不能用的照样列出,但排在能用的后面;推荐名额先给能用的', () => {
    const split = splitModelMenu([{ ...mine, ...noKey }, orRec, glm, ds, kimi], 'deepseek-v4');
    // 当前永远第一;能用的(推荐 glm / kimi)在前,不能用的私有 / 推荐沉底
    expect(split.primary.map((option) => option.value)).toEqual(['deepseek-v4', 'glm-5.2', 'kimi-k2.5', 'my-model', 'or-claude']);
    expect(split.more).toEqual([]);
  });

  it('推荐名额满了:挤不下的不能用的推荐进更多模型,也排在能用的后面', () => {
    const recs = ['r1', 'r2', 'r3', 'r4'].map((value) => ({ value, label: value, group: 'catalog' as const, recommended: true }));
    const split = splitModelMenu([orRec, ...recs, ds, { ...ds, value: 'plain-2' }], 'deepseek-v4');
    expect(split.primary.map((option) => option.value)).toEqual(['deepseek-v4', 'r1', 'r2', 'r3', 'r4']);
    expect(split.more.map((option) => option.value)).toEqual(['plain-2', 'or-claude']);
  });

  it('当前模型不能用:照样放第一行(不悄悄换),其余照常', () => {
    const split = splitModelMenu([orRec, glm, ds], 'or-claude');
    expect(split.primary.map((option) => option.value)).toEqual(['or-claude', 'glm-5.2']);
    expect(split.primary[0].available).toBe(false);
  });

  it('当前是别名、能用的推荐一条没有:补一个能用的目录模型(跳过不能用的)', () => {
    const split = splitModelMenu([orRec, { ...ds, ...noKey }, { ...kimi, recommended: false }, sonnet], 'sonnet');
    expect(split.primary.map((option) => option.value)).toEqual(['sonnet', 'kimi-k2.5', 'or-claude']);
    expect(split.more.map((option) => option.value)).toEqual(['deepseek-v4']);
  });

  it('当前模型不在列表里(下架 / 不再对他可见):上面一节照常,不崩', () => {
    const split = splitModelMenu([glm, orRec, ds], 'gone-model');
    expect(split.primary.map((option) => option.value)).toEqual(['glm-5.2', 'or-claude']);
    expect(split.more.map((option) => option.value)).toEqual(['deepseek-v4']);
  });

  it('↑↓ 跳过禁用的项', () => {
    const disabled = [false, true, true, false, true];
    expect(nextEnabledIndex(disabled, 0, 1)).toBe(3);
    expect(nextEnabledIndex(disabled, 3, 1)).toBe(0);
    expect(nextEnabledIndex(disabled, 0, -1)).toBe(3);
    expect(nextEnabledIndex(disabled, 3, -1)).toBe(0);
    // 焦点不在这一层:落到第一个能走的
    expect(nextEnabledIndex([true, false, false], -1, -1)).toBe(1);
    expect(nextEnabledIndex([true, false, false], -1, 1)).toBe(1);
    // 只有自己能走 / 全禁 / 空
    expect(nextEnabledIndex([true, false, true], 1, 1)).toBe(1);
    expect(nextEnabledIndex([true, true], -1, 1)).toBe(-1);
    expect(nextEnabledIndex([true, true], 0, 1)).toBe(-1);
    expect(nextEnabledIndex([], -1, 1)).toBe(-1);
  });
});
