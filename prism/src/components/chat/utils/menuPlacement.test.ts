import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { clampMenuLeft } from './menuPlacement';

describe('hl(动态 P2-21)浮层菜单横向夹取', () => {
  test('桌面:按钮在左侧时位置不变', () => {
    assert.equal(clampMenuLeft(100, 288, 1440), 100);
  });
  test('手机:按钮靠右时整个菜单挪回视口内', () => {
    // 基线直接用 rect.left=250,在 375 宽的屏上右边 163px 被裁
    assert.equal(clampMenuLeft(250, 288, 375), 375 - 288 - 8);
  });
  test('视口比菜单还窄:贴左边距,不出现负数', () => {
    assert.equal(clampMenuLeft(40, 288, 280), 8);
  });
});
