import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Download, Eye, FileText, ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import { api, authenticatedFetch } from '../../../../utils/api';
import { safeLocalStorage } from '../../utils/chatStorage';
import { isInsideProject } from '../../utils/outputPaths';
import { todoProgress, type TodoItem } from '../../utils/taskChecklist';
import { applyManualToggle, applyPreviewChange } from '../../utils/workPanelAutoCollapse';
import { foldEarlierOutputs, type SessionOutputFile } from '../../utils/sessionOutputs';

import FileTypeIcon from './FileTypeIcon';

interface ChatWorkPanelProps {
  /** 最新一份 TodoWrite 清单(taskChecklist.ts),没有则为 null。 */
  todos: TodoItem[] | null;
  /** 本会话 Write 出的可交付文件(sessionOutputs.ts),时间正序。 */
  outputs: SessionOutputFile[];
  /** dw:服务端帧数触顶 —— 更早的记录没载入,面板照实说,不装作这就是全部。 */
  historyTruncated?: boolean;
  /**
   * dy:右侧已经开了文件预览栏。为 true 时本面板自动折成窄边条,把宽度让给
   * 预览和正文;预览一关自动还原(仅还原"自动折的那次",不覆盖手动偏好)。
   */
  previewOpen?: boolean;
  isProcessing: boolean;
  /** 「下载」打项目文件内容接口用。 */
  projectId?: string | null;
  /** ei:判断产出是否落在项目目录内 —— 在外面的走会话产出通道。 */
  projectPath?: string | null;
  /** ei:会话产出通道的会话 id。 */
  sessionId?: string | null;
  /** 「打开」走既有编辑器/预览面板。 */
  onFileOpen?: (filePath: string) => void;
}

const COLLAPSE_KEY = 'chat_work_panel_collapsed';

/**
 * dw:已完成条目超过这个数就折起来。
 *
 * 清单是会话级累计的:一个会话跑几十个回合,历史轮次的已完成任务全堆在这
 * 一列里,越用越长,新立的任务被顶到看不见的地方 —— 这是"无限叠加"最直接
 * 的观感来源。折叠只改**呈现**:一条也不丢,点开就在,而默认看到的是
 * "还没干完的事"。阈值取 6:短清单(一轮就几条)照旧全展开,观感不变。
 */
const DONE_FOLD_THRESHOLD = 6;

/**
 * 对话右侧工作面板(do)—— 对齐 Cowork 的 Progress / Outputs 右栏。
 *
 * 上半:任务清单(agent 的 TodoWrite 聚合,最后一份即当前状态,回合结束后
 * 它在显示日志里,刷新照样恢复);下半:产出文件(消息流里 Write 出的可交付
 * 文件,跨回合累计,「打开」进预览、「下载」拿文件本体)。
 *
 * 两块都空 → 整个面板不渲染,老会话观感不变;窄屏(<lg)让位给正文。
 * 收着的时候留一条窄边征,数字徽标提示里面有货。
 */
