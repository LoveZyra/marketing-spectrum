/**
 * 输入框底栏的"密度档"。底栏(「+」、模型 / 档位 / Effort 三个芯片、停止 / 发送)最窄时也不折行。
 *
 * 不能按视口断点(`sm:`)决定芯片显不显示文字:聊天正文栏的宽度由右侧预览栏决定,与视口无关,
 * 1400px 的窗口里正文栏照样可以只有 280px。所以按底栏自己的实测宽度分三档(容器查询的思路,ResizeObserver 实现):
 *
 *   full    ≥ 640px  模型全名(≤192px)、档位图标 + 文字、闪电 + Effort 值
 *   compact ≥ 460px  模型名截到 64px、档位图标 + 文字、闪电 + Effort 值
 *   minimal <  460px 模型只留图标、档位只留图标、Effort 只留闪电;下拉箭头省掉,
 *                    芯片内边距收到 6px,组间距收到 4 / 6px
 *
 * 布局:左组 =「+」;右组 = 权限档位 + 模型 + Effort + 停止 / 发送。
 * 三档的预算(见 ChatComposer 里的注释)都按"280px 正文栏 → 218px 底栏(实测)"这个
 * 最坏情况、且停止与发送同时在场算过:minimal 档 202px,留 16px 余量。
 * 回合进行中有前台子代理时右组还多一个「转到后台」,它放不放得进底栏见 `fitsExtraFooterAction`。
 * 纯函数,单测钉住阈值;hook 只负责量宽度。
 */
export type ComposerDensity = 'full' | 'compact' | 'minimal';

export const COMPOSER_DENSITY_COMPACT_BELOW = 640;
export const COMPOSER_DENSITY_MINIMAL_BELOW = 460;

export function resolveComposerDensity(footerWidth: number): ComposerDensity {
  // 还没量到(0 / NaN)时按 full 渲染:首帧宁可宽一点,ResizeObserver 马上会纠正。
  if (!Number.isFinite(footerWidth) || footerWidth <= 0) return 'full';
  if (footerWidth < COMPOSER_DENSITY_MINIMAL_BELOW) return 'minimal';
  if (footerWidth < COMPOSER_DENSITY_COMPACT_BELOW) return 'compact';
  return 'full';
}

/** 「转到后台」按钮要占的宽度:32px 方钮 + 右组间距 8px(compact / full 档)。 */
export const COMPOSER_EXTRA_ACTION_WIDTH = 40;

/**
 * 「转到后台」放得进底栏吗;放不进就收进「+」菜单。
 *
 * 它出现时停止往往也在,有草稿时发送也在。三档预算按"停止与发送同时在场"算过,再加它一个:
 * full 572 + 40 = 612 ≤ 640,照放;compact 442 + 40 = 482,超过 compact 的下限 460;
 * minimal 202 + 36 = 238,超过最窄的 218。超出的部分会从左组裁起,「+」被挤掉。
 * 所以按"底栏减去它之后还够 compact 的下限"判:够就放底栏(compact 482 ≤ 500、full 照放),
 * 不够就收进菜单,芯片仍按底栏本身的宽度分档。
 */
export function fitsExtraFooterAction(footerWidth: number): boolean {
  // 还没量到时与 resolveComposerDensity 同口径,按宽的算,ResizeObserver 马上会纠正
  if (!Number.isFinite(footerWidth) || footerWidth <= 0) return true;
  return footerWidth - COMPOSER_EXTRA_ACTION_WIDTH >= COMPOSER_DENSITY_MINIMAL_BELOW;
}

export interface ComposerFooterLayout {
  density: ComposerDensity;
  /** 「转到后台」放得进底栏(见 fitsExtraFooterAction)。 */
  extraActionFits: boolean;
}

export function resolveComposerFooterLayout(footerWidth: number): ComposerFooterLayout {
  return {
    density: resolveComposerDensity(footerWidth),
    extraActionFits: fitsExtraFooterAction(footerWidth),
  };
}
