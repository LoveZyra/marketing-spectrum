import { describe, expect, it } from 'vitest';

import { version as packageVersion } from '../../package.json';

import { BUILD_RELEASE, BUILD_RELEASE_LABEL } from './releaseInfo';

/**
 * v2.0.0:前端显示的版本来自 package.json;日期与提交号是构建时注入的(vite.config.js 读包里的 RELEASE.json)。
 * 测试里没有注入值 —— 只有版本号,不能因为少了注入值就崩。
 */
describe('前端版本信息', () => {
  it('没有构建注入时只有 package.json 的版本号', () => {
    expect(BUILD_RELEASE).toEqual({ version: packageVersion, date: null, commit: null });
    expect(BUILD_RELEASE_LABEL).toBe(`v${packageVersion}`);
  });

  it('版本号是「主.次.修」三个数字', () => {
    expect(packageVersion).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  });
});
