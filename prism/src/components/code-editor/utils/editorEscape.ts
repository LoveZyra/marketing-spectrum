/**
 * ec:编辑器里按 Esc 该做什么。
 *
 * 最大化(侧栏预览占满整个主内容区)之前,Esc 只有一个含义:关掉编辑器。有了
 * 最大化之后,人对 Esc 的直觉是"先退出最大化",而不是"整个预览连同标签一起
 * 没了"—— 那会让一次误触把正在看的东西全关掉。所以:
 *
 *   - 侧栏形态 + 已最大化 + 有还原开关 → 还原(第二次 Esc 才关);
 *   - 其它一切(弹出的浮层、没最大化、没开关) → 关闭,与以前一样。
 *
 * 纯函数,单测钉住;hook 只负责把它接到 keydown 上。
 */
export type EditorEscapeAction = 'restore' | 'close';

export function resolveEditorEscapeAction(state: {
  isSidebar: boolean;
  isExpanded: boolean;
  hasToggleExpand: boolean;
}): EditorEscapeAction {
  if (state.isSidebar && state.isExpanded && state.hasToggleExpand) return 'restore';
  return 'close';
}
