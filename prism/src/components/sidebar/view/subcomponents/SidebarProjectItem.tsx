import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Edit3, Folder, Globe, Lock, Share2, ShieldCheck, Star, Trash2, UserCheck, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { useAuth } from '../../../auth/context/AuthContext';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { SessionWithProvider } from '../../types/types';
import { planVisibilityMarks, type VisibilityMarkKey } from '../../utils/visibilityMarks';

import ProjectPermissionsModal from './ProjectPermissionsModal';
import SidebarProjectSessions from './SidebarProjectSessions';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  awaitingApprovalSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  /** 权限保存成功后刷新项目列表,让徽标(公共/已共享·N)立即跟上。 */
  onProjectsRefresh?: () => void;
  t: TFunction;
};

const getSessionCountDisplay = (project: Project, sessions: SessionWithProvider[]): string => {
  const total = Number(project.sessionMeta?.total ?? sessions.length);
  return String(total);
};

type VisibilityBadgeProps = {
  isPublic: boolean;
  isRootOnly: boolean;
  isSharedToViewer: boolean;
  sharedOutCount: number;
  t: TFunction;
};

/**
 * 项目可见性标记 —— **只给图标,不给文字**。
 *
 * 原来是四个带边框的文字胶囊(公共 / 仅 root / 共享 / 已共享·N)。侧栏内宽只有
 * ~236px,一个「已共享·4」就要吃掉 56px,项目名被迫先截断 —— 而项目名才是这一行
 * 真正要读的东西。换成 14px 图标之后,同样的信息占 ~18px。
 *
 * 含义不靠猜:每个图标都挂 `title` + `aria-label`,悬停出全句解释,读屏器也念得出。
 * 「已共享」后面那个数字是共享人数,保留 —— 那是个量,不是个状态。
 *
 * 四个状态的分工:
 * - 公共(Globe):无主且在公共目录下,对所有人可见
 * - 仅 root(Lock):无主但没在公共目录下,只有 root 收得到
 * - 他人共享给你(UserCheck)
 * - 你共享出去了(Share2)+ 人数
 */
