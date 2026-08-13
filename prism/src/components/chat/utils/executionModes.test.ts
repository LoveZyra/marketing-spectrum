import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { EXECUTION_MODES, executionModeMeta, orderedExecutionModes } from './executionModes';

describe('执行模式挡位', () => {
  test('每个挡位都对应一个真实的 permission mode,没有凭空造出来的值', () => {
    // 这些字符串会原样发给服务端;写错一个,那一挡就静默退回默认模式
    const known = new Set(['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan']);
    for (const entry of EXECUTION_MODES) {
      assert.ok(known.has(entry.mode), `未知挡位: ${entry.mode}`);
    }
  });

  test('挡位按权限从小到大排,危险的那一挡永远在最后', () => {
    const order = EXECUTION_MODES.map((entry) => entry.mode);
    assert.equal(order[0], 'default');
    assert.equal(order[order.length - 1], 'bypassPermissions');
    assert.ok(order.indexOf('plan') < order.indexOf('acceptEdits'));
  });

  test('只列出 provider 真正支持的挡位', () => {
    const modes = orderedExecutionModes(['default', 'plan']).map((entry) => entry.mode);
    assert.deepEqual(modes, ['default', 'plan']);
  });

  test('provider 能力拿不到时不返回空列表 —— 空下拉框比默认项更糟', () => {
    const modes = orderedExecutionModes([]).map((entry) => entry.mode);
    assert.deepEqual(modes, ['default']);
  });

  test('未知模式回退到默认挡,不会渲染出没有样式的空挡位', () => {
    assert.equal(executionModeMeta('something-else').mode, 'default');
    assert.equal(executionModeMeta('plan').mode, 'plan');
  });
});
