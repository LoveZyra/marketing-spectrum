import assert from 'node:assert/strict';

import { afterEach, describe, test } from 'vitest';

import { applyServerToolPolicy } from '../claude-sdk.js';

/**
 * ga:「免确认框」有**两个**入口,`PRISM_ALLOW_BYPASS_USERS` 必须同时管住两个。
 *
 * 此前策略只看 `permissionMode === 'bypassPermissions'`(下拉框那个入口)。
 * 而 `toolsSettings.allowedTools` 是第二个:命中它的工具直接 behavior:'allow',
 * 还会被塞进 sdkOptions 让 CLI 连问都不问。于是名单配了等于没配。
 */
const ORIGINAL = process.env.PRISM_ALLOW_BYPASS_USERS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PRISM_ALLOW_BYPASS_USERS;
  else process.env.PRISM_ALLOW_BYPASS_USERS = ORIGINAL;
});

describe('applyServerToolPolicy 的预批清单', () => {
  test('**名单外的人:预批清单被清空**(确认框还回来)', () => {
    process.env.PRISM_ALLOW_BYPASS_USERS = 'alice,boss';
    const policed = applyServerToolPolicy('acceptEdits', [], 'mallory', ['Bash', 'Write', 'Edit']);
    assert.deepEqual(policed.allowedTools, []);
    // 档位本身不是 bypass,所以不降级 —— 但确认框回来了
    assert.equal(policed.permissionMode, 'acceptEdits');
  });

  test('名单里的人:照旧放行', () => {
    process.env.PRISM_ALLOW_BYPASS_USERS = 'alice,boss';
    const policed = applyServerToolPolicy('acceptEdits', [], 'Alice', ['Bash', 'Write']);
    assert.deepEqual(policed.allowedTools, ['Bash', 'Write']);
  });

  test('**没配名单 = 不管**:一切照旧(不能让没开这个功能的部署行为变化)', () => {
    delete process.env.PRISM_ALLOW_BYPASS_USERS;
    const policed = applyServerToolPolicy('acceptEdits', [], 'anyone', ['Bash', 'Write']);
    assert.deepEqual(policed.allowedTools, ['Bash', 'Write']);
  });

  test('**禁用永远压过预批** —— 两张单子撞车时拒的那张赢', () => {
    delete process.env.PRISM_ALLOW_BYPASS_USERS;
    const policed = applyServerToolPolicy('acceptEdits', ['Bash'], 'anyone', ['Bash', 'Read']);
    assert.deepEqual(policed.allowedTools, ['Read']);
    assert.ok(policed.disallowedTools.includes('Bash'));
  });

  test('**认不出来的 permissionMode 一律按 default**(聊天这条路此前完全不校验)', () => {
    delete process.env.PRISM_ALLOW_BYPASS_USERS;
    assert.equal(applyServerToolPolicy('随便编一个', [], 'x', []).permissionMode, 'default');
    assert.equal(applyServerToolPolicy(undefined, [], 'x', []).permissionMode, 'default');
    for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions']) {
      assert.equal(applyServerToolPolicy(mode, [], 'x', []).permissionMode, mode);
    }
  });

  test('没给预批清单时不炸,也不凭空造一个', () => {
    assert.deepEqual(applyServerToolPolicy('default', [], 'x', undefined).allowedTools, []);
    assert.deepEqual(applyServerToolPolicy('default', [], 'x', null).allowedTools, []);
  });
});
