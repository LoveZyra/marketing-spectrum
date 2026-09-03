/**
 * ed:输入框底栏的"密度档"。
 *
 * 底栏那一排(「+」、模型 / 档位 / Effort 三个芯片、发送)以前靠 dw 的
 * `flex-wrap` 兜底 —— 放不下就折成两行。用户要的是**最窄时也不折行**。
 * 折行的根源是芯片按视口断点(`sm:`)决定要不要显示文字,而聊天正文栏的宽度
 * 由右侧预览栏决定,与视口无关:1400px 的窗口里正文栏照样可以只有 280px。
 *
 * 所以改成按**底栏自己的实测宽度**分三档(容器查询的思路,ResizeObserver 实现):
 *
 *   full    ≥ 640px  模型全名(≤192px)、档位图标 + 文字、闪电 + Effort 值
 *   compact ≥ 460px  模型名截到 64px、档位图标 + 文字、闪电 + Effort 值
 *   minimal <  460px 模型只留图标、档位只留图标、Effort 只留闪电;下拉箭头省掉,
 *                    芯片内边距收到 6px,组间距收到 4 / 6px
 *
 * 布局(参考 Cowork):左组 =「+」;右组 = 权限档位 + 模型 + Effort + 停止 / 发送。
 * 三档的预算(见 ChatComposer 里的注释)都按"280px 正文栏 → 218px 底栏(实测)"这个
 * 最坏情况、且**停止与发送同时在场**算过:minimal 档 202px,留 16px 余量。
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

