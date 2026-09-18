import { describe, expect, it } from 'vitest';

import { describeDeleteFailure } from './deleteFailure';

/** gk:403 / 409 的原因要原样给用户看,不再一律「删除失败,请重试」。 */
describe('describeDeleteFailure', () => {
  it('取 error 字段', () => {
    expect(describeDeleteFailure(JSON.stringify({ success: false, error: '只有项目负责人或管理员可以永久删除这条会话;你可以把它归档。', code: 'SESSION_DELETE_FORBIDDEN' }), '默认'))
      .toBe('只有项目负责人或管理员可以永久删除这条会话;你可以把它归档。');
  });
  it('没有原因 / 不是 JSON → 默认文案', () => {
    expect(describeDeleteFailure('{}', '默认')).toBe('默认');
    expect(describeDeleteFailure('<html>', '默认')).toBe('默认');
    expect(describeDeleteFailure(JSON.stringify({ error: '   ' }), '默认')).toBe('默认');
  });
});
