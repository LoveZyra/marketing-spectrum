import { type ReactNode } from 'react';
import { Activity, Archive, Folder, MessageSquare, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';
import type { ArchivedProjectListItem, ArchivedSessionListItem, SidebarSearchMode } from '../../types/types';
import ClaudeLogo from '../../../llm-logo-provider/ClaudeLogo';
import { getAllSessions } from '../../utils/utils';

import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-transparent px-0 font-semibold text-foreground dark:text-primary">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

type ArchivedSessionGroup = {
  key: string;
  projectId: string | null;
  projectDisplayName: string;
  projectPath: string | null;
  isProjectArchived: boolean;
  sessions: ArchivedSessionListItem[];
  latestActivity: string | null;
};

/**
 * Groups archived sessions by project metadata so the archive view preserves
 * the same mental model as the active sidebar: projects first, then sessions.
 */
function groupArchivedSessionsByProject(sessions: ArchivedSessionListItem[]): ArchivedSessionGroup[] {
  const groups = new Map<string, ArchivedSessionGroup>();

  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      if (!existingGroup.latestActivity || (session.lastActivity && session.lastActivity > existingGroup.latestActivity)) {
        existingGroup.latestActivity = session.lastActivity;
      }
      continue;
    }

    groups.set(key, {
      key,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      projectPath: session.projectPath,
      isProjectArchived: session.isProjectArchived,
      sessions: [session],
      latestActivity: session.lastActivity,
    });
  }

  return [...groups.values()].sort((groupA, groupB) => {
    const a = groupA.latestActivity ?? '';
    const b = groupB.latestActivity ?? '';
    return b.localeCompare(a);
  });
}

