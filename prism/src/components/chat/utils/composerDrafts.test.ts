import { describe, test, expect } from 'vitest';

import { draftStorageKey, mergeQueuedIntoInput } from './composerDrafts';

/**
 * F2 回归:草稿按会话分键。原来按项目分,同项目多个会话的草稿互相覆盖。
 */
describe('draftStorageKey', () => {
  test('有会话号:会话键优先', () => {
    expect(draftStorageKey('sess_abc', 'proj1')).toBe('draft_input_session_sess_abc');
  });

  test('没有会话号(新建会话页):退回项目键(与历史键名兼容)', () => {
    expect(draftStorageKey(null, 'proj1')).toBe('draft_input_proj1');
    expect(draftStorageKey(undefined, 'proj1')).toBe('draft_input_proj1');
  });

  test('两者都没有:无键(不落盘)', () => {
    expect(draftStorageKey(null, null)).toBeNull();
    expect(draftStorageKey(null, undefined)).toBeNull();
  });
});

/**
 * dn-B2 回归:按停止时排队内容与正在打的字合并,谁都不丢。
 */
describe('mergeQueuedIntoInput', () => {
  test('输入框为空:整条排队内容原样回来', () => {
    expect(mergeQueuedIntoInput('排队的纠正', '')).toBe('排队的纠正');
    expect(mergeQueuedIntoInput('排队的纠正', '   ')).toBe('排队的纠正');
  });

  test('两边都有:排队在前、当前输入在后,一个换行隔开', () => {
    expect(mergeQueuedIntoInput('先排的话', '正在打的话')).toBe('先排的话\n正在打的话');
  });

  test('排队内容尾部空白被收干净,不产生双空行', () => {
    expect(mergeQueuedIntoInput('先排的话\n\n', '正在打的话')).toBe('先排的话\n正在打的话');
  });

  test('排队内容为空:当前输入原样保留', () => {
    expect(mergeQueuedIntoInput('', '正在打的话')).toBe('正在打的话');
    expect(mergeQueuedIntoInput('  \n', '正在打的话')).toBe('正在打的话');
  });
});
