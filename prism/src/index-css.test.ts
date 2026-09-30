import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * hf:原生 select 的下拉箭头是 index.css 里画在右内边距上的背景图。几乎每个 select 都带
 * `p-2` / `px-3` 之类的工具类,工具类会把右内边距改小,箭头就压到文字上 —— 所以右内边距
 * 必须 !important 固定成"箭头宽 + 留白",且与箭头的尺寸 / 位置同口径。
 */
const css = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8');

describe('select 的下拉箭头', () => {
  it('右内边距压得过工具类,且留够箭头的位置', () => {
    const rule = css.match(/\n {2}select \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/background-size: 1\.125em 1\.125em;/);
    expect(rule).toMatch(/background-position: right 0\.4rem center;/);
    expect(rule).toMatch(/padding-right: calc\(1\.125em \+ 0\.8rem\) !important;/);
  });
});
