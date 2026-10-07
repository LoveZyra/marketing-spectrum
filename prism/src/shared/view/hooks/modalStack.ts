/**
 * 自建弹层的模块级栈。
 *
 * 每个 `useModalKeyboard` 都在 document 的捕获阶段挂 keydown。弹层套弹层时(新建项目向导里
 * 再开「选择文件夹」),两层都收到同一次 Esc:内层的 stopPropagation 挡不住同一个节点上
 * 的另一个监听,一按 Esc 整个向导会一起关掉。所以谁在栈顶谁处理,其余一律不动。
 */
const stack: symbol[] = [];

export function pushModal(): symbol {
  const id = Symbol('modal');
  stack.push(id);
  return id;
}

export function removeModal(id: symbol): void {
  const index = stack.lastIndexOf(id);
  if (index >= 0) stack.splice(index, 1);
}

export function isTopModal(id: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** 测试用。 */
export function resetModalStack(): void {
  stack.length = 0;
}

/**
 * 这次 Esc 该不该留给目标元素自己:行内输入框(改名、重置密码、额度编辑、新建文件夹名)
 * 的 Esc 是「取消这次输入」,不是「关掉整个弹窗」。标记用 `data-esc-local`(沿用
 * `data-inline-rename` 那一批)。
 */
export function isLocalEscapeTarget(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== 'function') return false;
  return Boolean(element.closest('[data-esc-local], [data-inline-rename]'));
}
