import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { decideShellTabPrefix } from './shellTabPrefix';

const make = () => 'fresh1';

describe('hl 复核 P2-3 终端前缀', () => {
  test('刷新本页:沿用旧前缀,连回自己的 PTY', () => {
    assert.deepEqual(decideShellTabPrefix('reload', 'abc123', make), { prefix: 'abc123', reused: true });
  });
  test('复制标签页(sessionStorage 被复制过来,type 不是 reload):必须新生成', () => {
    assert.deepEqual(decideShellTabPrefix('back_forward', 'abc123', make), { prefix: 'fresh1', reused: false });
    assert.deepEqual(decideShellTabPrefix('navigate', 'abc123', make), { prefix: 'fresh1', reused: false });
    assert.deepEqual(decideShellTabPrefix(null, 'abc123', make), { prefix: 'fresh1', reused: false });
  });
  test('存的值不合法:新生成', () => {
    assert.equal(decideShellTabPrefix('reload', 'BAD!', make).reused, false);
  });
});
