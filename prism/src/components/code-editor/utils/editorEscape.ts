/**
 * 编辑器里按 Esc 该做什么。
 *
 * 最大化(侧栏预览占满整个主内容区)时,人对 Esc 的直觉是"先退出最大化",而不是
 * "整个预览连同标签一起没了"—— 否则一次误触就把正在看的东西全关掉。所以:
 *
 *   - 侧栏形态 + 已最大化 + 有还原开关 → 还原(第二次 Esc 才关);
 *   - 其它一切(弹出的浮层、没最大化、没开关) → 关闭。
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
