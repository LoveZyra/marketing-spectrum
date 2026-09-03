import { lazy, Suspense, useState, useEffect, useRef } from 'react';
import type { MouseEvent, MutableRefObject } from 'react';

import type { CodeEditorFile } from '../types/types';
import { PanelLoadingFallback } from '../../../shared/view/LazyPanel';

import EditorTabs from './EditorTabs';

// CodeMirror and its six language modes are ~660 kB — the single largest thing
// in the bundle — and this component returns null until a file is actually
// opened. Deferring the import means users who never open the editor never pay
// for it. EditorSidebar itself stays eagerly imported because MainContent
// renders it unconditionally.
const CodeEditor = lazy(() => import('./CodeEditor'));

type EditorSidebarProps = {
  editingFile: CodeEditorFile | null;
  /** F10:同时开着的文件(标签条)。少于两个时不画标签条。 */
  openFiles?: CodeEditorFile[];
  onSelectFile?: (path: string) => void;
  onCloseFile?: (path: string) => void;
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

/**
 * dy:左侧要留出来的**正文**最小宽度。
 *
 * 原来这个常量叫 MIN_LEFT_CONTENT_WIDTH,值 200,含义是"左边整栏至少留这么
 * 多" —— 在工作面板出现之前它是对的。现在左栏装的是「聊天正文 + 工作面板」
 * 两块,而工作面板是 flex-none 的 300(xl:320)px:预览栏按 `容器宽 - 200`
 * 去占,剩下的 200 全被工作面板吃掉,**聊天正文被压成 0**,连工作面板自己
 * 都被父级的 overflow-hidden 从左边裁掉(用户截图:产出文件名少了首字母、
 * 面板的收起按钮整个不见了)。
 *
 * 所以这里只代表"正文"的下限,工作面板的宽度**实测**后再加上去(见
 * measureLeftFloor)—— 面板折起来时它只有 40px,预览就能宽一些;面板展开
 * 时预算自动跟着涨。写死一个数是这个 bug 的根源,不能再写死第二次。
 *
 * ⚠️ 这个 280 与 ChatInterface 正文栏的 `min-w-[280px]` 是**同一个数**,
 * 必须一起改:CSS 那边是硬约束(小于它就溢出被裁),这边是发宽度时的预算。
 * 两边不一致 = 要么编辑器超发把左栏挤裂,要么白白少给编辑器一截。
 */
const MIN_CHAT_BODY_WIDTH = 280;
// Minimum width for the editor sidebar
const MIN_EDITOR_WIDTH = 280;

/**
 * 左栏此刻真正需要的最小宽度 = 正文下限 + 工作面板的**实际**宽度。
 *
 * 面板有三种形态:展开(300/320)、折起(40)、整个不渲染(没有清单也没有
 * 产出,或窄屏 <lg 时 display:none)。三种都靠量,不靠猜。
 */
function measureLeftFloor(leftElement: Element | null): number {
  if (!leftElement) return MIN_CHAT_BODY_WIDTH;
  const panel = leftElement.querySelector('[data-work-panel]');
  const panelWidth = panel ? panel.getBoundingClientRect().width : 0;
  return MIN_CHAT_BODY_WIDTH + panelWidth;
}

export default function EditorSidebar({
  editingFile,
  openFiles,
  onSelectFile,
  onCloseFile,
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

  // 编辑器真正关掉(editingFile 清空)时才收回弹出态。以前是在 onClose 里
  // 先 setPoppedOut(false) 再调 onCloseEditor —— 现在关闭可能被"未保存改动"
  // 确认框拒绝,顺序反了会把编辑器从弹出弹回侧栏(重挂载,恰好丢掉刚保住的
  // 改动)。状态跟着事实走:关没关成,看 editingFile。
  useEffect(() => {
    if (!editingFile) {
      setPoppedOut(false);
    }
  }, [editingFile]);

  // Adjust editor width when container size changes to ensure buttons are always visible
  useEffect(() => {
    if (!editingFile || isMobile || poppedOut) return;
    // ec:最大化时预览栏就是整个内容区,左栏已 display:none —— 不存在"给左栏留
    // 位置"的问题,更不能因为窗口窄就把它弹成浮层(那会让"最大化"变成另一种形态)。
    // 还原的那一刻这个 effect 会因依赖变化重跑,窄窗口该弹出照样弹出。
    if (editorExpanded) return;

    const updateWidth = () => {
      if (!containerRef.current) return;
      const parentElement = containerRef.current.parentElement;
      if (!parentElement) return;

      const containerWidth = parentElement.clientWidth;

      // 左栏此刻真正的下限 = 正文下限 + 工作面板实测宽(折起来时只有 40)。
      const maxEditorWidth = containerWidth - measureLeftFloor(parentElement.firstElementChild);

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
  }, [editingFile, isMobile, poppedOut, editorWidth, editorExpanded]);

  if (!editingFile) {
    return null;
  }

  const tabs = openFiles && onSelectFile && onCloseFile ? (
    <EditorTabs
      files={openFiles}
      activePath={editingFile.path}
      onSelect={onSelectFile}
      onClose={onCloseFile}
    />
  ) : null;

  if (isMobile || poppedOut) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {tabs}
        <div className="min-h-0 flex-1">
          <Suspense fallback={<PanelLoadingFallback />}>
            <CodeEditor
              file={editingFile}
              onClose={onCloseEditor}
              projectPath={projectPath}
              isSidebar={false}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  // In files tab, fill the remaining width unless user has dragged manually.
  const useFlexLayout = editorExpanded || (fillSpace && !hasManualWidth);

  return (
    <div
      ref={containerRef}
      data-editor-sidebar
      data-maximized={editorExpanded ? 'true' : undefined}
      className={`flex h-full min-w-0 ${editorExpanded ? 'flex-1' : ''}`}
    >
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
        <div className="flex h-full min-h-0 flex-col">
          {tabs}
          <div className="min-h-0 flex-1">
            <Suspense fallback={<PanelLoadingFallback />}>
              <CodeEditor
                // key 带上路径:换标签必须换一个 CodeEditor 实例,否则
                // CodeMirror 会把上一份文档的撤销历史带过来。
                key={editingFile.path}
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
      </div>
    </div>
  );
}
