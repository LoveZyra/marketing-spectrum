import { describe, expect, it } from 'vitest';

import { isSkillWhetUsable, skillWhetModelRows } from './modelRows';

const row = (value: string) => ({ value, label: value });
const catalog = [row('glm-5.2'), row('deepseek-v4')];
const aliases = [row('haiku'), row('sonnet'), row('opus')];

describe('SkillWhet 模型下拉的可选行', () => {
  it('root:目录条目(不含别名)', () => {
    expect(skillWhetModelRows(catalog, aliases, null).map((r) => r.value)).toEqual(['glm-5.2', 'deepseek-v4']);
  });

  it('默认名单(三个别名 + 目录):只列目录条目,别名不当选项', () => {
    const allowed = ['haiku', 'sonnet', 'opus', 'glm-5.2', 'deepseek-v4'];
    expect(skillWhetModelRows(catalog, aliases, allowed).map((r) => r.value)).toEqual(['glm-5.2', 'deepseek-v4']);
  });

  it('名单只有别名:别名照给(否则下拉是空的)', () => {
    expect(skillWhetModelRows(catalog, aliases, ['haiku', 'sonnet', 'opus']).map((r) => r.value)).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('名单里有目录外的网关名:作纯文字行', () => {
    const rows = skillWhetModelRows(catalog, aliases, ['glm-5.2', 'my-gateway-model']);
    expect(rows.map((r) => r.value)).toEqual(['glm-5.2', 'my-gateway-model']);
    expect(rows[1]).toMatchObject({ mono: true });
  });
});

describe('SkillWhet 只用默认网关上、所有人可见的模型', () => {
  const shared = { value: 'glm-5.2', label: 'GLM 5.2', gatewayId: 0 };
  const legacy = { value: 'deepseek-v4', label: 'DeepSeek V4' }; // 没有 gatewayId 的行按默认网关算
  const otherGateway = { value: 'or-claude', label: 'OR Claude', gatewayId: 3 };
  const mine = { value: 'my-model', label: 'My Model', gatewayId: 7, private: true };
  const minePrivateOnDefault = { value: 'my-default', label: 'Mine on default', gatewayId: 0, private: true };
  const models = [mine, minePrivateOnDefault, shared, otherGateway, legacy];

  it('判据:gatewayId > 0 或私有 → 不能用', () => {
    expect(isSkillWhetUsable(shared)).toBe(true);
    expect(isSkillWhetUsable(legacy)).toBe(true);
    expect(isSkillWhetUsable(otherGateway)).toBe(false);
    expect(isSkillWhetUsable(mine)).toBe(false);
    expect(isSkillWhetUsable(minePrivateOnDefault)).toBe(false);
  });

  it('root(不限)也筛掉别的网关 / 私有', () => {
    expect(skillWhetModelRows(models, aliases, null).map((r) => r.value)).toEqual(['glm-5.2', 'deepseek-v4']);
  });

  it('非 root:名单里的别的网关 / 私有模型既不当选项,也不补成纯文字行', () => {
    const rows = skillWhetModelRows(models, aliases, ['or-claude', 'my-model', 'glm-5.2', 'my-gateway-model']);
    expect(rows.map((r) => r.value)).toEqual(['glm-5.2', 'my-gateway-model']);
  });

  it('名单里只有被筛掉的目录模型:退回别名(与"名单只有别名"同一条路)', () => {
    expect(skillWhetModelRows(models, aliases, ['or-claude', 'haiku']).map((r) => r.value)).toEqual(['haiku']);
  });
});