function ChatWorkPanel({
  todos,
  outputs,
  historyTruncated = false,
  previewOpen = false,
  isProcessing,
  projectId,
  projectPath,
  sessionId,
  onFileOpen,
}: ChatWorkPanelProps) {
  const { t } = useTranslation('chat');
  const [collapsed, setCollapsed] = useState<boolean>(
    () => safeLocalStorage.getItem(COLLAPSE_KEY) === '1',
  );
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [showDone, setShowDone] = useState(false);
  const [showEarlierOutputs, setShowEarlierOutputs] = useState(false);

  // dy:预览开着就让位。规则(以及为什么这么定)在 workPanelAutoCollapse.ts。
  const autoRef = useRef(false);
  useEffect(() => {
    setCollapsed((current) => {
      const next = applyPreviewChange({ collapsed: current, auto: autoRef.current }, previewOpen);
      autoRef.current = next.auto;
      return next.collapsed;
    });
  }, [previewOpen]);

  const todoList = useMemo(() => todos ?? [], [todos]);
  const { done, total, allDone } = todoProgress(todoList);
  const hasChecklist = total > 0;
  const hasOutputs = outputs.length > 0;
  const foldable = done > DONE_FOLD_THRESHOLD;
  const doneHidden = foldable && !showDone;
  // 折起来时只留未完成的;顺序不动(建立顺序),展开即原样恢复。
  const visibleTodos = useMemo(
    () => (doneHidden ? todoList.filter((todo) => todo.status !== 'completed') : todoList),
    [doneHidden, todoList],
  );

  // dx:产出表同样默认只露最近的,更早的收进一行摘要(见 sessionOutputs.ts)。
  const { visible: visibleOutputs, hidden: hiddenOutputs } = foldEarlierOutputs(
    outputs,
    showEarlierOutputs,
  );

  if (!hasChecklist && !hasOutputs) return null;

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = applyManualToggle({ collapsed: current, auto: autoRef.current });
      // 用户一动手,自动折叠的标记就作废 —— 关预览时不许再覆盖他的选择。
      autoRef.current = next.auto;
      if (next.persist) safeLocalStorage.setItem(COLLAPSE_KEY, next.collapsed ? '1' : '0');
      return next.collapsed;
    });
  };

  const handleDownload = async (file: SessionOutputFile) => {
    const viaSession = !isInsideProject(file.path, projectPath) && Boolean(sessionId);
    if (!viaSession && !projectId) return;
    setBusyPath(file.path);
    setNotice(null);
    try {
      const response = viaSession || !projectId
        ? await api.sessionOutputBlob(String(sessionId), file.path)
        : await authenticatedFetch(
          `/api/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(file.path)}`,
        );
      if (!response.ok) throw new Error(`下载失败(HTTP ${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // 释放放到下一拍 —— 有些浏览器在 click 返回时还没开始读这个 URL。
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPath(null);
    }
  };

  if (collapsed) {
    return (
      // data-work-panel:给 EditorSidebar 量宽度用(见那边的 measureLeftFloor)。
      <div data-work-panel className="hidden w-10 flex-none flex-col items-center gap-3 border-l border-border bg-background py-2.5 lg:flex">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={t('workPanel.expand', { defaultValue: '展开工作面板' })}
          title={t('workPanel.expand', { defaultValue: '展开工作面板' })}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronsLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
        {hasChecklist && (
          <div
            className="flex flex-col items-center gap-0.5 text-muted-foreground"
            title={`${t('workPanel.checklist', { defaultValue: '任务清单' })} ${done}/${total}`}
          >
            <ListChecks className="h-4 w-4" strokeWidth={2} aria-hidden />
            <span className="font-mono text-[10px] tabular-nums">{done}/{total}</span>
          </div>
        )}
        {hasOutputs && (
          <div
            className="flex flex-col items-center gap-0.5 text-muted-foreground"
            title={`${t('workPanel.outputs', { defaultValue: '产出文件' })} ${outputs.length}`}
          >
            <FileText className="h-4 w-4" strokeWidth={2} aria-hidden />
            <span className="font-mono text-[10px] tabular-nums">{outputs.length}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      data-work-panel
      className="hidden w-[300px] flex-none flex-col overflow-hidden border-l border-border bg-background lg:flex xl:w-[320px]"
      aria-label={t('workPanel.title', { defaultValue: '工作面板' })}
    >
      {/* ds:分区滚动(对齐 Cowork 右栏)。清单区块整体**封顶列高一半**、
          列表内部自滚;产出区吃剩余高度、同样内部自滚 —— 此前是 aside 整条
          滚,20 条任务直接把产出区顶出屏幕外。标题行各自常驻不滚。 */}
      <div className="flex max-h-[50%] flex-none flex-col">
        {/* 顶行:标题 + 收起 */}
        <div className="flex flex-none items-center justify-between px-3.5 pb-1 pt-2.5">
          <span className="text-xs font-semibold text-card-foreground">
            {t('workPanel.progress', { defaultValue: '进度' })}
            {hasChecklist && (
              <span className="ml-1.5 font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                {done}/{total}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={t('workPanel.collapse', { defaultValue: '收起工作面板' })}
            title={t('workPanel.collapse', { defaultValue: '收起工作面板' })}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronsRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>

        {/* 任务清单 —— Cowork 的 Progress:完成划线,进行中亮点 */}
        {hasChecklist ? (
          <ul className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-2" data-work-scroll="checklist">
            {foldable && (
              <li className="py-1">
                <button
                  type="button"
                  onClick={() => setShowDone((current) => !current)}
                  className="flex w-full items-center gap-1 rounded-md py-0.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {doneHidden
                    ? <ChevronRight className="h-3 w-3 flex-none" strokeWidth={2} aria-hidden />
                    : <ChevronDown className="h-3 w-3 flex-none" strokeWidth={2} aria-hidden />}
                  <span className="min-w-0 truncate">
                    {doneHidden
                      ? t('workPanel.doneFolded', { count: done, defaultValue: '已完成 {{count}} 项 · 展开' })
                      : t('workPanel.doneUnfold', { count: done, defaultValue: '收起已完成的 {{count}} 项' })}
                  </span>
                </button>
              </li>
            )}
            {visibleTodos.map((todo, index) => (
            <li key={`${index}-${todo.content}`} className="flex items-start gap-2 py-1">
              <span className="flex h-5 w-4 flex-none items-center justify-center" aria-hidden>
                {todo.status === 'completed' ? (
                  <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} />
                ) : todo.status === 'in_progress' ? (
                  <span className={cn('h-2 w-2 rounded-full bg-primary', isProcessing && 'animate-pulse')} />
                ) : (
                  <span className="h-2 w-2 rounded-full border border-border-strong" />
                )}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 text-[12.5px] leading-5',
                  todo.status === 'completed' && 'text-muted-foreground line-through decoration-border-strong',
                  todo.status === 'in_progress' && 'text-foreground',
                  todo.status === 'pending' && 'text-body',
                )}
              >
                {todo.status === 'in_progress' ? (todo.activeForm ?? todo.content) : todo.content}
              </span>
            </li>
          ))}
            {allDone && !doneHidden && (
              <li className="py-1 text-[11px] text-muted-foreground">
                {t('workPanel.allDone', { defaultValue: '全部完成' })}
              </li>
            )}
          </ul>
        ) : (
          <p className="px-3.5 pb-2 text-[11.5px] text-muted-foreground">
            {t('workPanel.noChecklist', { defaultValue: '本会话还没有任务清单。' })}
          </p>
        )}
      </div>

      {/* 产出文件 —— Cowork 的 Outputs:点名字预览,右侧直接下载。
          区块吃剩余高度(清单短时它更高),列表内部自滚。 */}
      <div className="mt-1 flex min-h-0 flex-1 flex-col border-t border-border pb-3 pt-2">
        <div className="flex-none px-3.5 pb-1 text-xs font-semibold text-card-foreground">
          {t('workPanel.outputsShort', { defaultValue: '产出' })}
          <span className="ml-1.5 font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
            {outputs.length}
          </span>
        </div>
        {hasOutputs ? (
          <ul className="min-h-0 flex-1 overflow-y-auto px-3.5" data-work-scroll="outputs">
            {hiddenOutputs > 0 && (
              <li className="py-0.5">
                <button
                  type="button"
                  onClick={() => setShowEarlierOutputs((current) => !current)}
                  className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showEarlierOutputs
                    ? <ChevronDown className="h-3 w-3 flex-none" strokeWidth={2} aria-hidden />
                    : <ChevronRight className="h-3 w-3 flex-none" strokeWidth={2} aria-hidden />}
                  <span className="min-w-0 truncate">
                    {showEarlierOutputs
                      ? t('workPanel.earlierUnfold', { count: hiddenOutputs, defaultValue: '收起更早的 {{count}} 个' })
                      : t('workPanel.earlierFolded', { count: hiddenOutputs, defaultValue: '更早的 {{count}} 个 · 展开' })}
                  </span>
                </button>
              </li>
            )}
            {visibleOutputs.map((file) => (
              <li key={file.path} className="group/output flex items-center gap-1.5 py-0.5">
                {onFileOpen ? (
                  <button
                    type="button"
                    onClick={() => onFileOpen(file.path)}
                    className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-accent"
                    title={`${file.path} · ${t('workPanel.open', { defaultValue: '打开' })}`}
                  >
                    <FileTypeIcon path={file.path} />
                    <span className="min-w-0 truncate font-mono text-[12px] text-body">{file.name}</span>
                  </button>
                ) : (
                  <span className="flex h-[30px] min-w-0 flex-1 items-center gap-2 px-2" title={file.path}>
                    <FileTypeIcon path={file.path} />
                    <span className="min-w-0 truncate font-mono text-[12px] text-body">{file.name}</span>
                  </span>
                )}
                {/* ef:设计稿里产出行右端是「预览」那只眼睛 —— 这是日常动作;
                    下载退到悬停时才出现,少一个常驻图标,行也就干净了。 */}
                {(projectId || sessionId) && (
                  <button
                    type="button"
                    // dt:只禁正在下载的这一个 —— 一个在下全体变灰没道理。
                    disabled={busyPath === file.path}
                    onClick={() => void handleDownload(file)}
                    aria-label={t('workPanel.download', { defaultValue: '下载此文件' })}
                    title={t('workPanel.download', { defaultValue: '下载此文件' })}
                    className={cn(
                      'grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/output:opacity-100 disabled:cursor-not-allowed disabled:opacity-50',
                      busyPath === file.path && 'animate-pulse opacity-100',
                    )}
                  >
                    <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  </button>
                )}
                {onFileOpen && (
                  <button
                    type="button"
                    onClick={() => onFileOpen(file.path)}
                    aria-label={t('workPanel.open', { defaultValue: '打开' })}
                    title={t('workPanel.open', { defaultValue: '打开' })}
                    className="grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Eye className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3.5 text-[11.5px] text-muted-foreground">
            {t('workPanel.noOutputs', { defaultValue: '本会话还没有产出文件。' })}
          </p>
        )}
        {/* dw:会话太长、服务端只下发了尾部的工作帧 —— 照实说一句,别让
            用户以为几天前那个文件被吞了。 */}
        {historyTruncated && (
          <p className="flex-none px-3.5 pt-1 text-[11px] text-muted-foreground">
            {t('workPanel.historyTruncated', { defaultValue: '会话较长,更早的记录未载入。' })}
          </p>
        )}
        {notice && <p className="flex-none px-3.5 pt-1 text-[11px] text-destructive">⚠️ {notice}</p>}
      </div>
    </aside>
  );
}

export default memo(ChatWorkPanel);
