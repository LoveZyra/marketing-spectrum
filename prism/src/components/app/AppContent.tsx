import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useAuth } from '../auth/context/AuthContext';
import { usePendingApprovalCount } from '../../hooks/usePendingApprovalCount';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { api } from '../../utils/api';
import { pullAccountSettings } from '../../utils/accountSettings';
import SettingsModalHost from '../settings/view/SettingsModalHost';
import SessionDeleteDialog, { type SessionDeleteTarget } from '../../shared/view/SessionDeleteDialog';
import { buildRecentSessions } from '../chat/utils/recentSessions';

import AppRail from './AppRail';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  // 会话删除确认框的文案在 sidebar 命名空间(和侧栏那一处共用同一份措辞)。
  const { t: tSidebar } = useTranslation('sidebar');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  const authUser = useAuth().user;
  const pendingApprovalCount = usePendingApprovalCount(Boolean(authUser?.isRoot));

  /**
   * F11:登录后把账号级界面偏好拉下来。
   *
   * localStorage 仍然是**读的那一份**(同步、无网络、不会在启动时闪一下默认值);
   * 服务端只是它的备份与跨设备通道。服务端那份更新时落到本机并整页重载 ——
   * 权限清单、编辑器偏好散在十几个组件的初始 state 里,逐个通知比重载复杂得多,
   * 而这条路径一个账号一次登录只会走一次。
   */
  const accountSettingsPulledRef = useRef(false);
  useEffect(() => {
    if (!authUser || accountSettingsPulledRef.current) return;
    accountSettingsPulledRef.current = true;
    void pullAccountSettings().then((changed) => {
      if (changed) window.location.reload();
    });
  }, [authUser]);
  const { preferences: uiPreferences, setPreference } = useUiPreferences();
  // ee:预览最大化期间,项目侧栏也收起(不写偏好,还原即回到用户自己的开合状态)。
  const [editorMaximized, setEditorMaximized] = useState(false);
  // 折叠后只留图标轨:侧栏与它的外层边框一起不渲染
  const isSidebarCollapsed = !isMobile && (!uiPreferences.sidebarVisible || editorMaximized);

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  } = useSessionProtection();

  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    showSettings,
    settingsInitialTab,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
  } = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
  });

  /**
   * 切标签页时自动收放项目侧栏(用户点名)。
   *
   * 聊天要靠侧栏挑会话,所以进聊天就展开;定时任务 / 终端 / 文件 / Notebook
   * 都是"整页内容",侧栏在那儿只是占宽,自动折叠成图标轨。
   *
   * 只在 activeTab **变化**的那一拍写偏好:
   * - 同一个标签页里用户手动开合不会被这条规则覆盖回去;
   * - ref 用当前标签页初始化,所以**首次挂载不动手** —— 刷新页面时保留用户
   *   上次存下的展开/折叠状态,而不是一进来就强行展开。
   * 移动端侧栏是抽屉(由 sidebarOpen 管),这条规则不适用。
   */
  // ef:首页空态的「最近会话」—— 跨项目取最近 3 条,数据就是侧栏那份 projects。
  const recentSessions = useMemo(
    () => buildRecentSessions(
      projects,
      3,
      t('sidebar:projects.newSession', { defaultValue: '新会话' }),
      { running: processingSessions },
    ),
    [processingSessions, projects, t],
  );

  /**
   * ef:顶栏的改名与删除。
   *
   * 侧栏折叠时 `<Sidebar/>` 整棵不渲染 —— 它那套改名 / 删除的实现和确认框
   * 跟着一起消失,所以顶栏这两件事必须住在这一层。改完 / 删完都刷一次项目列表,
   * 侧栏与首页的"最近会话"跟着更新。
   */
  const [sessionDeleteTarget, setSessionDeleteTarget] = useState<SessionDeleteTarget | null>(null);

  const handleHeaderRenameSession = useCallback(async (targetSessionId: string, summary: string) => {
    try {
      const response = await api.renameSession(targetSessionId, summary);
      if (!response.ok) return false;
      await refreshProjectsSilently();
      return true;
    } catch {
      return false;
    }
  }, [refreshProjectsSilently]);

  const handleHeaderDeleteSession = useCallback((targetSessionId: string, sessionTitle: string) => {
    setSessionDeleteTarget({ sessionId: targetSessionId, sessionTitle });
  }, []);

  const confirmHeaderDeleteSession = useCallback(async (hardDelete: boolean) => {
    const target = sessionDeleteTarget;
    setSessionDeleteTarget(null);
    if (!target) return;
    try {
      const response = await api.deleteSession(target.sessionId, hardDelete);
      if (!response.ok) return;
      if (sessionId === target.sessionId) navigate('/');
      await refreshProjectsSilently();
    } catch {
      // 失败不弹窗:列表下一次刷新会把真实状态带回来。
    }
  }, [navigate, refreshProjectsSilently, sessionDeleteTarget, sessionId]);

  const lastAutoCollapseTabRef = useRef(activeTab);
  useEffect(() => {
    if (isMobile) return;
    if (lastAutoCollapseTabRef.current === activeTab) return;
    lastAutoCollapseTabRef.current = activeTab;
    setPreference('sidebarVisible', activeTab === 'chat');
  }, [activeTab, isMobile, setPreference]);

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId: selectedSession?.id ?? sessionId ?? null,
    sendMessage,
    markSessionProcessing,
  });

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[AppContent] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  // 「在 JupyterLab 打开」:编辑器里的按钮通过 paletteOps 走到这里 ——
  // 记下目标文件、切到 notebook 标签页;nonce 保证同一文件连点也重新定位。
  const [jupyterTarget, setJupyterTarget] = useState<{ path: string | null; nonce: number }>({
    path: null,
    nonce: 0,
  });
  const openInJupyter = useCallback(
    (path: string) => {
      setJupyterTarget((previous) => ({ path, nonce: previous.nonce + 1 }));
      setActiveTab('notebook');
    },
    [setActiveTab],
  );

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
    openInJupyter,
  });

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!isMobile && (
        <AppRail
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onShowSettings={openSettings}
          pendingApprovalCount={pendingApprovalCount}
        />
      )}
      {!isMobile ? (
        isSidebarCollapsed ? null : (
          <div className="h-full flex-shrink-0 border-r border-border">
            <Sidebar {...sidebarSharedProps} />
          </div>
        )
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-colors duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-[rgba(16,16,16,0.72)] transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarSharedProps} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isConnected={isConnected}
          sendMessage={sendMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionProcessing={markSessionProcessing}
          onSessionIdle={markSessionIdle}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onSessionEstablished={(targetSessionId, context) =>
            registerOptimisticSession({ sessionId: targetSessionId, ...context })
          }
          onShowSettings={openSettings}
          onEditorMaximizedChange={setEditorMaximized}
          recentSessions={recentSessions}
          onRenameSession={handleHeaderRenameSession}
          onDeleteSession={handleHeaderDeleteSession}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          jupyterTarget={jupyterTarget}
        />
      </div>

      {/* 设置弹窗挂在这里,**不在侧栏里**。
          侧栏折叠时 `<Sidebar/>` 整棵都不渲染,而设置的三个入口(轨上的齿轮、
          命令面板、主区)都在侧栏之外 —— 弹窗跟着侧栏一起消失,表现就是
          "折叠后点设置没反应"。它本来就是 portal 到 body 的,住在侧栏子树里
          只是历史位置。 */}
      <SessionDeleteDialog
        target={sessionDeleteTarget}
        onCancel={() => setSessionDeleteTarget(null)}
        onConfirm={(hardDelete) => void confirmHeaderDeleteSession(hardDelete)}
        t={tSidebar}
      />

      <SettingsModalHost
        isOpen={showSettings}
        initialTab={settingsInitialTab}
        onClose={() => setShowSettings(false)}
        projects={projects}
      />

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettings()}
        onShowTab={setActiveTab}
      />
    </div>
  );
}
