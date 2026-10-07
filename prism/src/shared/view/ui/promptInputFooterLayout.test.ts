import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 底栏"单行、永不折行、发送按钮永远在右下角"的布局不变量。
 *
 * 附件图标收在「+」菜单里、芯片按底栏实测宽度分档收缩,底栏是 nowrap;工具组 overflow-hidden,
 * 超了预算被裁的是工具组尾部而不是发送按钮。
 *
 * 客户端测试跑在 `environment: 'node'`(没有 jsdom),量不了真实盒模型,
 * 真实宽度由 Playwright 实机校验(280 / 320 / 400 / 600 / 900px 五档)。这里把 class 钉死:
 * 谁把底栏改成"可换行"或把工具组的 min-w-0 去掉,这条会先红。
 */

const source = readFileSync(
  fileURLToPath(new URL('./PromptInput.tsx', import.meta.url)),
  'utf8'
);

/** 取某个 `data-slot` 组件上 cn(...) 里的首个字符串字面量。 */
function classListOf(slot: string): string {
  const at = source.indexOf(`data-slot="${slot}"`);
  expect(at, `找不到 data-slot="${slot}"`).toBeGreaterThan(-1);
  const tail = source
    .slice(at)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const matched = /className=\{cn\(\s*'([^']+)'/.exec(tail);
  expect(matched, `${slot} 的 className 不是 cn('…', className) 形状`).not.toBeNull();
  return matched![1];
}

describe('输入框底栏布局不变量', () => {
  it('底栏单行不换行', () => {
    const classes = classListOf('prompt-input-footer').split(/\s+/);
    expect(classes).toContain('flex');
    expect(classes).toContain('flex-nowrap');
    expect(classes).not.toContain('flex-wrap');
    expect(classes).toContain('items-center');
  });

  it('工具组可收缩、单行、超出即裁 —— 不把发送按钮顶出容器', () => {
    const classes = classListOf('prompt-input-tools').split(/\s+/);
    // min-w-0 缺一个,flex 子项就按 min-content 撑着不收缩,右边必被顶出去。
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('flex-1');
    expect(classes).toContain('flex-nowrap');
    expect(classes).toContain('overflow-hidden');
    // 裁剪盒上下各留 4px,聚焦环不被裁
    expect(classes).toContain('-my-1');
    expect(classes).toContain('py-1');
  });

  it('根元素仍是 overflow-hidden —— 说明上面两条是真的必要,不是防御性冗余', () => {
    const classes = classListOf('prompt-input').split(/\s+/);
    expect(classes).toContain('overflow-hidden');
  });
});
