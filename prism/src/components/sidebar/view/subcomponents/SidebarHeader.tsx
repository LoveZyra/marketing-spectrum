import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Archive, ChevronDown, Folder, FolderPlus, MessageSquare, Plus, RefreshCw, X, type LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Input, Tooltip } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { usePaletteOps } from '../../../../contexts/PaletteOpsContext';
import type { SidebarSearchMode } from '../../types/types';
import PrismLogo from '../../../PrismLogo';
import PrismWordmark from '../../../PrismWordmark';


const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  t: TFunction;
};

/** 搜索模式分段按钮的选中态:8% 绿底 + 绿描边;浅色下文字用墨色保对比度。 */
const SEGMENT_BASE_CLASS =
  'flex items-center justify-center gap-1.5 rounded-md py-[5px] text-xs leading-4 transition-colors';
/** 选中:32% 绿描边 + 8% 绿底;淡色下文字用墨色(浅底不做绿小字),深色下用绿。 */
const SEGMENT_ACTIVE_CLASS =
  'border border-primary/[0.32] bg-primary/[0.08] text-card-foreground dark:text-primary';
const SEGMENT_IDLE_CLASS =
  'border border-border text-muted-foreground hover:text-foreground';

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  t,
}: SidebarHeaderProps) {
  const paletteOps = usePaletteOps();
  const showSearchTools = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : t('projects.searchPlaceholder');
  const runningBadgeText = runningSessionsCount > 99 ? '99+' : String(runningSessionsCount);

  /**
   * ef:桌面端的模式切换收进搜索框左侧的小下拉,四个分段按钮撤掉(移动端仍用分段)。
   * 四种模式 + 各自的计数;当前模式显示在搜索框里,占位符随模式变。
   */
  const modes: Array<{ id: SidebarSearchMode; icon: LucideIcon; label: string; count?: number }> = [
    { id: 'projects', icon: Folder, label: t('search.modeProjects'), count: projectsCount },
    { id: 'conversations', icon: MessageSquare, label: t('search.modeConversations') },
    { id: 'running', icon: Activity, label: t('search.modeRunning', { defaultValue: '运行中' }), count: runningSessionsCount },
    { id: 'archived', icon: Archive, label: t('search.modeArchived', { defaultValue: '归档' }), count: archivedSessionsCount },
  ];
  const activeMode = modes.find((mode) => mode.id === searchMode) ?? modes[0];
  /**
   * eh:模式菜单 **portal 到 body**,不再是搜索框里的 absolute 浮层。
   *
   * 侧栏的项目行是定位元素,和这个 z-50 的浮层在同一个层叠上下文里较劲 ——
   * 线上表现为菜单打开后项目名穿透压在菜单上(用户截图)。这类"浮层被同层内容
   * 盖住 / 被滚动容器裁掉"的问题在这套界面里只有一个可靠解:portal 出去 + fixed
   * 定位到触发器,和「+」菜单、导出菜单、顶栏「…」用的是同一套做法。
   */
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modeMenuAnchor, setModeMenuAnchor] = useState<{ left: number; top: number } | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null);

  const openModeMenu = () => {
    const box = modeTriggerRef.current?.getBoundingClientRect();
    if (!box) return;
    const width = 176;
    setModeMenuAnchor({
      left: Math.max(8, Math.min(box.left, window.innerWidth - 8 - width)),
      top: box.bottom + 4,
    });
    setModeMenuOpen(true);
  };

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (modeMenuRef.current?.contains(target) || modeTriggerRef.current?.contains(target)) return;
      setModeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModeMenuOpen(false);
    };
    // 侧栏本身会滚:跟着滚就飘,所以滚动一律关掉(与其它浮层同一约定)。
    const onScroll = () => setModeMenuOpen(false);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [modeMenuOpen]);

  const searchWithMode = (
    <div
      data-sidebar-search
      className="relative flex h-8 items-center rounded-md border border-input bg-card transition-colors focus-within:border-primary hover:border-border-strong focus-within:hover:border-primary"
    >
      <div ref={modeMenuRef} className="relative flex h-full flex-none">
        <button
          ref={modeTriggerRef}
          type="button"
          data-sidebar-search-mode
          onClick={() => (modeMenuOpen ? setModeMenuOpen(false) : openModeMenu())}
          aria-haspopup="menu"
          aria-expanded={modeMenuOpen}
          aria-label={t('search.switchMode', { defaultValue: '切换搜索范围' })}
          title={t('search.switchMode', { defaultValue: '切换搜索范围' })}
          className="flex h-full items-center gap-1 rounded-l-md border-r border-border pl-2.5 pr-2 text-xs text-body transition-colors hover:bg-muted hover:text-foreground"
        >
          <activeMode.icon className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{activeMode.label}</span>
          {searchMode === 'running' && runningSessionsCount > 0 && (
            <span className="font-mono text-[10.5px] leading-none text-muted-foreground">{runningBadgeText}</span>
          )}
          <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', modeMenuOpen && 'rotate-180')} />
        </button>
        {modeMenuOpen && modeMenuAnchor && createPortal(
          <div
            ref={modeMenuRef}
            role="menu"
            data-sidebar-search-mode-menu
            style={{ left: modeMenuAnchor.left, top: modeMenuAnchor.top }}
            className="prism-modal-shadow fixed z-[101] w-44 rounded-panel border border-border bg-popover p-1"
          >
            {modes.map((mode) => {
              const isActive = mode.id === searchMode;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    onSearchModeChange(mode.id);
                    setModeMenuOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                    isActive ? 'bg-accent text-accent-foreground' : 'text-body hover:bg-muted hover:text-foreground',
                  )}
                >
                  <mode.icon className="h-3.5 w-3.5 flex-none" />
                  <span className="flex-1">{mode.label}</span>
                  {typeof mode.count === 'number' && mode.count > 0 && (
                    <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{mode.count > 99 ? '99+' : mode.count}</span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
      </div>
      <Input
        type="text"
        name="sidebar-filter"
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        placeholder={searchPlaceholder}
        value={searchFilter}
        onChange={(event) => onSearchFilterChange(event.target.value)}
        className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-2 pr-12 text-[13px] hover:border-transparent focus-visible:border-transparent"
      />
      {searchFilter ? (
        <button
          onClick={onClearSearchFilter}
          aria-label={t('tooltips.clearSearch')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => paletteOps.openPalette()}
          title={t('tooltips.openCommandPalette')}
          aria-label={t('tooltips.openCommandPalette')}
          className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
        >
          {MOD_KEY}
          <span>K</span>
        </button>
      )}
    </div>
  );

  const sectionCount = typeof activeMode.count === 'number' && searchMode !== 'projects'
    ? activeMode.count
    : projectsCount;

  const searchModeSegments = (
    <div className="flex gap-1.5">
      <button
        onClick={() => onSearchModeChange('projects')}
        aria-pressed={searchMode === 'projects'}
        className={cn(SEGMENT_BASE_CLASS, 'flex-1', searchMode === 'projects' ? SEGMENT_ACTIVE_CLASS : SEGMENT_IDLE_CLASS)}
      >
        <Folder className="h-3 w-3" />
        {t('search.modeProjects')}
      </button>
      <button
        onClick={() => onSearchModeChange('conversations')}
        aria-pressed={searchMode === 'conversations'}
        className={cn(SEGMENT_BASE_CLASS, 'flex-1', searchMode === 'conversations' ? SEGMENT_ACTIVE_CLASS : SEGMENT_IDLE_CLASS)}
      >
        <MessageSquare className="h-3 w-3" />
        {t('search.modeConversations')}
      </button>
      {/* 「运行中」原来是三个汉字挤在 1/3 宽的格子里,把前两个带图标的分段也压瘦了。
          改成和归档同一档的图标按钮:有在跑的会话时才挂一个等宽计数。 */}
      <Tooltip content={t('search.runningTooltip', 'Running sessions')} position="top">
        <button
          onClick={() => onSearchModeChange('running')}
          aria-pressed={searchMode === 'running'}
          aria-label={t('search.runningTooltip', 'Running sessions')}
          title={t('search.runningTooltip', 'Running sessions')}
          className={cn(
            SEGMENT_BASE_CLASS,
            'min-w-9 flex-none gap-1 px-1.5',
            searchMode === 'running' ? SEGMENT_ACTIVE_CLASS : SEGMENT_IDLE_CLASS,
          )}
        >
          <Activity className="h-3 w-3" />
          {runningSessionsCount > 0 && (
            <span className="font-mono text-[11px] leading-none">{runningBadgeText}</span>
          )}
        </button>
      </Tooltip>
      <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top">
        <button
          onClick={() => onSearchModeChange('archived')}
          aria-pressed={searchMode === 'archived'}
          aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
          title={t('search.archiveOnlyTooltip', 'Archive only')}
          className={cn(SEGMENT_BASE_CLASS, 'w-9 flex-none', searchMode === 'archived' ? SEGMENT_ACTIVE_CLASS : SEGMENT_IDLE_CLASS)}
        >
          <Archive className="h-3 w-3" />
        </button>
      </Tooltip>
    </div>
  );

  const searchInput = (isMobileVariant: boolean) => (
    <div className="relative">
      {/* ec:这是页面上第一个文本框,浏览器密码管理器给"没有 form 的密码框"配用户名时
          就会盯上它(见 AccountSettingsTab)。根治在密码表单那边;这里再关掉自动填充、
          起一个不像用户名的 name,并挂上主流密码管理器认的忽略标记,双保险。 */}
      <Input
        type="text"
        name="sidebar-filter"
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        placeholder={searchPlaceholder}
        value={searchFilter}
        onChange={(event) => onSearchFilterChange(event.target.value)}
        className={cn(
          'rounded-md border border-input bg-card px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-0 focus-visible:ring-offset-0',
          isMobileVariant ? 'h-11 pr-9' : 'h-[38px] pr-14',
        )}
      />
      {searchFilter ? (
        <button
          onClick={onClearSearchFilter}
          aria-label={t('tooltips.clearSearch')}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className={cn('text-muted-foreground', isMobileVariant ? 'h-3.5 w-3.5' : 'h-3 w-3')} />
        </button>
      ) : !isMobileVariant ? (
        // 键帽本来只是提示,点不动 —— 命令面板只有 ⌘K 一个入口。现在它是个真按钮,
        // 外观一字不改(设计稿里搜索框右侧就是这枚等宽键帽)。
        <button
          type="button"
          onClick={() => paletteOps.openPalette()}
          title={t('tooltips.openCommandPalette')}
          aria-label={t('tooltips.openCommandPalette')}
          className="absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground md:inline-flex"
        >
          {MOD_KEY}
          <span>K</span>
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex-shrink-0">
      {/* Desktop header — 标记在图标轨上,这里只留字标。
          开合入口只此一个,在图标轨上(见 AppRail);侧栏顶部不再重复放一个。 */}
      <div className="hidden md:block">
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-[13px]">
          <h1 className="flex min-w-0 items-center text-foreground" title={t('app.title')}>
            <PrismWordmark height={19} />
          </h1>
        </div>

        {/* 搜索(内嵌模式下拉)只在有东西可搜时出现 */}
        {showSearchTools && (
          <div className="px-3 pb-1">{searchWithMode}</div>
        )}

        {/* ef:列表标题行 —— 「项目 · N」+ 右侧描边「+」(创建新项目)与刷新。
            墨黑实心大按钮撤掉:主区只留一个实心主按钮(发送),侧栏 CTA 降为描边。
            新建 + 刷新**永远可见**:一个项目都没有时恰恰最需要"新建"。 */}
        <div className="flex items-center gap-1 px-3 pb-1 pt-2">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[11px] font-semibold tracking-[0.4px] text-muted-foreground">
            <span className="truncate">{activeMode.label}</span>
            {sectionCount > 0 && (
              <span className="font-mono text-[11px] font-normal tabular-nums">{sectionCount > 99 ? '99+' : sectionCount}</span>
            )}
          </span>
          <button
            type="button"
            data-sidebar-create-project
            onClick={onCreateProject}
            title={t('tooltips.createProject')}
            aria-label={t('tooltips.createProject')}
            className="grid h-6 w-6 flex-none place-items-center rounded-md border border-border bg-card text-body transition-colors hover:border-border-strong hover:text-foreground active:translate-y-px"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={onRefresh}
            disabled={isRefreshing}
            title={t('tooltips.refresh')}
            aria-label={t('tooltips.refresh')}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'text-primary' : ''}`} />
          </button>
        </div>
      </div>

      {/* Mobile header — 无图标轨,标记保留 */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <PrismLogo size={42} />
            <h1 className="flex min-w-0 items-center text-foreground" title={t('app.title')}>
              <PrismWordmark height={21} />
            </h1>
          </div>

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md bg-muted active:translate-y-px"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'text-primary' : 'text-muted-foreground'}`} strokeWidth={2} />
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground active:translate-y-px"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile search */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {searchModeSegments}
            {searchInput(true)}
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="h-px bg-border md:hidden" />
    </div>
  );
}
