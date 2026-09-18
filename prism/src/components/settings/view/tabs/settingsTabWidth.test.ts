/**
 * 设置弹窗里每一页的宽度口径要一致。
 *
 * 2026-09-15 用户逐个截图报过来:弹窗放宽之后,「我的账号」「模型映射」「服务器」
 * 三页的内容仍停在原地,右边空出一大条 —— 这三页各自在页面这一层设了
 * `max-w-xl` / `max-w-2xl` / `max-w-3xl`,而别的页签一个都没有。
 *
 * 这里钉的是:**页面根容器不许再有宽度上限**,由弹窗自己的宽度决定。
 * (表格里的 `max-w-48` 之类是列宽,不在此列。)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 页面根容器 = `return (` 之后第一个 `<div className="…">`。 */
const rootContainerClass = (source: string): string | null => {
  const returnAt = source.lastIndexOf('return (');
  if (returnAt < 0) return null;
  const match = /<div className="([^"]*)"/.exec(source.slice(returnAt));
  return match ? match[1] : null;
};

const TAB_FILES = readdirSync(here)
  .filter((name) => name.endsWith('Tab.tsx'))
  .sort();

describe('设置页的宽度口径', () => {
  it('至少扫到了几个页签文件(别因为改目录结构把这条测试变成空跑)', () => {
    expect(TAB_FILES.length).toBeGreaterThanOrEqual(5);
  });

  it('没有一页在根容器上设宽度上限', () => {
    const offenders: string[] = [];
    for (const file of TAB_FILES) {
      const cls = rootContainerClass(readFileSync(path.join(here, file), 'utf8'));
      if (cls && /(^|\s)max-w-/.test(cls)) offenders.push(`${file}: ${cls}`);
    }
    expect(offenders, `这些页签又在根容器上设了宽度上限:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('三个当事页签逐一点名(改目录结构时不至于静默漏掉)', () => {
    for (const file of ['AccountSettingsTab.tsx', 'ModelMappingSettingsTab.tsx', 'ServerStatusTab.tsx']) {
      const cls = rootContainerClass(readFileSync(path.join(here, file), 'utf8')) ?? '';
      expect(cls, `${file} 的根容器仍有宽度上限:${cls}`).not.toMatch(/(^|\s)max-w-/);
    }
  });
});
