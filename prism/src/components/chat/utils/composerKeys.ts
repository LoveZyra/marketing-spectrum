/**
 * 聊天输入框的两条按键判据:输入法组合中、切换执行模式。
 */

type KeyLike = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** React 的 nativeEvent 或原生 KeyboardEvent。 */
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
  keyCode?: number;
};

/**
 * 是否处于输入法组合中。
 *
 * 只看 `isComposing` 不够:Safari 在中文输入法按回车确认候选时,keydown 里 `isComposing`
 * 已是 false(compositionend 先于 keydown 派发),唯一的痕迹是 `keyCode === 229`;
 * 不认这个,每确认一次候选词就会把半句话发出去。
 */
export function isImeComposing(event: KeyLike): boolean {
  const native = event.nativeEvent ?? event;
  return Boolean(native.isComposing) || native.keyCode === 229 || event.keyCode === 229;
}

/**
 * 这次按键是否用于切换执行模式。
 *
 * 只认 Shift+Tab(与 Claude Code CLI 的快捷键一致);普通 Tab 交还浏览器做焦点移动,
 * 否则键盘用户进了输入框就 Tab 不出去(WCAG 2.1.2 键盘陷阱)。
 */
export function shouldCyclePermissionMode(event: KeyLike): boolean {
  return event.key === 'Tab'
    && Boolean(event.shiftKey)
    && !event.ctrlKey && !event.metaKey && !event.altKey;
}
