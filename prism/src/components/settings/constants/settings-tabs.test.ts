import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { SETTINGS_MAIN_TABS, SETTINGS_MAIN_TAB_IDS } from './constants';
import type { SettingsMainTab } from '../types/types';

/**
 * 设置页标签清单的单一来源。
 *
 * 这些断言存在的理由是一次真实的漂移:同一份清单曾经手写在三处,只有侧栏那份
 * 有 `voice`,于是命令面板搜不到语音设置、`?tab=voice` 深链静默回落到 agents。
 * 谁再加一个标签而只改了其中一处,下面就会红。
 */
describe('设置页主标签清单', () => {
  test('每个标签都有 id / label / labelKey / keywords / icon', () => {
    for (const tab of SETTINGS_MAIN_TABS) {
      assert.ok(tab.id, 'id 不能为空');
      assert.ok(tab.label, `${tab.id} 缺 label`);
      assert.match(tab.labelKey, /^mainTabs\./, `${tab.id} 的 labelKey 应在 mainTabs 命名空间下`);
      assert.ok(tab.keywords.length > 0, `${tab.id} 缺 keywords`);
      assert.ok(tab.icon, `${tab.id} 缺 icon`);
    }
  });

  test('id 不重复', () => {
    assert.equal(new Set(SETTINGS_MAIN_TAB_IDS).size, SETTINGS_MAIN_TAB_IDS.length);
  });

  test('SETTINGS_MAIN_TAB_IDS 与清单同步', () => {
    assert.deepEqual(SETTINGS_MAIN_TAB_IDS, SETTINGS_MAIN_TABS.map((tab) => tab.id));
  });

  test('语音标签已随功能整体移除', () => {
    assert.equal(SETTINGS_MAIN_TAB_IDS.includes('voice' as SettingsMainTab), false);
  });

  test('只有 accounts 是 root 专属', () => {
    const rootOnly = SETTINGS_MAIN_TABS.filter((tab) => tab.rootOnly).map((tab) => tab.id);
    assert.deepEqual(rootOnly, ['accounts']);
  });
});
