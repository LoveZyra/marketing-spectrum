import { describe, expect, it } from 'vitest';

import {
  applyManualToggle,
  applyPreviewChange,
  type AutoCollapseState,
} from './workPanelAutoCollapse';

/**
 * dy:"预览开着就让位"的四条规则。这里全都从用户视角写成一句话的场景 ——
 * 每一条对应一种"面板自作主张把我的选择弄丢了"的翻车方式。
 */

const expanded: AutoCollapseState = { collapsed: false, auto: false };
const manuallyCollapsed: AutoCollapseState = { collapsed: true, auto: false };

describe('工作面板自动折叠', () => {
  it('展开着 → 开预览 → 自动折起,并记下"这次是我折的"', () => {
    expect(applyPreviewChange(expanded, true)).toEqual({ collapsed: true, auto: true });
  });

  it('自动折起 → 关预览 → 自动还原', () => {
    const afterOpen = applyPreviewChange(expanded, true);
    expect(applyPreviewChange(afterOpen, false)).toEqual({ collapsed: false, auto: false });
  });

  it('用户自己折起来的 → 开预览不认领 → 关预览也不会替他展开', () => {
    const afterOpen = applyPreviewChange(manuallyCollapsed, true);
    expect(afterOpen).toEqual(manuallyCollapsed);
    expect(applyPreviewChange(afterOpen, false)).toEqual(manuallyCollapsed);
  });

  it('预览开着时用户手动展开 → 关预览不再插手(否则会把他刚展开的又收回去)', () => {
    const afterOpen = applyPreviewChange(expanded, true); // {collapsed:true, auto:true}
    const afterManual = applyManualToggle(afterOpen);     // 用户点开
    expect(afterManual.collapsed).toBe(false);
    expect(afterManual.auto).toBe(false);
    // 关预览:auto 已作废,状态原样不动
    expect(applyPreviewChange(afterManual, false)).toEqual({ collapsed: false, auto: false });
  });

  it('只有手动那次才落盘 —— 自动折/自动还原不写 localStorage', () => {
    expect(applyManualToggle(expanded).persist).toBe(true);
    // 自动路径的返回值里压根没有 persist 这个字段
    expect(applyPreviewChange(expanded, true)).not.toHaveProperty('persist');
    expect(applyPreviewChange({ collapsed: true, auto: true }, false)).not.toHaveProperty('persist');
  });

  it('预览重复触发同一个值时是幂等的(effect 可能因别的原因重跑)', () => {
    const once = applyPreviewChange(expanded, true);
    expect(applyPreviewChange(once, true)).toEqual(once);
    const back = applyPreviewChange(once, false);
    expect(applyPreviewChange(back, false)).toEqual(back);
  });
});
