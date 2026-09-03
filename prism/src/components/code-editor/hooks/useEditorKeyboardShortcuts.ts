import { useEffect } from 'react';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  /**
   * ec:Esc 的去处。不传就是 onClose(老行为);最大化时调用方传"还原",
   * 让第一次 Esc 只退出最大化、第二次才关编辑器(见 utils/editorEscape.ts)。
   */
  onEscape?: () => void;
  dependency: string;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  onEscape,
  dependency,
}: UseEditorKeyboardShortcutsParams) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 已被别人消费的 Esc 不抢:CodeMirror 关搜索面板、命令面板/弹窗关自己,
        // 处理后都会 preventDefault —— 这个监听挂在 document 冒泡端,最后才轮到,
        // 不看这个标志就会"关个搜索面板顺手把整个编辑器带走"。
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        (onEscape ?? onClose)();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dependency, onClose, onEscape, onSave]);
};
