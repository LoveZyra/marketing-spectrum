import { memo, useEffect, useRef, useState } from 'react';
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
  /** 多选态。为真时行首出现复选框,整行点击变成勾选。 */
  selectionMode?: boolean;
  isSelectedForBulk?: boolean;
  onToggleSelection?: (projectId: string) => void;
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
 * 项目可见性标记,只给图标、不给文字。
 *
 * 侧栏内宽只有 ~236px,文字胶囊(一个「已共享·4」就要 56px)会让项目名先被截断,
 * 而项目名才是这一行真正要读的东西;14px 图标表达同样的信息只占 ~18px。
 *
 * 每个图标都挂 `title` + `aria-label`,悬停出全句解释,读屏器也念得出。
 * 「已共享」后面的数字是共享人数,保留:那是个量,不是个状态。
 *
 * 四个状态:
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

/**
 * 一行项目,用 memo 包起来。
 *
 * memo 靠 props 引用不变:`sessions={getProjectSessions(project)}` 能稳定,全靠
 * `getAllSessions` 按 project 对象缓存;没有那层缓存,每次渲染都是新数组,memo 永远不命中。
 *
 * `currentTime` 每 60 秒变一次,届时所有行一起重渲染,这是有意的:相对时间("3 分钟前")
 * 本来就该刷新。要紧的是搜索框每敲一个字、展开 / 收起某个项目、某条会话状态变化时,
 * 不相干的行不再跟着重渲染。
 */
