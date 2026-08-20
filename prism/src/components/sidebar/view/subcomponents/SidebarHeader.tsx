import { Activity, Archive, Folder, FolderPlus, MessageSquare, RefreshCw, X } from 'lucide-react';
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
      <Input
        type="text"
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

        {/* 搜索与模式分段只在有东西可搜时出现 */}
        {showSearchTools && (
          <>
            <div className="px-3 pb-2">{searchInput(false)}</div>
            <div className="px-3 pb-2.5">{searchModeSegments}</div>
          </>
        )}

        {/* 新建项目 + 刷新:**永远可见**。一个项目都没有时恰恰是最需要"新建"的
            时候 —— 把它和搜索一起藏起来会让空状态变成死路。 */}
        <div className="flex items-center gap-1.5 px-3 pb-3">
          <button
            type="button"
            onClick={onCreateProject}
            className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border bg-transparent text-[13px] font-semibold leading-5 text-card-foreground transition-colors hover:border-border-strong active:translate-y-px"
          >
            {t('tooltips.createProject')}
          </button>
          <button
            type="button"
            className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-40"
            onClick={onRefresh}
            disabled={isRefreshing}
            title={t('tooltips.refresh')}
            aria-label={t('tooltips.refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'text-primary' : ''}`} strokeWidth={2} />
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
