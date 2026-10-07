import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Download, Eye, FileText, ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import { startBrowserDownload } from '../../../../utils/browserDownload';
import { safeLocalStorage } from '../../utils/chatStorage';
import { isInsideProject } from '../../utils/outputPaths';
import {
  anchorScrollTop,
  buildProgressTimeline,
  DEFAULT_KEEP_RECENT,
  edgeFadeMask,
  edgeFadeState,
} from '../../utils/progressTimeline';
import type { TodoItem } from '../../utils/taskChecklist';
import { applyManualToggle, applyPreviewChange } from '../../utils/workPanelAutoCollapse';
import { foldEarlierOutputs, type SessionOutputFile } from '../../utils/sessionOutputs';

import FileTypeIcon from './FileTypeIcon';

interface ChatWorkPanelProps {
  /** 最新一份 TodoWrite 清单(taskChecklist.ts),没有则为 null。 */
  todos: TodoItem[] | null;
  /** 会话数到的最后一个用户回合(没动过清单的新回合不认锚点,见 findProgressAnchor);0 = 不知道。 */
  checklistTurn?: number;
  /** 本会话 Write 出的可交付文件(sessionOutputs.ts),时间正序。 */
  outputs: SessionOutputFile[];
  /** 服务端帧数触顶,更早的记录没载入;面板要如实提示,不能当成全部。 */
  historyTruncated?: boolean;
  /**
   * 右侧已经开了文件预览栏。为 true 时本面板自动折成窄边条,把宽度让给
   * 预览和正文;预览一关自动还原(仅还原"自动折的那次",不覆盖手动偏好)。
   */
  previewOpen?: boolean;
  isProcessing: boolean;
  /** 「下载」打项目文件内容接口用。 */
  projectId?: string | null;
  /** 判断产出是否落在项目目录内;在目录外的走会话产出通道。 */
  projectPath?: string | null;
  /** 会话产出通道用的会话 id。 */
  sessionId?: string | null;
  /** 「打开」走既有编辑器/预览面板。 */
  onFileOpen?: (filePath: string) => void;
}

const COLLAPSE_KEY = 'chat_work_panel_collapsed';

/**
 * 「进度」区整块收成只剩标题行(对齐 Cowork 的 Progress ›)。与上面那个
 * "整个面板收成窄边条"是两回事,各记各的。
 */
const PROGRESS_COLLAPSE_KEY = 'chat_work_panel_progress_collapsed';