function SidebarProjectItem({
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
  selectionMode = false,
  isSelectedForBulk = false,
  onToggleSelection,
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
  // 插值名用 `sessions` 而不是 `count`:这条不需要复数变体键(同 fileTree.batchDownloadLabel)。
  const sessionCountLabel = totalSessionCount === 1
    ? t('projects.sessionCountOne', { sessions: sessionCountDisplay, defaultValue: `${sessionCountDisplay} 个会话` })
    : t('projects.sessionCount', { sessions: sessionCountDisplay, defaultValue: `${sessionCountDisplay} 个会话` });

  // "公共" 只在项目真正对所有人可见时才打(无主且落在 PRISM_PUBLIC_WORKSPACE 下,
  // 由后端 isPublic 判定)。不能拿 ownerUserId === null 当"公共":不在公共目录下的
  // 无主项目只有 root 看得到。
  const isPublicProject = project.isPublic === true;
  // 无主但不在公共目录:只有 root 收得到这类项目(非 root 根本不会出现在列表里)。
  // 给它一个"仅 root"标,让管理员一眼看出这些是未认领、仅自己可见的目录。
  const isRootOnlyUnclaimed = !isPublicProject && project.ownerUserId === null;
  // 被「指定用户」授权给当前用户的项目 —— 打"共享"标,说明它是别人开放给你的。
  const isSharedToViewer = project.sharedWithViewer === true;
  // 反向视角:owner 和 root 不是接收方,靠授权人数看出"这个项目共享过"。
  const sharedOutCount = !isSharedToViewer ? (project.sharedUserCount ?? 0) : 0;
  // 权限管理入口:root 或项目 owner 才显示。这只是入口显隐,服务端对
  // GET/PUT /permissions 有同样的校验(非 owner / root 一律 403),边界在后端。
  // 改名的铅笔与归档 / 删除的垃圾桶也按这一条画:显示名是全局的一列,服务端 rename
  // 与权限同门(非 owner / root 403);无主(公共目录)项目的归档 / 永久删除只给 root。
  // 给协作者画一枚必然 403 的按钮比不画更糟。
  const canManagePermissions =
    user?.isRoot === true ||
    (project.ownerUserId != null &&
      user?.id != null &&
      String(project.ownerUserId) === String(user.id));
  const canRenameProject = canManagePermissions;
  const canRemoveProject = canManagePermissions;

  /**
   * 改名时点行外关闭。
   *
   * 编辑态上面既没有遮罩也没有焦点提示,点到别处还停在编辑态,看上去像界面卡住了。
   * 与会话行(`SidebarSessionItem`)一致:点外面 = 取消,不是保存;
   * 误点一下就把项目改了名,比丢掉几个字糟得多。
   *
   * 手机卡片与桌面行各一个 ref:同一时刻只有一个在 DOM 里,但两边都要认。
   */
  const mobileRowRef = useRef<HTMLDivElement>(null);
  const desktopRowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (mobileRowRef.current?.contains(target)) return;
      if (desktopRowRef.current?.contains(target)) return;
      onCancelEditingProject();
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingProject]);

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId);
  };

  /**
   * 行的默认动作:选中项目并展开会话。
   *
   * 多选态下改成勾选 —— 但这只在用户显式点过「多选」之后才生效。
   * 悄悄把"打开"改成"选中"是删错东西的开始(文件树那边同样的取舍)。
   */
  const selectAndToggleProject = () => {
    if (selectionMode) {
      onToggleSelection?.(project.projectId);
      return;
    }
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
            ref={mobileRowRef}
            className={cn(
              'p-3 mx-3 my-1 rounded-md border border-border active:translate-y-px',
              isSelected && !selectionMode && 'bg-muted',
              selectionMode && isSelectedForBulk && 'bg-accent',
              isStarred &&
                !isSelected &&
                'border-border',
            )}
            onClick={selectionMode ? () => onToggleSelection?.(project.projectId) : toggleProject}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {/* 多选态下这一格换成复选框:手机上收藏星那个 32px 的位置最顺手,不必再挤出一格。 */}
                {selectionMode ? (
                  <span className="flex h-8 w-8 flex-none items-center justify-center">
                    <input
                      type="checkbox"
                      checked={isSelectedForBulk}
                      onChange={() => onToggleSelection?.(project.projectId)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={t('project.bulk.select', { defaultValue: '选中项目' })}
                      className="h-4 w-4"
                    />
                  </span>
                ) : (
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
                  aria-label={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                  aria-pressed={isStarred}
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
                )}

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(event) => onEditingNameChange(event.target.value)}
                      className="w-full rounded-md border border-primary/40 bg-background px-3 py-2 text-sm text-foreground transition-colors focus:border-primary focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      title={project.fullPath}
                      autoFocus
                      autoComplete="off"
                      // 行内改名的统一标记:Esc 在这里是"取消改名",不能顺带把
                      // 正在跑的那一轮也中止掉(见 ChatInterface 的全局 Esc)。
                      data-inline-rename="true"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
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

              {/* 多选态下收起这排单条动作:单条与批量混在一起最容易点错。 */}
              <div className={cn('flex items-center gap-1', selectionMode && 'hidden')}>
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-md bg-primary active:translate-y-px"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                      aria-label={t('tooltips.save')}
                    >
                      <Check className="h-4 w-4 text-primary-foreground" />
                    </button>
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-md bg-muted active:translate-y-px"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                      aria-label={t('tooltips.cancel')}
                    >
                      <X className="h-4 w-4 text-foreground" />
                    </button>
                  </>
                ) : (
                  <>
                    {canRemoveProject && (
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-border active:translate-y-px"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteProject(project);
                        }}
                        aria-label={t('tooltips.deleteProject')}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </button>
                    )}

                    {canRenameProject && (
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-border active:translate-y-px"
                        onClick={(event) => {
                          event.stopPropagation();
                          onStartEditingProject(project);
                        }}
                        aria-label={t('tooltips.renameProject')}
                      >
                        <Edit3 className="h-4 w-4 text-primary" />
                      </button>
                    )}

                    {canManagePermissions && (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-border active:translate-y-px"
                        onClick={(event) => {
                          event.stopPropagation();
                          setShowPermissions(true);
                        }}
                        title={t('tooltips.managePermissions', { defaultValue: '项目权限' })}
                        aria-label={t('tooltips.managePermissions', { defaultValue: '项目权限' })}
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
          ref={desktopRowRef}
          variant="ghost"
          className={cn(
            'relative hidden md:flex w-full justify-between rounded-md px-2.5 py-2 h-auto font-normal hover:bg-muted',
            // 编辑态里内容从 ~20px 的标题行变成 26px 的输入框,这里把上下内边距
            // 从 8px 收到 5px 抵掉 —— 前后都是 36px,改名时下面的行不会被顶下去。
            isEditing && 'py-[5px]',
            isSelected && !selectionMode && 'prism-panel bg-card dark:bg-muted',
            selectionMode && isSelectedForBulk && 'bg-accent',
          )}
          onClick={selectAndToggleProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* 项目行是「箭头 → 文件夹 → 名字 …… 会话数」,箭头在最左,展开状态一眼可见;多选态下复选框顶替箭头而不另占一格(侧栏只有 ~210px,多一格就少 16px 项目名),多选时也不需要展开。 */}
            {selectionMode ? (
              <input
                type="checkbox"
                checked={isSelectedForBulk}
                onChange={() => onToggleSelection?.(project.projectId)}
                onClick={(event) => event.stopPropagation()}
                aria-label={t('project.bulk.select', { defaultValue: '选中项目' })}
                className="h-3.5 w-3.5 flex-none"
              />
            ) : isExpanded
              ? <ChevronDown className="h-3 w-3 flex-none text-muted-foreground" strokeWidth={2} />
              : <ChevronRight className="h-3 w-3 flex-none text-muted-foreground" strokeWidth={2} />}
            <Folder
              className={cn('h-3.5 w-3.5 flex-shrink-0', isSelected || isExpanded ? 'filetype-dir' : 'text-muted-foreground')}
              strokeWidth={2}
            />
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                /* 改名也是单行:完整路径放进输入框的 title,不另占第二行(与非编辑分支一致),
                   否则行高会从 36px 涨到 ~70px,把底下的项目顶下去一截。 */
                <input
                  type="text"
                  value={editingName}
                  onChange={(event) => onEditingNameChange(event.target.value)}
                  className="h-[26px] w-full rounded border border-border bg-background px-2 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder={t('projects.projectNamePlaceholder')}
                  title={project.fullPath}
                  autoFocus
                  autoComplete="off"
                  // 行内改名的统一标记,含义同手机端那个。
                  data-inline-rename="true"
                  // 整行是个 <Button>(点一下 = 选中并展开)。不拦住的话,
                  // 点进输入框改个错字,项目就在脚下折叠/展开了一次。
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveProjectName();
                    }
                    if (event.key === 'Escape') {
                      onCancelEditingProject();
                    }
                  }}
                />
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
                {/* 项目行 = 名字 + 会话数(等宽小字),悬停浮层盖上来时它让位。 */}
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

          {/* 悬停动作绝对定位浮在行上、不参与行内布局:侧栏内宽只有 ~210px,四个按钮常驻占位(哪怕透明)会把项目名挤到几乎 0 宽,悬停时盖住名字尾部即可。 */}
          {!isEditing && !selectionMode && (
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
              {canRenameProject && (
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
              )}
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
              {canRemoveProject && (
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
              )}
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

export default memo(SidebarProjectItem);
