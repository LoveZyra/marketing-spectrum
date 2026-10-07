import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMPOSER_DENSITY_COMPACT_BELOW,
  COMPOSER_DENSITY_MINIMAL_BELOW,
  COMPOSER_EXTRA_ACTION_WIDTH,
  fitsExtraFooterAction,
  resolveComposerDensity,
  resolveComposerFooterLayout,
} from './composerDensity';

/**
 * 底栏密度档。阈值与"最窄 280px 正文栏 → 218px 底栏"的预算绑定
 * (ChatComposer 里逐项算过:minimal 档 202px ≤ 218px)。
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

/**
 * 「转到后台」放不放得进底栏。
 *
 * 各档最坏情况(停止与发送同时在场)的预算见 ChatComposer 的注释;回合进行中有前台子代理时
 * 右组还多一个「转到后台」。放进底栏的前提是加上它也不超:否则超出的部分从左组裁起,「+」被挤掉。
 */
describe('fitsExtraFooterAction', () => {
  /** 各档最坏情况的底栏宽度(停止与发送同时在场),与 ChatComposer 注释里的预算一致。 */
  const WORST_CASE = { minimal: 202, compact: 442, full: 572 } as const;
  /** minimal 档右组间距是 4px,比另外两档少 4。 */
  const extraFor = (density: keyof typeof WORST_CASE) => COMPOSER_EXTRA_ACTION_WIDTH - (density === 'minimal' ? 4 : 0);

  it('最窄 218px 底栏(minimal)放不下:三个按钮同时在场要 238px', () => {
    expect(WORST_CASE.minimal + extraFor('minimal')).toBeGreaterThan(218);
    expect(fitsExtraFooterAction(218)).toBe(false);
    expect(fitsExtraFooterAction(COMPOSER_DENSITY_MINIMAL_BELOW - 1)).toBe(false);
  });

  it('compact 下限附近放不下,往上留够它的宽度才放', () => {
    expect(fitsExtraFooterAction(COMPOSER_DENSITY_MINIMAL_BELOW)).toBe(false);
    expect(fitsExtraFooterAction(COMPOSER_DENSITY_MINIMAL_BELOW + COMPOSER_EXTRA_ACTION_WIDTH - 1)).toBe(false);
    expect(fitsExtraFooterAction(COMPOSER_DENSITY_MINIMAL_BELOW + COMPOSER_EXTRA_ACTION_WIDTH)).toBe(true);
  });

  it('凡是判成"放得下"的宽度,加上它都不超预算(逐像素扫一遍)', () => {
    for (let width = 218; width <= 1200; width += 1) {
      const { density, extraActionFits } = resolveComposerFooterLayout(width);
      const needed = WORST_CASE[density] + (extraActionFits ? extraFor(density) : 0);
      expect(needed, `底栏 ${width}px · ${density}${extraActionFits ? ' · 带转到后台' : ''}`).toBeLessThanOrEqual(width);
    }
  });

  it('还没量到宽度时与密度档同口径,按宽的算', () => {
    expect(fitsExtraFooterAction(0)).toBe(true);
    expect(fitsExtraFooterAction(Number.NaN)).toBe(true);
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
    // 附件 / 历史等图标按钮不能出现在底栏 JSX 里(它们只在菜单项里以 icon 出现)
    expect(composer).not.toMatch(/<PromptInputButton[\s\S]*?<Paperclip \/>/);
    expect(composer).not.toMatch(/<PromptInputButton[\s\S]*?<History \/>/);
    // 不设清空按钮:全选 + Delete 即可清空,常驻按钮还会占一个隐形位
    expect(composer).not.toMatch(/onClearInput|clearInput/);
  });

  it('芯片不再看视口断点(sm:),只看密度档', () => {
    const footerStart = composer.indexOf('<PromptInputFooter');
    const footer = composer.slice(footerStart);
    expect(footer).not.toMatch(/hidden sm:inline|sm:h-1\.5|sm:max-w-20/);
    expect(footer).toMatch(/data-density=\{density\}/);
    expect(footer).toMatch(/density !== 'minimal' &&/);
    // Effort:闪电图标常驻,值与箭头只在非 minimal 档;没有 "Effort" 文字前缀
    expect(footer).toMatch(/<Zap className=/);
    expect(footer).not.toMatch(/>Effort</);
    // 权限档位用图标而不是色点(芯片与下拉行都用 Icon,不画 dotClassName 的圆点)
    expect(footer).toMatch(/<activeMode\.Icon/);
    expect(footer).toMatch(/<option\.Icon/);
    expect(footer).not.toMatch(/dotClassName/);
  });

  it('「+」菜单:附加类只剩「添加附件」一项且排第一;其后是链接 / 检查点 / 全部命令,底栏放不下时最后是「转到后台」', () => {
    const ids = [...composer.matchAll(/id: '([a-z]+)',\n\s+icon:/g)].map((m) => m[1]);
    expect(ids).toEqual(['attach', 'url', 'checkpoints', 'commands', 'background']);
    // 图片 / 文档 / 任意文件统一走「添加附件」,没有各自独立的 prop / 隐藏 input
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

  it('「转到后台」放得下才进底栏,放不下进「+」菜单,两处不会同时出现', () => {
    expect(composer).toMatch(/const backgroundInFooter = backgroundActionAvailable && extraActionFits;/);
    expect(composer).toMatch(/const backgroundInMenu = backgroundActionAvailable && !extraActionFits;/);
    const footerStart = composer.indexOf('<PromptInputFooter');
    const footer = composer.slice(footerStart);
    expect(footer).toMatch(/\{backgroundInFooter && onBackgroundForeground && \(\s*<button[\s\S]*?data-composer-action="to-background"/);
    expect(composer).toMatch(/if \(backgroundInMenu && onBackgroundForeground\) \{\s*items\.push\(\{\s*id: 'background',/);
  });
});
