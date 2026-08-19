import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { parseDfOutput } from '../services/server-status.service.js';

describe('parseDfOutput', () => {
  test('解析 POSIX df -kP 输出', () => {
    const out = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/vda1        103080204  57000000  46080204      56% /home`;
    assert.deepEqual(parseDfOutput(out, '/home/jovyan'), {
      path: '/home/jovyan',
      totalKb: 103080204,
      usedKb: 57000000,
      availableKb: 46080204,
      usedPercent: 56,
    });
  });

  test('残缺输出返回 null 而不是抛错', () => {
    assert.equal(parseDfOutput('', '/x'), null);
    assert.equal(parseDfOutput('Filesystem\nbad line', '/x'), null);
  });
});
