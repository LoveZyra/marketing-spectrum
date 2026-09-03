import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMPOSER_DENSITY_COMPACT_BELOW,
  COMPOSER_DENSITY_MINIMAL_BELOW,
  resolveComposerDensity,
} from './composerDensity';

/**
 * ed:底栏密度档。阈值与"最窄 280px 正文栏 → 220px 底栏"的预算绑定
 * (ChatComposer 里逐项算过:minimal 档 134px ≤ 146px 可用)。
 */
describe('resolveComposerDensity', () => {
  it('三档阈值', () => {
    expect(resolveComposerDensity(220)).toBe('minimal');
    expect(resolveComposerDensity(COMPOSER_DENSITY_MINIMAL_BELOW - 1)).toBe('minimal');
    expect(resolveComposerDensity(COMPOSER_DENSITY_MINIMAL_BELOW)).toBe('compact');
    expect(resolveComposerDensity(COMPOSER_DENSITY_COMPACT_BELOW - 1)).toBe('compact');
    expect(resolveComposerDensity(COMPOSER_DENSITY_COMPACT_BELOW)).toBe('full');
    expect(resolveComposerDensity(1200)).toBe('full');
  });

  it('还没量到宽度(0 / NaN)时按 full 渲染,交给 ResizeObserver 纠正', () => {
    expect(resolveComposerDensity(0)).toBe('full');
    expect(resolveComposerDensity(Number.NaN)).toBe('full');
  });

  it('minimal 的阈值不能高过 compact', () => {
    expect(COMPOSER_DENSITY_MINIMAL_BELOW).toBeLessThan(COMPOSER_DENSITY_COMPACT_BELOW);
  });
});

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('底栏结构守门(源码)', () => {
  const composer = read('../view/subcomponents/ChatComposer.tsx');

  it('六个小图标已收进「+」菜单:底栏上只剩「+」、三个芯片、发送', () => {
    expect(composer).toMatch(/<ComposerPlusMenu items=\{plusMenuItems\}/);
    // 旧的并排图标按钮不能再出现在 JSX 里(它们只在菜单项里以 icon 出现)
    expect(composer).not.toMatch(/<PromptInputButton[\s\S]*?<Paperclip \/>/);
    expect(composer).not.toMatch(/<PromptInputButton[\s\S]*?<History \/>/);
    // 清空按钮整个撤掉(全选 + Delete 就是它;它还占着一个常驻的隐形位)
    expect(composer).not.toMatch(/onClearInput|clearInput/);
  });

  it('芯片不再看视口断点(sm:),只看密度档', () => {
    const footerStart = composer.indexOf('<PromptInputFooter');
    const footer = composer.slice(footerStart);
    expect(footer).not.toMatch(/hidden sm:inline|sm:h-1\.5|sm:max-w-20/);
    expect(footer).toMatch(/data-density=\{density\}/);
    expect(footer).toMatch(/density !== 'minimal' &&/);
    // Effort:闪电图标常驻,值与箭头只在非 minimal 档;不再有 "Effort" 文字前缀
    expect(footer).toMatch(/<Zap className=/);
    expect(footer).not.toMatch(/>Effort</);
    // 权限档位:图标替掉色点(芯片与下拉行都用 Icon,不再画 dotClassName 的圆点)
    expect(footer).toMatch(/<activeMode\.Icon/);
    expect(footer).toMatch(/<option\.Icon/);
    expect(footer).not.toMatch(/dotClassName/);
  });

  it('「+」菜单:附加类只剩「添加附件」一项且排第一;其后是链接 / 检查点 / 全部命令', () => {
    const ids = [...composer.matchAll(/id: '([a-z]+)',\n\s+icon:/g)].map((m) => m[1]);
    expect(ids).toEqual(['attach', 'url', 'checkpoints', 'commands']);
    // 「附加图片」「附加文档」「附加文件」三个旧入口都不再有独立的 prop / 隐藏 input
    expect(composer).not.toMatch(/onPickDocs|onPickAnyFiles|docInputRef|anyInputRef/);
  });

  it('布局:左组只有「+」;右组 = 权限档位 → 模型 → Effort → 停止 / 发送', () => {
    const footerStart = composer.indexOf('<PromptInputFooter');
    const toolsEnd = composer.indexOf('</PromptInputTools>', footerStart);
    const left = composer.slice(footerStart, toolsEnd);
    const right = composer.slice(toolsEnd);
    expect(left).toContain('<ComposerPlusMenu');
    expect(left).not.toContain('data-composer-chip=');
    const order = ['data-composer-chip="mode"', 'data-composer-chip="model"', 'data-composer-chip="effort"', '<PromptInputSubmit']
      .map((needle) => right.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 右组按内容定宽,压缩的永远是左组
    expect(right).toMatch(/ml-auto flex flex-none/);
  });
});
