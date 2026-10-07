/**
 * 编辑器保存成功后通知文件树刷新。
 *
 * 编辑器(EditorSidebar)与文件树(FileTree)是 MainContent 下的两个兄弟,中间没有共同的
 * 状态容器;为了一次"保存后把这一行的大小 / 时间刷新"把回调从 MainContent 一路穿到
 * useCodeEditorDocument 要动四五层 props。与 toastBus 同一思路:模块级的极简事件总线,
 * 树挂着时订阅,卸载时退订;没有人订阅时发事件是空操作。
 */

type FileSavedListener = (filePath: string) => void;

const listeners = new Set<FileSavedListener>();

export function subscribeFileSaved(listener: FileSavedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitFileSaved(filePath: string): void {
  for (const listener of listeners) {
    try {
      listener(filePath);
    } catch (error) {
      console.error('[fileTreeEvents] listener failed:', error);
    }
  }
}

/** 测试用:清空订阅者。 */
export function resetFileSavedListeners(): void {
  listeners.clear();
}
