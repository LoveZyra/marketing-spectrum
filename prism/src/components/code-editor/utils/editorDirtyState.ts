/**
 * 编辑器脏态登记 —— 跨组件的"有未保存改动"单例标志。
 *
 * 为什么不是 React 状态:知道脏态的是 CodeEditor(深处),要拦截关闭/换文件的
 * 是 useEditorSidebar(上层)。把 hasUnsavedChanges 一路 props 提升穿过
 * EditorSidebar / MainContent 会让一堆中间层为一个布尔值重渲;而这里的消费场景
 * 是**事件处理器里同步读一次**(点了另一个文件 / 点了关闭),不需要订阅重渲,
 * module 单例正合适。
 *
 * 同屏最多一个可编辑的 CodeEditor 实例(sidebar 与弹出互斥),所以单例够用;
 * 实例卸载时必须清零(CodeEditor 里的 effect cleanup 负责),否则残影会拦住
 * 下一次打开。
 */

let editorDirty = false;

/** CodeEditor 每次脏态变化时同步进来;卸载时置 false。 */
export function setEditorDirty(value: boolean): void {
  editorDirty = value;
}

/**
 * 关闭/替换编辑器前问一句。无脏态直接放行;有脏态弹原生 confirm,
 * 用户确认丢弃则顺手清零(接下来编辑器就要被卸载/重载了)。
 */
export function confirmDiscardEditorChanges(message: string): boolean {
  if (!editorDirty) return true;
  const discard = window.confirm(message);
  if (discard) editorDirty = false;
  return discard;
}
