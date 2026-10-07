import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import type { SettingsMainTab } from '../types/types';

import { SETTINGS_MAIN_TABS, SETTINGS_MAIN_TAB_IDS } from './constants';

/**
 * 设置页标签清单的单一来源:侧栏、命令面板、深链校验都从 SETTINGS_MAIN_TABS 派生。
 * 钉住清单本身的完整性、root 专属范围与「模型网关」的位置。
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

  test('root 专属标签 = 账号管理 + 模型映射 + 服务器状态', () => {
    const rootOnly = SETTINGS_MAIN_TABS.filter((tab) => tab.rootOnly).map((tab) => tab.id);
    assert.deepEqual(rootOnly, ['accounts', 'models', 'server']);
  });

  test('「模型网关」每个人都有(不是 root 专属),排在「模型」前面', () => {
    const tab = SETTINGS_MAIN_TABS.find((item) => item.id === 'gateways');
    assert.ok(tab, '缺 gateways 标签');
    assert.equal(tab.rootOnly, undefined);
    assert.equal(tab.labelKey, 'mainTabs.gateways');
    assert.ok(SETTINGS_MAIN_TAB_IDS.indexOf('gateways') < SETTINGS_MAIN_TAB_IDS.indexOf('models'));
  });
});
