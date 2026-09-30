/**
 * hl(动态 P2-21):向上弹出的浮层菜单的横向位置。
 *
 * 原来直接用触发按钮的 `rect.left` —— 手机上「执行模式」按钮靠右,w-72(288px)的菜单
 * 从那里往右展开,右半截被视口裁掉,最后几个模式根本点不到。
 * 夹到 `[margin, 视口宽 - 菜单宽 - margin]`;视口比菜单还窄时贴左边距。
 */
export function clampMenuLeft(
  anchorLeft: number,
  menuWidth: number,
  viewportWidth: number,
  margin = 8,
): number {
  const maxLeft = viewportWidth - menuWidth - margin;
  return Math.max(margin, Math.min(anchorLeft, maxLeft));
}