/*
 * 进度时间轴:当前步是竖线上那颗点,当前步之前的已完成只留最近 DEFAULT_KEEP_RECENT 条,
 * 更早的收进顶上一行「N 个更早的步骤」;默认滚到当前步。判据全在 progressTimeline.ts。
 * 清单是会话级累计的,长会话能攒几十条,所以新的永远露着,只收起旧的。
 */

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
  checklistTurn = 0,
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

  const [progressCollapsed, setProgressCollapsed] = useState<boolean>(
    () => safeLocalStorage.getItem(PROGRESS_COLLAPSE_KEY) === '1',
  );
  /*
   * 「更早的步骤」点开过的是哪个会话。面板不随会话重挂(ChatInterface 整个复用),
   * 所以按会话记:换一个会话自然回到折起,不用 effect 去清。
   */
  const sessionKey = sessionId ?? '';
  const [earlierOpenFor, setEarlierOpenFor] = useState<string | null>(null);
  const showEarlier = earlierOpenFor === sessionKey;
  const [showEarlierOutputs, setShowEarlierOutputs] = useState(false);
  const idBase = useId();
  const progressRegionId = `${idBase}-progress`;
  const stepListId = `${idBase}-steps`;

  // 预览开着就让位。规则(以及为什么这么定)在 workPanelAutoCollapse.ts。
  const autoRef = useRef(false);
  useEffect(() => {
    setCollapsed((current) => {
      const next = applyPreviewChange({ collapsed: current, auto: autoRef.current }, previewOpen);
      autoRef.current = next.auto;
      return next.collapsed;
    });
  }, [previewOpen]);

  const todoList = useMemo(() => todos ?? [], [todos]);
  const timeline = useMemo(
    () => buildProgressTimeline(todoList, { showEarlier, keepRecent: DEFAULT_KEEP_RECENT, currentTurn: checklistTurn }),
    [todoList, showEarlier, checklistTurn],
  );
  const { done, total, allDone, focusIndex } = timeline;
  const hasChecklist = total > 0;
  const hasOutputs = outputs.length > 0;
  const listVisible = hasChecklist && !collapsed && !progressCollapsed;

  /*
   * 锚点身份:换会话、换了一条当前步、整张清单被换掉 —— 都算"锚点变了",要重新
   * 滚过去;追加任务、勾掉别的条目、展开历史都不算,不去抢用户的滚动条。
   * 全部完成时锚点为空,身份仍然有一个(停到尾巴上,「全部完成」可见)。
   */
  // 按"停靠行"认(没有锚点时 = 第一条没完成的),锚点在老任务与"没有"之间切换时不来回滚
  const anchorKey = hasChecklist
    ? `${sessionKey}\u0000${focusIndex}\u0000${focusIndex >= 0 ? todoList[focusIndex].content : ''}`
    : null;

  const listRef = useRef<HTMLDivElement | null>(null);
  const anchorKeyRef = useRef<string | null>(anchorKey);
  /** 已经替哪个容器元素、哪个锚点滚过。两样都没变就不再滚。 */
  const scrolledRef = useRef<{ el: HTMLElement | null; key: string | null }>({ el: null, key: null });

  /** 能往上滚 → 顶边渐隐;能往下滚 → 底边渐隐。直接写样式,不为滚动重渲染整块面板。 */
  const updateEdgeFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const mask = edgeFadeMask(edgeFadeState(el));
    for (const property of ['mask-image', '-webkit-mask-image']) {
      if (mask) el.style.setProperty(property, mask);
      else el.style.removeProperty(property);
    }
  }, []);

  /**
   * 滚到当前步:锚点贴近顶部,上方露出最近完成的两行(放得下的话)。
   * 用容器的 scrollTo,不用 scrollIntoView —— 后者会连带滚动整页/外层容器。
   */
  const scrollToAnchor = useCallback(() => {
    const el = listRef.current;
    const key = anchorKeyRef.current;
    if (!el || key === null) return;
    const last = scrolledRef.current;
    if (last.el === el && last.key === key) return;
    // 还没排版(<lg 时整块 display:none)量不出东西:先不记账,等 ResizeObserver 再叫。
    if (el.clientHeight === 0) return;
    scrolledRef.current = { el, key };

    const anchorRow = el.querySelector<HTMLElement>('[data-progress-focus]');
    let top = el.scrollHeight;
    if (anchorRow) {
      const box = el.getBoundingClientRect();
      const contentTop = (node: Element) => node.getBoundingClientRect().top - box.top + el.scrollTop;
      const aboveHeights: number[] = [];
      for (
        let sibling = anchorRow.previousElementSibling;
        sibling && aboveHeights.length < DEFAULT_KEEP_RECENT;
        sibling = sibling.previousElementSibling
      ) {
        aboveHeights.push(sibling.getBoundingClientRect().height);
      }
      top = anchorScrollTop({
        anchorTop: contentTop(anchorRow),
        aboveHeights,
        keepAbove: DEFAULT_KEEP_RECENT,
        snapToTopBelow: anchorRow.parentElement ? contentTop(anchorRow.parentElement) : 0,
      });
    }
    el.scrollTo({ top });
    updateEdgeFade();
  }, [updateEdgeFade]);

  useLayoutEffect(() => {
    anchorKeyRef.current = anchorKey;
    if (!listVisible) return;
    scrollToAnchor();
    updateEdgeFade();
  }, [anchorKey, listVisible, scrollToAnchor, updateEdgeFade]);

  // 容器高度变了(窗口缩放、产出区挤压)或内容变了(新任务、展开历史)→ 重算渐隐;
  // 先前因为没排版而没滚成的,这时补上。
  useEffect(() => {
    const el = listRef.current;
    if (!listVisible || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      scrollToAnchor();
      updateEdgeFade();
    });
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [listVisible, scrollToAnchor, updateEdgeFade]);

  // 产出表同样默认只露最近的,更早的收进一行摘要(见 sessionOutputs.ts)。
  const { visible: visibleOutputs, hidden: hiddenOutputs } = foldEarlierOutputs(
    outputs,
    showEarlierOutputs,
  );

  if (!hasChecklist && !hasOutputs) return null;

  const toggleProgressCollapsed = () => {
    const next = !progressCollapsed;
    setProgressCollapsed(next);
    safeLocalStorage.setItem(PROGRESS_COLLAPSE_KEY, next ? '1' : '0');
  };

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = applyManualToggle({ collapsed: current, auto: autoRef.current });
      // 用户一动手,自动折叠的标记就作废 —— 关预览时不许再覆盖他的选择。
      autoRef.current = next.auto;
      if (next.persist) safeLocalStorage.setItem(COLLAPSE_KEY, next.collapsed ? '1' : '0');
      return next.collapsed;
    });
  };

  /**
   * 下载:签一张票,然后让浏览器自己去下(导航,而不是 fetch → blob):文件不经过
   * 标签页内存,下载栏立刻出现、进度由浏览器显示,大文件也撑不崩标签页。
   *
   * 失败全部挡在签票那一步(权限、路径、文件不存在),那一步还在 fetch 语境里,
   * setNotice 照常弹得出来 —— 后面那步是浏览器导航,失败只会在下载栏里留一行。
   */
  const handleDownload = async (file: SessionOutputFile) => {
    const viaSession = !isInsideProject(file.path, projectPath) && Boolean(sessionId);
    if (!viaSession && !projectId) return;
    setBusyPath(file.path);
    setNotice(null);
    try {
      const response = viaSession || !projectId
        ? await api.issueSessionOutputDownloadTicket(String(sessionId), file.path)
        : await api.issueDownloadTicket(projectId, [file.path]);
      if (!response.ok) {
        throw new Error(t('workPanel.downloadFailed', { status: response.status, defaultValue: '下载失败(HTTP {{status}})' }));
      }
      const { url } = await response.json() as { url: string };
      startBrowserDownload(url);
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
      {/* 分区滚动:清单区封顶列高一半、列表内部自滚;产出区吃剩余高度、同样内部自滚,任务再多也不会把产出区顶出屏幕;标题行常驻不滚 */}
      <div className="flex max-h-[50%] flex-none flex-col">
        {/* 顶行:「进度 ⌄」(收起本区)+ 第几步 …… 收起整个面板 */}
        <div className="flex flex-none items-center justify-between gap-2 px-3.5 pb-1 pt-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={toggleProgressCollapsed}
              aria-expanded={!progressCollapsed}
              aria-controls={progressCollapsed ? undefined : progressRegionId}
              title={progressCollapsed
                ? t('workPanel.progressExpand', { defaultValue: '展开进度' })
                : t('workPanel.progressCollapse', { defaultValue: '收起进度' })}
              className="-ml-1 flex flex-none items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-semibold text-card-foreground transition-colors hover:bg-accent"
            >
              {t('workPanel.progress', { defaultValue: '进度' })}
              {progressCollapsed
                ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} aria-hidden />
                : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} aria-hidden />}
            </button>
            {hasChecklist && (timeline.stepNumber !== null ? (
              <span className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">
                {t('workPanel.stepOf', {
                  current: timeline.stepNumber,
                  total,
                  defaultValue: '第 {{current}} 步 / 共 {{total}} 步',
                })}
              </span>
            ) : (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {done}/{total}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={t('workPanel.collapse', { defaultValue: '收起工作面板' })}
            title={t('workPanel.collapse', { defaultValue: '收起工作面板' })}
            className="grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronsRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>

        {/* 任务清单 —— Cowork 的 Progress:一条竖线,当前步是线上那颗点;
            走过的灰字在上(更早的收进一行),没到的在下。列表内部自滚,两头渐隐。 */}
        {progressCollapsed ? null : hasChecklist ? (
          <div
            ref={listRef}
            id={progressRegionId}
            className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-2"
            data-work-scroll="checklist"
            onScroll={updateEdgeFade}
          >
            <div>
              {timeline.foldableCount > 0 && (
                <button
                  type="button"
                  onClick={() => setEarlierOpenFor(showEarlier ? null : sessionKey)}
                  aria-expanded={showEarlier}
                  aria-controls={stepListId}
                  className={cn(
                    'block w-full border-l-2 border-border py-1 pl-3 text-left text-[11.5px] leading-5 text-muted-foreground transition-colors hover:text-foreground',
                    // 收着的那几步在线上画成虚线 —— "这里还有,只是折起来了"。
                    !showEarlier && 'border-dashed',
                  )}
                >
                  {showEarlier
                    ? t('workPanel.earlierStepsHide', { defaultValue: '收起更早的步骤' })
                    : t('workPanel.earlierSteps', {
                      count: timeline.foldableCount,
                      defaultValue: '{{count}} 个更早的步骤',
                    })}
                </button>
              )}
              <ol id={stepListId} className="border-l-2 border-border pl-3">
                {timeline.rows.map(({ item, index, state, isAnchor, isFocus }) => (
                  <li
                    key={`${index}-${item.content}`}
                    aria-current={isAnchor ? 'step' : undefined}
                    data-progress-focus={isFocus ? '' : undefined}
                    className="relative py-1"
                  >
                    {/* 线上的点:进行中实心(跑着的时候呼吸),还没开工的当前步空心。
                        -17px = 竖线中心(2px 线的 1px 处)− 点半径 4 − 线宽 2 − 内边距 12。 */}
                    {(state === 'active' || isAnchor) && (
                      <span
                        aria-hidden
                        className={cn(
                          'absolute -left-[17px] top-2.5 h-2 w-2 rounded-full',
                          state === 'active'
                            ? 'bg-primary'
                            : 'border-[1.5px] border-primary bg-background',
                          // 只有当前步呼吸 —— 更早回合被停下、没人关掉的 in_progress 不跟着闪
                          state === 'active' && isAnchor && isProcessing && 'animate-pulse',
                        )}
                      />
                    )}
                    <span
                      className={cn(
                        'block break-words text-[12.5px] leading-5',
                        state === 'done' && 'text-muted-foreground',
                        (state === 'active' || isAnchor) && 'text-foreground',
                        state === 'pending' && !isAnchor && 'text-body',
                      )}
                    >
                      {state === 'active' ? (item.activeForm ?? item.content) : item.content}
                    </span>
                  </li>
                ))}
              </ol>
              {allDone && (
                <p className="py-1 pl-3.5 text-[11px] text-muted-foreground">
                  {t('workPanel.allDone', { defaultValue: '全部完成' })}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p id={progressRegionId} className="px-3.5 pb-2 text-[11.5px] text-muted-foreground">
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
                {/* 产出行右端常驻的是「预览」(日常动作);下载只在悬停 / 聚焦时出现 */}
                {(projectId || sessionId) && (
                  <button
                    type="button"
                    // 只禁用正在下载的这一个,其它文件照样能下。
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
        {/* 会话太长、服务端只下发了尾部的工作帧:如实提示一句,免得用户以为更早的文件丢了 */}
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
