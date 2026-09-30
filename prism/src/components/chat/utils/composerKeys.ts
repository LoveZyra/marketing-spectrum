/**
 * hl(09-24 静态 P2-30 / P3 键盘可访问性):聊天输入框的两条按键判据。
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
 * 输入法组合中。
 *
 * 只看 `isComposing` 不够:Safari 在中文输入法按回车**确认候选**的那一下,keydown 里
 * `isComposing` 已经是 false(compositionend 先于 keydown 派发),唯一的痕迹是 `keyCode === 229`。
 * 不认这个,Safari 用户每确认一次候选词就把半句话发出去了。
 */
export function isImeComposing(event: KeyLike): boolean {
  const native = event.nativeEvent ?? event;
  return Boolean(native.isComposing) || native.keyCode === 229 || event.keyCode === 229;
}

/**
 * 是否拿这次按键去切换执行模式。
 *
 * 原来**Tab 与 Shift+Tab 都**被输入框吞掉切模式 —— 键盘用户进了输入框就再也 Tab 不出去
 * (WCAG 2.1.2 键盘陷阱)。现在只认 Shift+Tab(与 Claude Code CLI 的快捷键一致),
 * 普通 Tab 交还给浏览器做焦点移动。
 */
export function shouldCyclePermissionMode(event: KeyLike): boolean {
  return event.key === 'Tab'
    && Boolean(event.shiftKey)
    && !event.ctrlKey && !event.metaKey && !event.altKey;
}
