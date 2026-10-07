import { describe, expect, it } from 'vitest';

import { buildModelRows, splitSelectableModels } from './useTaskLikeOptions';

const row = (value: string) => ({ value, label: value });

describe('定时任务 / SkillWhet 的模型下拉不列别名', () => {
  it('目录里有模型:只列目录条目,别名收起来(仍可用于显示当前值)', () => {
    const split = splitSelectableModels(
      [row('glm-5.2'), row('deepseek-v4'), row('sonnet'), row('opus'), row('haiku')],
      [
        { value: 'glm-5.2', group: 'catalog' }, { value: 'deepseek-v4', group: 'catalog' },
        { value: 'sonnet', group: 'alias' }, { value: 'opus', group: 'alias' }, { value: 'haiku', group: 'alias' },
      ],
    );
    expect(split.models.map((option) => option.value)).toEqual(['glm-5.2', 'deepseek-v4']);
    expect(split.aliasModels.map((option) => option.value)).toEqual(['sonnet', 'opus', 'haiku']);
  });

  it('目录为空 / 老服务端没有分组:别名照旧是全部可选项', () => {
    expect(splitSelectableModels([row('sonnet'), row('opus')], [{ value: 'sonnet', group: 'alias' }, { value: 'opus', group: 'alias' }]).models)
      .toHaveLength(2);
    const legacy = splitSelectableModels([row('sonnet'), row('opus')], [{ value: 'sonnet' }, { value: 'opus' }]);
    expect(legacy.models.map((option) => option.value)).toEqual(['sonnet', 'opus']);
    expect(legacy.aliasModels).toEqual([]);
  });
});

describe('定时任务的模型下拉 —— 私有 / 别的网关 / 不能用', () => {
  const labels = { privateBadge: '私有', unavailable: '暂不可用' };
  const options = [
    { value: 'my-model', label: 'My Model', group: 'catalog' as const, private: true, gatewayId: 7, gatewayName: '我的网关', available: true },
    { value: 'or-claude', label: 'OR Claude', group: 'catalog' as const, gatewayId: 3, gatewayName: 'OpenRouter', available: false, unavailableReason: '网关「OpenRouter」需要你自己的 key' },
    { value: 'glm-5.2', label: 'GLM 5.2', group: 'catalog' as const, gatewayId: 0, available: true, contextWindow: 128_000 },
    { value: 'off', label: 'Off', group: 'catalog' as const, gatewayId: 4, available: false },
    { value: 'default', label: 'Default', group: 'alias' as const, gatewayId: 0 },
    { value: 'sonnet', label: 'Sonnet', group: 'alias' as const, gatewayId: 0 },
  ];

  it('行:私有带小标;别的网关副行带网关名;不能用的置灰、副行是原因;default 不进来', () => {
    const rows = buildModelRows(options, () => null, labels);
    expect(rows.map((row) => row.value)).toEqual(['my-model', 'or-claude', 'glm-5.2', 'off', 'sonnet']);
    const [mine, openRouter, glm, off] = rows;
    expect(mine).toMatchObject({ badge: '私有', private: true, gatewayId: 7, sublabel: 'my-model · 我的网关' });
    expect(mine.disabled).toBeUndefined();
    expect(openRouter).toMatchObject({ disabled: true, gatewayId: 3, sublabel: '网关「OpenRouter」需要你自己的 key' });
    expect(openRouter.badge).toBeUndefined();
    expect(glm).toMatchObject({ gatewayId: 0, sublabel: 'glm-5.2 · 128K' });
    expect(glm.disabled).toBeUndefined();
    expect(off).toMatchObject({ disabled: true, sublabel: '暂不可用' });
  });

  it('可选项:不能用的照样列出、排在能用的后面(私有仍在能用的最前)', () => {
    const rows = buildModelRows(options, () => null, labels);
    const split = splitSelectableModels(rows, options);
    expect(split.models.map((row) => row.value)).toEqual(['my-model', 'glm-5.2', 'or-claude', 'off']);
    expect(split.models.filter((row) => row.disabled).map((row) => row.value)).toEqual(['or-claude', 'off']);
    expect(split.aliasModels.map((row) => row.value)).toEqual(['sonnet']);
  });

  it('别名行:配了真实模型时主行写真名(与之前一样),带 gatewayId 0', () => {
    const rows = buildModelRows(options, (alias) => (alias === 'sonnet' ? 'glm-5.2' : null), labels);
    expect(rows.find((row) => row.value === 'sonnet')).toMatchObject({ label: 'glm-5.2', sublabel: 'sonnet · Sonnet', mono: true, gatewayId: 0 });
  });
});
