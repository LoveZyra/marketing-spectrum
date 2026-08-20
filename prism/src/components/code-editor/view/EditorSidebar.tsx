import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import type { MouseEvent, MutableRefObject } from 'react';

import type { CodeEditorFile } from '../types/types';
import { PanelLoadingFallback } from '../../../shared/view/LazyPanel';

// CodeMirror and its six language modes are ~660 kB — the single largest thing
// in the bundle — and this component returns null until a file is actually
// opened. Deferring the import means users who never open the editor never pay
// for it. EditorSidebar itself stays eagerly imported because MainContent
// renders it unconditionally.
const CodeEditor = lazy(() => import('./CodeEditor'));

type EditorSidebarProps = {
  editingFile: CodeEditorFile | null;
  isMobile: boolean;
  editorExpanded: boolean;
  editorWidth: number;
  hasManualWidth: boolean;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onCloseEditor: () => void;
  onToggleEditorExpand: () => void;
  projectPath?: string;
  fillSpace?: boolean;
};

// Minimum width for the left content (file tree, chat, etc.)
const MIN_LEFT_CONTENT_WIDTH = 200;
// Minimum width for the editor sidebar
const MIN_EDITOR_WIDTH = 280;

export default function EditorSidebar({
  editingFile,
  isMobile,
  editorExpanded,
  editorWidth,
  hasManualWidth,
  resizeHandleRef,
  onResizeStart,
  onCloseEditor,
  onToggleEditorExpand,
  projectPath,
  fillSpace,
}: EditorSidebarProps) {
  const [poppedOut, setPoppedOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [effectiveWidth, setEffectiveWidth] = useState(editorWidth);

  // Adjust editor width when container size changes to ensure buttons are always visible
  useEffect(() => {
    if (!editingFile || isMobile || poppedOut) return;

    const updateWidth = () => {
      if (!containerRef.current) return;
      const parentElement = containerRef.current.parentElement;
      if (!parentElement) return;

      const containerWidth = parentElement.clientWidth;

      // Calculate maximum allowed editor width
      const maxEditorWidth = containerWidth - MIN_LEFT_CONTENT_WIDTH;

      if (maxEditorWidth < MIN_EDITOR_WIDTH) {
        // Not enough space - pop out the editor so user can still see everything
        setPoppedOut(true);
      } else if (editorWidth > maxEditorWidth) {
        // Editor is too wide - constrain it to ensure left content has space
        setEffectiveWidth(maxEditorWidth);
      } else {
        setEffectiveWidth(editorWidth);
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);

    // Also use ResizeObserver for more accurate detection
    const resizeObserver = new ResizeObserver(updateWidth);
    const parentEl = containerRef.current?.parentElement;
    if (parentEl) {
      resizeObserver.observe(parentEl);
    }

    return () => {
      window.removeEventListener('resize', updateWidth);
      resizeObserver.disconnect();
    };
  }, [editingFile, isMobile, poppedOut, editorWidth]);

  if (!editingFile) {
    return null;
  }

  if (isMobile || poppedOut) {
    return (
      <Suspense fallback={<PanelLoadingFallback />}>
        <CodeEditor
          file={editingFile}
          onClose={() => {
            setPoppedOut(false);
            onCloseEditor();
          }}
          projectPath={projectPath}
          isSidebar={false}
        />
      </Suspense>
    );
  }

  // In files tab, fill the remaining width unless user has dragged manually.
  const useFlexLayout = editorExpanded || (fillSpace && !hasManualWidth);

  return (
    <div ref={containerRef} className={`flex h-full min-w-0 ${editorExpanded ? 'flex-1' : ''}`}>
      {!editorExpanded && (
        <div
          ref={resizeHandleRef}
          onMouseDown={onResizeStart}
          className="group relative w-px flex-shrink-0 cursor-col-resize bg-border transition-colors hover:bg-border-strong"
          title="Drag to resize"
        >
          {/* 命中区比可见的 1px 发丝线宽,但发丝线本身不做加宽动画 */}
          <div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2" />
        </div>
      )}

      <div
        // 固定宽度分支的最小宽度交给下面的 inline style —— 之前这里的动态
        // 任意值类名被 tailwind 排序器拆坏过(min-w-[ flex-shrink-0…px]),
        // 类名里不再放模板变量。
        className={`h-full overflow-hidden border-l border-border ${useFlexLayout ? 'min-w-0 flex-1' : 'flex-shrink-0'}`}
        style={useFlexLayout ? undefined : { width: `${effectiveWidth}px`, minWidth: `${MIN_EDITOR_WIDTH}px` }}
      >
        <Suspense fallback={<PanelLoadingFallback />}>
          <CodeEditor
            file={editingFile}
            onClose={onCloseEditor}
            projectPath={projectPath}
            isSidebar
            isExpanded={editorExpanded}
            onToggleExpand={onToggleEditorExpand}
            onPopOut={() => setPoppedOut(true)}
          />
        </Suspense>
      </div>
    </div>
  );
}
