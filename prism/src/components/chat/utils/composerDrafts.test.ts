import { describe, test, expect } from 'vitest';

import { draftStorageKey } from './composerDrafts';

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
