import { useEffect, useRef } from 'react';
import { Check, Edit2, FileDown, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip, buttonVariants } from '../../../../shared/view/ui';
import { downloadSessionExport } from '../../../../utils/session-export';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel } from '../../utils/utils';
import ClaudeLogo from '../../../llm-logo-provider/ClaudeLogo';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isProcessing: boolean;
  needsAttention: boolean;
  /**
   * 这个会话卡在一个工具审批上,在等人点确认。
   *
   * 和 `needsAttention` 分开显示,因为它们说的不是一回事:那个是"这边有动静",
   * 这个是"跑不下去了,在等你"。审批框只在正在看该会话时才渲染,人在别处时
   * 这个点是唯一的提示 —— 不去点,那一轮就永远停在那里。
   */
  awaitingApproval: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  t: TFunction;
};

/**
 * Compact relative time for sidebar rows:
 * <1m, Xm, Xhr, Xd.
 */
const formatCompactSessionAge = (dateString: string, currentTime: Date): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
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

  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d`;
};

export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isProcessing,
  needsAttention,
  awaitingApproval,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  t,
}: SidebarSessionItemProps) {
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const isEditing = editingSession === session.id;
  const compactSessionAge = formatCompactSessionAge(sessionView.sessionTime, currentTime);
  const editingContainerRef = useRef<HTMLDivElement>(null);
  // 待审批优先级最高,而且**选中时也要显示** —— 框虽然渲染在聊天区里,但用户
  // 可能滚上去了、或者窗口不在前台。这是个恒定提示,不是"你没看见时才亮"。
  const showApprovalIndicator = awaitingApproval;
  const showAttentionIndicator = !showApprovalIndicator && needsAttention && !isSelected;
  const showRecentIndicator =
    !showApprovalIndicator && !showAttentionIndicator && !isProcessing && sessionView.isActive;

  const statusIndicatorLabel = showApprovalIndicator
    ? t('tooltips.approvalPendingIndicator', { defaultValue: '等待你确认工具权限' })
    : isProcessing
      ? t('tooltips.processingSessionIndicator', { defaultValue: '会话运行中' })
      : showAttentionIndicator
        ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
        : t('tooltips.activeSessionIndicator');

  // The rename panel sits inside a group-hover opacity wrapper, so leaving the row
  // would visually hide it. While editing, dismiss only when the user clicks outside
  // the panel (matches Escape / cancel-button behaviour).
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = editingContainerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration.
  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.projectId, session.id, sessionView.sessionName, session.__provider);
  };

  return (
    <div className="group relative">
      <div className="md:hidden">
        <div
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md border active:translate-y-px relative',
            isSelected ? 'bg-muted border-border' : 'border-border',
          )}
          onClick={selectMobileSession}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-primary/[0.16]' : 'bg-muted',
              )}
            >
              <ClaudeLogo className="h-3 w-3" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate text-[12.5px] font-normal leading-[17px] text-foreground">{sessionView.sessionName}</div>
                {isProcessing ? (
                  <span className="ml-auto flex-shrink-0">
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      {/* 运行中:6px 实心绿点,不转圈(设计系统禁旋转) */}
                      <span className="flex h-5 w-5 items-center justify-center">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      </span>
                    </Tooltip>
                  </span>
                ) : compactSessionAge && (
                  <span className="ml-auto flex-shrink-0 font-mono text-[10.5px] text-muted-foreground">{compactSessionAge}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && (
                  <span className="font-mono text-[10.5px] text-muted-foreground">{sessionView.messageCount}</span>
                )}
              </div>
            </div>

            {!isProcessing && (
              <button
                className="ml-1 flex h-5 w-5 items-center justify-center rounded-md opacity-70 active:translate-y-px"
                onClick={(event) => {
                  event.stopPropagation();
                  requestDeleteSession();
                }}
              >
                <Trash2 className="h-2.5 w-2.5 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        <a
          href={`/session/${session.id}`}
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'relative h-auto w-full justify-start rounded-md px-2.5 py-[7px] text-left font-normal',
            isSelected ? 'prism-panel bg-card dark:bg-muted' : 'hover:bg-muted',
          )}
          // Left-click keeps in-app navigation; Ctrl/Cmd/middle-click and the
          // native right-click menu use the href to open a new tab/window.
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSessionSelect(session, project.projectId);
          }}
        >
          {/* 设计稿的会话行是两行:标题(运行中带 6px 绿点 / 等待授权带空心圈)+ 等宽元信息 */}
          <div className="flex w-full min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                'flex min-w-0 items-center gap-1.5 truncate text-[12.5px] leading-[17px]',
                isSelected ? 'text-card-foreground' : 'text-body',
              )}
            >
              {/* 状态点全库只此一处:空心圈=等授权,实心点=运行中/有动静。
                  以前行外还挂了一个绝对定位的同义点,于是一行冒出两颗绿点。 */}
              {(showApprovalIndicator || isProcessing || showRecentIndicator || showAttentionIndicator) && (
                <span
                  role="status"
                  aria-label={statusIndicatorLabel}
                  title={statusIndicatorLabel}
                  className={cn(
                    'h-1.5 w-1.5 flex-none rounded-full',
                    showApprovalIndicator ? 'border-[1.5px] border-primary' : 'bg-primary prism-dot',
                  )}
                />
              )}
              <span className="truncate">{sessionView.sessionName}</span>
            </span>
            <span
              className={cn(
                'truncate font-mono text-[10.5px]',
                // 运行中那行用强调色;淡色模式下绿色不做小字,改墨色
                isProcessing ? 'text-card-foreground dark:text-primary' : 'text-muted-foreground',
              )}
            >
              {isProcessing
                ? t('sessions.runningMeta', {
                    defaultValue: '运行中 · {{age}}',
                    age: compactSessionAge || '—',
                  })
                : [compactSessionAge, sessionView.messageCount > 0
                    ? t('sessions.messageCount', { defaultValue: '{{count}} 条', count: sessionView.messageCount })
                    : null]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </div>
        </a>

        <div
          ref={editingContainerRef}
          className={cn(
            'absolute right-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 transition-colors duration-200',
            isEditing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
            {isEditing ? (
              <>
                <input
                  type="text"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveEditedSession();
                    } else if (event.key === 'Escape') {
                      onCancelEditingSession();
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-sm bg-muted hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveEditedSession();
                  }}
                  title={t('tooltips.save')}
                >
                  <Check className="h-3 w-3 text-primary" />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-sm bg-muted hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingSession();
                  }}
                  title={t('tooltips.cancel')}
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              </>
            ) : (
              <>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-sm bg-muted hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    void downloadSessionExport(session.id, sessionView.sessionName).catch(() => {
                      // 下载失败不打断侧栏;通常是网络/权限,重试即可。
                    });
                  }}
                  title={t('tooltips.exportSession', { defaultValue: '导出会话 (Markdown)' })}
                >
                  <FileDown className="h-3 w-3 text-muted-foreground" />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-sm bg-muted hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEditingSession(session.id, sessionView.sessionName);
                  }}
                  title={t('tooltips.editSessionName')}
                >
                  <Edit2 className="h-3 w-3 text-muted-foreground" />
                </button>
                {!isProcessing && (
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded-sm bg-muted hover:bg-accent"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDeleteSession();
                    }}
                    title={t('tooltips.deleteSessionOptions', 'Archive or permanently delete this session')}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </>
            )}
          </div>
      </div>
    </div>
  );
}