function formatCompactArchivedAge(dateString: string | null): string {
  if (!dateString) {
    return '';
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, Date.now() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  return `${Math.floor(diffInHours / 24)}d`;
}

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projects: Project[];
  runningSessionsCount: number;
  archivedProjects: ArchivedProjectListItem[];
  archivedSessions: ArchivedSessionListItem[];
  archivedSessionsCount: number;
  /** E10:服务端分页后的归档会话总数 —— 与本地已加载条数不同才有得说。 */
  archivedSessionsTotal: number;
  archivedSessionsHasMore: boolean;
  isLoadingMoreArchivedSessions: boolean;
  onLoadMoreArchivedSessions: () => void;
  /** F8:回收站批量操作。选中集合由控制器持有(跨渲染保持)。 */
  selectedArchivedIds: ReadonlySet<string>;
  onToggleArchivedSelection: (sessionId: string) => void;
  onClearArchivedSelection: () => void;
  onBulkArchivedAction: (action: 'restore' | 'delete') => void;
  onEmptyArchive: () => void;
  isBulkArchiving: boolean;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  onRestoreArchivedProject: (projectId: string) => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
  // Conversation result clicks pass back the DB projectId (or null when the
  // server couldn't resolve it). Consumers must handle the null case.
  onConversationResultClick: (projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onShowSettings: () => void;
  notificationCount?: number;
  projectListProps: SidebarProjectListProps;
  t: TFunction;
};

export default function SidebarContent({
  isPWA,
  isMobile,
  isLoading,
  projects,
  runningSessionsCount,
  archivedProjects,
  archivedSessions,
  archivedSessionsCount,
  archivedSessionsTotal,
  archivedSessionsHasMore,
  isLoadingMoreArchivedSessions,
  onLoadMoreArchivedSessions,
  selectedArchivedIds,
  onToggleArchivedSelection,
  onClearArchivedSelection,
  onBulkArchivedAction,
  onEmptyArchive,
  isBulkArchiving,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  conversationResults,
  isSearching,
  searchProgress,
  onRestoreArchivedProject,
  onArchivedSessionClick,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onConversationResultClick,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onShowSettings,
  notificationCount,
  projectListProps,
  t,
}: SidebarContentProps) {
  const showConversationSearch = searchMode === 'conversations' && searchFilter.trim().length >= 2;
  const hasPartialResults = conversationResults && conversationResults.results.length > 0;
  const groupedArchivedSessions = groupArchivedSessionsByProject(archivedSessions);

  return (
    <div
      className="flex h-full flex-col bg-background md:w-[248px] md:select-none"
      style={{}}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        isLoading={isLoading}
        projectsCount={projects.length}
        runningSessionsCount={runningSessionsCount}
        archivedSessionsCount={archivedSessionsCount}
        isArchivedSessionsLoading={isArchivedSessionsLoading}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateProject={onCreateProject}
        t={t}
      />

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
        {showConversationSearch ? (
          isSearching && !hasPartialResults ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 flex-none rounded-full border-[1.5px] border-primary" aria-hidden />
              </div>
              <p className="text-sm text-muted-foreground">{t('search.searching')}</p>
              {searchProgress && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('search.projectsScanned', { count: searchProgress.scannedProjects })}/{searchProgress.totalProjects}
                </p>
              )}
            </div>
          ) : !isSearching && conversationResults && conversationResults.results.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('search.noResults')}</h3>
              <p className="text-sm text-muted-foreground">{t('search.tryDifferentQuery')}</p>
            </div>
          ) : hasPartialResults ? (
            <div className="space-y-3 px-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground">
                  {t('search.matches', { count: conversationResults.totalMatches })}
                </p>
                {isSearching && searchProgress && (
                  <div className="flex items-center gap-1.5">
                    <div className="h-3 w-3 flex-none rounded-full border-[1.5px] border-primary" aria-hidden />
                    <p className="text-[10px] text-muted-foreground">
                      {searchProgress.scannedProjects}/{searchProgress.totalProjects}
                    </p>
                  </div>
                )}
              </div>
              {isSearching && searchProgress && (
                <div className="mx-1 h-0.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-colors duration-300"
                    style={{ width: `${Math.round((searchProgress.scannedProjects / searchProgress.totalProjects) * 100)}%` }}
                  />
                </div>
              )}
              {conversationResults.results.map((projectResult) => (
                <div key={projectResult.projectName} className="space-y-1">
                  <div className="flex items-center gap-1.5 px-1 py-1">
                    <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-normal text-foreground">
                      {projectResult.projectDisplayName}
                    </span>
                  </div>
                  {projectResult.sessions.map((session) => (
                    <button
                      key={`${projectResult.projectId ?? projectResult.projectName}-${session.sessionId}`}
                      className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
                      onClick={() => onConversationResultClick(
                        // Pass the DB projectId (preferred) so the parent can
                        // cross-reference with the loaded projects list.
                        projectResult.projectId,
                        session.sessionId,
                        session.provider || session.matches[0]?.provider || 'claude',
                        session.matches[0]?.timestamp,
                        session.matches[0]?.snippet
                      )}
                    >
                      <div className="mb-1 flex items-center gap-1.5">
                        <MessageSquare className="h-3 w-3 flex-shrink-0 text-primary" />
                        <span className="truncate text-xs font-normal text-foreground">
                          {session.sessionSummary}
                        </span>
                        {session.provider && session.provider !== 'claude' && (
                          <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                            {session.provider}
                          </span>
                        )}
                      </div>
                      <div className="space-y-1 pl-4">
                        {session.matches.map((match, idx) => (
                          <div key={idx} className="flex items-start gap-1">
                            <span className="mt-0.5 flex-shrink-0 text-[10px] font-normal uppercase text-muted-foreground">
                              {match.role === 'user' ? 'U' : 'A'}
                            </span>
                            <HighlightedSnippet
                              snippet={match.snippet}
                              highlights={match.highlights}
                            />
                          </div>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null
        ) : searchMode === 'running' ? (
          projectListProps.filteredProjects.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted md:mb-3">
                <Activity className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {t('running.emptyTitle', 'No sessions running')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {runningSessionsCount > 0
                  ? t('running.noMatchingSessions', 'No running sessions match this search.')
                  : t('running.emptyDescription', 'Active work will appear here while a provider is processing.')}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="mx-2 flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/[0.08] text-foreground dark:text-primary">
                    <Activity className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate text-xs font-normal text-foreground">
                    {t('running.title', 'Running now')}
                  </span>
                </div>
                <span className="rounded-full border border-primary/[0.32] px-2 py-0.5 font-mono text-[11px] font-normal text-foreground dark:text-primary">
                  {runningSessionsCount}
                </span>
              </div>
              <SidebarProjectList {...projectListProps} />
            </div>
          )
        ) : searchMode === 'archived' ? (
          isArchivedSessionsLoading ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 flex-none rounded-full border-[1.5px] border-primary" aria-hidden />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {t('archived.loadingTitle', 'Loading archive...')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('archived.loadingDescription', 'Fetching hidden workspaces and sessions you can restore later.')}
              </p>
            </div>
          ) : archivedProjects.length === 0 && groupedArchivedSessions.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Archive className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {archivedSessionsCount > 0
                  ? t('archived.noMatchingSessions', 'No matching archived items')
                  : t('archived.emptyTitle', 'No archived items')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {archivedSessionsCount > 0
                  ? t('archived.tryDifferentSearch', 'Try a different search term.')
                  : t('archived.emptyDescription', 'Archived workspaces and sessions will appear here when you hide them from the active list.')}
              </p>
            </div>
          ) : (
            <div className="space-y-3 px-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <p className="text-xs text-muted-foreground">
                  {`${archivedSessionsCount} ${t(
                    archivedSessionsCount === 1 ? 'archived.sessionCountOne' : 'archived.sessionCountOther',
                    archivedSessionsCount === 1 ? 'archived item' : 'archived items',
                  )}`}
                </p>
                {/* F8:清空回收站。放在这里而不是每行旁边 —— 它是"一次性清账"的
                    动作,和逐条删除是两种意图。确认交给调用方(不可逆)。 */}
                <button
                  type="button"
                  onClick={onEmptyArchive}
                  disabled={isBulkArchiving || archivedSessionsCount === 0}
                  className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  {t('archived.emptyTrash', '清空回收站')}
                </button>
              </div>

              {selectedArchivedIds.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {t('archived.selectedCount', { count: selectedArchivedIds.size, defaultValue: `已选 ${selectedArchivedIds.size} 条` })}
                  </span>
                  <button
                    type="button"
                    onClick={() => onBulkArchivedAction('restore')}
                    disabled={isBulkArchiving}
                    className="rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    {t('archived.bulkRestore', '批量恢复')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onBulkArchivedAction('delete')}
                    disabled={isBulkArchiving}
                    className="rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    {t('archived.bulkDelete', '批量永久删除')}
                  </button>
                  <button
                    type="button"
                    onClick={onClearArchivedSelection}
                    className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {t('archived.clearSelection', '取消选择')}
                  </button>
                </div>
              )}
              {archivedProjects.map((project) => {
                const projectSessions = getAllSessions(project);

                return (
                  <div key={project.projectId} className="overflow-hidden rounded-lg border border-border">
                    <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm font-normal text-foreground">
                            {project.displayName}
                          </span>
                          <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                            {t('archived.projectArchived', 'Project archived')}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground" title={project.fullPath}>
                          {project.fullPath}
                        </p>
                      </div>
                      <button
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-primary/[0.08] text-foreground transition-colors hover:bg-primary/[0.16] dark:text-primary"
                        onClick={() => onRestoreArchivedProject(project.projectId)}
                        title={t('archived.restoreProject', 'Restore workspace')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {projectSessions.length > 0 && (
                      <div className="divide-y divide-border">
                        {projectSessions.map((session) => (
                          <button
                            key={String(session.id)}
                            className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent"
                            onClick={() => onArchivedSessionClick({
                              sessionId: String(session.id),
                              provider: session.__provider,
                              projectId: project.projectId,
                              projectPath: project.fullPath,
                              projectDisplayName: project.displayName,
                              sessionTitle:
                                (typeof session.summary === 'string' && session.summary.trim().length > 0
                                  ? session.summary
                                  : typeof session.name === 'string' && session.name.trim().length > 0
                                    ? session.name
                                    : String(session.id)),
                              createdAt: typeof session.created_at === 'string' ? session.created_at : null,
                              updatedAt: typeof session.updated_at === 'string' ? session.updated_at : null,
                              lastActivity:
                                typeof session.lastActivity === 'string'
                                  ? session.lastActivity
                                  : typeof session.updated_at === 'string'
                                    ? session.updated_at
                                    : typeof session.created_at === 'string'
                                      ? session.created_at
                                      : null,
                              isProjectArchived: true,
                            })}
                          >
                            <ClaudeLogo className="h-3.5 w-3.5 flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-normal text-foreground">
                                  {(typeof session.summary === 'string' && session.summary.trim().length > 0
                                    ? session.summary
                                    : typeof session.name === 'string' && session.name.trim().length > 0
                                      ? session.name
                                      : String(session.id))}
                                </span>
                                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                                  {formatCompactArchivedAge(
                                    typeof session.lastActivity === 'string'
                                      ? session.lastActivity
                                      : typeof session.updated_at === 'string'
                                        ? session.updated_at
                                        : typeof session.created_at === 'string'
                                          ? session.created_at
                                          : null,
                                  )}
                                </span>
                              </div>
                              <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                                {session.__provider}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {groupedArchivedSessions.map((group) => (
                <div key={group.key} className="overflow-hidden rounded-lg border border-border">
                  <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-normal text-foreground">
                          {group.projectDisplayName}
                        </span>
                        {group.isProjectArchived && (
                          <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                            {t('archived.projectArchived', 'Project archived')}
                          </span>
                        )}
                      </div>
                      {group.projectPath && (
                        <p className="mt-1 truncate text-xs text-muted-foreground" title={group.projectPath}>
                          {group.projectPath}
                        </p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[11px] text-muted-foreground">
                      {group.sessions.length}
                    </span>
                  </div>
                  <div className="divide-y divide-border">
                    {group.sessions.map((session) => (
                      <div key={session.sessionId} className="flex items-center gap-2 px-3 py-2.5">
                        {/* F8:多选。回收站里攒到几百条时,一条条点纯粹是体力活。 */}
                        <input
                          type="checkbox"
                          checked={selectedArchivedIds.has(session.sessionId)}
                          onChange={() => onToggleArchivedSelection(session.sessionId)}
                          aria-label={t('archived.select', '选中')}
                          className="h-3.5 w-3.5 flex-shrink-0"
                        />
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
                          onClick={() => onArchivedSessionClick(session)}
                        >
                          <ClaudeLogo className="h-3.5 w-3.5 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-xs font-normal text-foreground">
                                {session.sessionTitle}
                              </span>
                              {session.lastActivity && (
                                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                                  {formatCompactArchivedAge(session.lastActivity)}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                              {session.provider}
                            </p>
                          </div>
                        </button>
                        <button
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-primary/[0.08] text-foreground transition-colors hover:bg-primary/[0.16] dark:text-primary"
                          onClick={() => onRestoreArchivedSession(session.sessionId)}
                          title={t('archived.restore', 'Restore session')}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() => onDeleteArchivedSession(session)}
                          title={t('archived.deletePermanently', 'Delete permanently')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/*
                E10:归档会话改成服务端分页。少列出来的那些必须**说出来**并且给得出
                下一页 —— 静默截断会让人以为会话丢了。
              */}
              {archivedSessionsHasMore && (
                <button
                  type="button"
                  className="w-full rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
                  onClick={onLoadMoreArchivedSessions}
                  disabled={isLoadingMoreArchivedSessions}
                >
                  {isLoadingMoreArchivedSessions
                    ? t('archived.loadingMore', '正在加载…')
                    : t('archived.loadMore', {
                      defaultValue: '加载更多(共 {{total}} 条)',
                      total: archivedSessionsTotal,
                    })}
                </button>
              )}
            </div>
          )
        ) : (
          <SidebarProjectList {...projectListProps} />
        )}
      </ScrollArea>

      <SidebarFooter
        onShowSettings={onShowSettings}
        notificationCount={notificationCount}
        t={t}
      />
    </div>
  );
}