function ProjectVisibilityBadges({
  isPublic,
  isRootOnly,
  isSharedToViewer,
  sharedOutCount,
  t,
}: VisibilityBadgeProps) {
  /**
   * 画哪几个图标由 `planVisibilityMarks` 定 —— 那条"共享出去就不再画锁"的规则
   * 在那里,连同它的用例。这里只负责把 key 翻成图标和提示语。
   */
  const keys = planVisibilityMarks({ isPublic, isRootOnly, isSharedToViewer, sharedOutCount });
  if (keys.length === 0) return null;

  const MARK_ICON: Record<VisibilityMarkKey, typeof Globe> = {
    public: Globe,
    rootOnly: Lock,
    shared: UserCheck,
    sharedOut: Share2,
  };

  const labelFor = (key: VisibilityMarkKey): string => {
    switch (key) {
      case 'public':
        return t('project.publicHint', { defaultValue: '公共项目 —— 无主且在公共目录下,所有人可见' });
      case 'rootOnly':
        return t('project.rootOnlyHint', { defaultValue: '仅 root 可见 —— 无主且不在公共目录下' });
      case 'shared':
        return t('project.sharedHint', { defaultValue: '他人共享给你的项目' });
      case 'sharedOut':
      default:
        // 无主项目额外说明"除这几个人之外仍只有 root 看得见" —— 上面那把锁省掉了,
        // 它承载的信息挪到这里,不能一起丢掉。
        return isRootOnly
          ? t('project.sharedOutRootOnlyHint', {
              count: sharedOutCount,
              defaultValue: '已共享给 {{count}} 人 —— 此外仅 root 可见',
            })
          : t('project.sharedOutHint', { count: sharedOutCount, defaultValue: '已共享给 {{count}} 人' });
    }
  };

  return (
    <span className="flex flex-none items-center gap-1.5 text-muted-foreground">
      {keys.map((key) => {
        const Icon = MARK_ICON[key];
        const label = labelFor(key);
        return (
          <span key={key} className="flex items-center gap-0.5" role="img" aria-label={label} title={label}>
            <Icon className="h-3.5 w-3.5" strokeWidth={2} />
            {key === 'sharedOut' && (
              <span className="font-mono text-[10px] leading-none">{sharedOutCount}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  editingProject,
  editingName,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  activeSessions,
  attentionSessionIds,
  awaitingApprovalSessionIds,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectsRefresh,
  t,
}: SidebarProjectItemProps) {
  const { user } = useAuth();
  const [showPermissions, setShowPermissions] = useState(false);
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const isEditing = editingProject === project.projectId;
  const totalSessionCount = Number(project.sessionMeta?.total ?? sessions.length);
  const sessionCountDisplay = getSessionCountDisplay(project, sessions);
  const sessionCountLabel = `${sessionCountDisplay} session${totalSessionCount === 1 ? '' : 's'}`;

  // "公共" 只在项目真正对所有人可见时才打(无主且落在 PRISM_PUBLIC_WORKSPACE 下,
  // 由后端 isPublic 判定)。以前拿 ownerUserId===null 当"公共"是错的 —— 没配公共目录
  // 时,无主项目其实只有 root 看得到,不该标"公共"。
  const isPublicProject = project.isPublic === true;
  // 无主但不在公共目录:只有 root 收得到这类项目(非 root 根本不会出现在列表里)。
  // 给它一个"仅 root"标,让管理员一眼看出这些是未认领、仅自己可见的目录。
  const isRootOnlyUnclaimed = !isPublicProject && project.ownerUserId === null;
  // 被「指定用户」授权给当前用户的项目 —— 打"共享"标,说明它是别人开放给你的。
  const isSharedToViewer = project.sharedWithViewer === true;
  // 反向视角:owner 和 root 不是接收方,靠授权人数看出"这个项目共享过"。
  const sharedOutCount = !isSharedToViewer ? (project.sharedUserCount ?? 0) : 0;
  // 权限管理入口:root 或项目 owner 才显示。这只是入口显隐 —— 服务端对
  // GET/PUT /permissions 有同样的校验(非 owner/root 一律 403),边界在后端。
  const canManagePermissions =
    user?.isRoot === true ||
    (project.ownerUserId != null &&
      user?.id != null &&
      String(project.ownerUserId) === String(user.id));

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  return (
    <div className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none')}>
      <div className="md:group group">
        <div className="md:hidden">
          <div
            className={cn(
              'p-3 mx-3 my-1 rounded-md border border-border active:translate-y-px',
              isSelected && 'bg-muted',
              isStarred &&
                !isSelected &&
                'border-border',
            )}
            onClick={toggleProject}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                  className={cn(
                    'w-8 h-8 rounded-md flex items-center justify-center active:translate-y-px border',
                    isStarred
                      ? 'border-border bg-muted'
                      : 'border-border bg-muted',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleStarProject();
                  }}
                  title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                >
                  <Star
                    className={cn(
                      'w-4 h-4 transition-colors',
                      isStarred
                        ? 'fill-primary text-primary'
                        : 'text-body',
                    )}
                  />
                </button>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(event) => onEditingNameChange(event.target.value)}
                      className="w-full rounded-md border border-primary/40 bg-background px-3 py-2 text-sm text-foreground transition-colors focus:border-primary focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center justify-between">
                        <h3 className="truncate text-[13px] font-semibold text-foreground">{project.displayName}</h3>
                        <ProjectVisibilityBadges
                          isPublic={isPublicProject}
                          isRootOnly={isRootOnlyUnclaimed}
                          isSharedToViewer={isSharedToViewer}
                          sharedOutCount={sharedOutCount}
                          t={t}
                        />
                      </div>
                      <p className="truncate font-mono text-[10.5px] text-muted-foreground">{sessionCountLabel}</p>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-md bg-primary active:translate-y-px"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-4 w-4 text-primary-foreground" />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-md bg-muted active:translate-y-px"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-4 w-4 text-foreground" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-border active:translate-y-px"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteProject(project);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </button>

                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-md border border-border active:translate-y-px"
                      onClick={(event) => {
                        event.stopPropagation();
                        onStartEditingProject(project);
                      }}
                    >
                      <Edit3 className="h-4 w-4 text-primary" />
                    </button>

                    {canManagePermissions && (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-border active:translate-y-px"
                        onClick={(event) => {
                          event.stopPropagation();
                          setShowPermissions(true);
                        }}
                        title={t('tooltips.managePermissions', { defaultValue: '项目权限' })}
                      >
                        <ShieldCheck className="h-4 w-4 text-primary" />
                      </button>
                    )}

                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted">
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          className={cn(
            'relative hidden md:flex w-full justify-between rounded-md px-2.5 py-2 h-auto font-normal hover:bg-muted',
            isSelected && 'prism-panel bg-card dark:bg-muted',
          )}
          onClick={selectAndToggleProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* ef:设计稿的项目行是「箭头 → 文件夹 → 名字 …… 会话数」。
                箭头原来在行尾,和右侧的会话数、悬停动作挤在一起;放到最左边之后
                展开状态一眼可见,层级也和下面缩进的会话行对得上。 */}
            {isExpanded
              ? <ChevronDown className="h-3 w-3 flex-none text-muted-foreground" strokeWidth={2} />
              : <ChevronRight className="h-3 w-3 flex-none text-muted-foreground" strokeWidth={2} />}
            <Folder
              className={cn('h-3.5 w-3.5 flex-shrink-0', isSelected || isExpanded ? 'filetype-dir' : 'text-muted-foreground')}
              strokeWidth={2}
            />
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={editingName}
                    onChange={(event) => onEditingNameChange(event.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        onCancelEditingProject();
                      }
                    }}
                  />
                  <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>
                    {project.fullPath}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-1.5">
                    <div className={cn('truncate text-[13px] font-semibold', isSelected ? 'text-card-foreground' : 'text-body')} title={project.displayName}>
                      {project.displayName}
                    </div>
                    {/* 徽标含义:公共 = 无主且在公共目录下,对所有人可见;
                        仅 root = 无主但没在公共目录下,只有 root 收得到。
                        有主项目不打标 —— root 之外,后端从不把别人账号的项目发给你。 */}
                    <ProjectVisibilityBadges
                      isPublic={isPublicProject}
                      isRootOnly={isRootOnlyUnclaimed}
                      isSharedToViewer={isSharedToViewer}
                      sharedOutCount={sharedOutCount}
                      t={t}
                    />
                  </div>
                  {/* 设计稿的项目行是单行:名称 + 徽标 + 箭头。会话数在展开后的会话行上,
                      完整路径进 title,不再占第二行。 */}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {isEditing ? (
              <>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-foreground transition-colors hover:bg-muted dark:text-primary"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </div>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </div>
              </>
            ) : (
              <>
                {/* 收藏星也收进悬停浮层了 —— `sortProjects` 里收藏项无条件排在最前,
                    位置本身就是状态,行里再挂一颗常驻的星是重复表达,还要占 24px。 */}
                {/* ef:项目行 = 名字 + 会话数(等宽小字),悬停浮层盖上来时它让位。 */}
                {totalSessionCount > 0 && (
                  <span
                    className="font-mono text-[10.5px] tabular-nums text-muted-foreground group-hover:invisible"
                    title={sessionCountLabel}
                  >
                    {sessionCountDisplay}
                  </span>
                )}
              </>
            )}
          </div>

          {/*
            悬停动作浮在行上,**不参与行内布局**。
            以前这四个按钮(星/改名/权限/删除)是 `opacity-0 group-hover:opacity-100` ——
            看不见,但 4×24px + 间距 ≈ 96px 的宽度一直占着。侧栏内宽本来就只有
            ~210px,再减掉文件夹图标与箭头,名字只剩 ~58px,于是 `chendongchao`
            被截成 `chendo…`;再挂个「已共享·4」徽标,名字直接被挤到 0 宽度
            (线上截图里那行只剩徽标,项目名整个不见了)。
            改成绝对定位之后,这些按钮悬停时盖在名字尾部,而不是挤压它。
          */}
          {!isEditing && (
            <div className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-md bg-muted pl-3 group-hover:flex">
              <div
                className={cn(
                  'flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm transition-colors',
                  isStarred ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleStarProject();
                }}
                title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
              >
                <Star className={cn('h-4 w-4', isStarred && 'fill-primary')} strokeWidth={2} />
              </div>
              <div
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onStartEditingProject(project);
                }}
                title={t('tooltips.renameProject')}
              >
                <Edit3 className="h-3.5 w-3.5" />
              </div>
              {canManagePermissions && (
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowPermissions(true);
                  }}
                  title={t('tooltips.managePermissions', { defaultValue: '项目权限' })}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                </div>
              )}
              <div
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteProject(project);
                }}
                title={t('tooltips.deleteProject')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </div>
            </div>
          )}
        </Button>
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        attentionSessionIds={attentionSessionIds}
        awaitingApprovalSessionIds={awaitingApprovalSessionIds}
        currentTime={currentTime}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />

      {/* 挂在根 div 下而不是上面的 <Button> 里:portal 的合成事件沿 React 树冒泡,
          放进 Button 会让弹窗内的每次点击都触发选中/展开项目。 */}
      {showPermissions && (
        <ProjectPermissionsModal
          project={project}
          onClose={() => setShowPermissions(false)}
          onSaved={() => onProjectsRefresh?.()}
        />
      )}
    </div>
  );
}
