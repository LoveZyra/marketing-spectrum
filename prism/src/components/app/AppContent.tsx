import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useAuth } from '../auth/context/AuthContext';
import { canPermanentlyDeleteSession } from '../../utils/sessionDeletePermission';
import { usePendingApprovalCount } from '../../hooks/usePendingApprovalCount';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { api } from '../../utils/api';
import { describeDeleteFailure } from '../sidebar/utils/deleteFailure';
import { pullAccountSettings } from '../../utils/accountSettings';
import ErrorBoundary from '../../shared/view/ErrorBoundary';
import SettingsModalHost from '../settings/view/SettingsModalHost';
import SessionDeleteDialog, { type SessionDeleteTarget } from '../../shared/view/SessionDeleteDialog';

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
   * 登录后拉取账号级界面偏好。
   *
   * 读取始终走 localStorage(同步、无网络、启动时不会先闪一下默认值);服务端只做备份与跨设备同步。
   * 服务端那份更新时写回本机并整页重载:权限清单、编辑器偏好散在十几个组件的初始 state 里,
   * 逐个通知比重载复杂得多,而这条路径每次登录只走一次。
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
  // 预览最大化期间项目侧栏也收起(不写偏好,还原后回到用户自己的开合状态)。
  const [editorMaximized, setEditorMaximized] = useState(false);

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
   * 顶栏的会话改名与删除。
   *
   * 侧栏折叠时 `<Sidebar/>` 整棵不渲染,它自带的改名 / 删除实现和确认框也随之消失,
   * 所以顶栏这两项操作必须放在这一层。改名或删除后刷新项目列表,侧栏随之更新。
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
    // 是否显示「永久删除」按钮按是否为项目负责人判断,与侧栏同一判据(见 utils/sessionDeletePermission)。
    setSessionDeleteTarget({
      sessionId: targetSessionId,
      sessionTitle,
      canDeletePermanently: canPermanentlyDeleteSession({
        isRoot: Boolean(authUser?.isRoot),
        viewerUserId: authUser?.id ?? null,
        projectOwnerUserId: selectedProject?.ownerUserId ?? null,
        projectKnown: Boolean(selectedProject),
      }),
    });
  }, [authUser?.id, authUser?.isRoot, selectedProject]);

  const confirmHeaderDeleteSession = useCallback(async (hardDelete: boolean) => {
    const target = sessionDeleteTarget;
    setSessionDeleteTarget(null);
    if (!target) return;
    try {
      const response = await api.deleteSession(target.sessionId, hardDelete);
      if (!response.ok) {
        // 403(只有项目负责人能永久删除)/ 409(会话正在运行)重试也没用,要把原因告诉用户;
        // 其余失败不弹窗,列表下次刷新会带回真实状态。
        if (response.status === 403 || response.status === 409) {
          alert(describeDeleteFailure(await response.text(), tSidebar('messages.deleteSessionFailed')));
        }
        return;
      }
      if (sessionId === target.sessionId) navigate('/');
      await refreshProjectsSilently();
    } catch {
      // 失败不弹窗:列表下一次刷新会把真实状态带回来。
    }
  }, [navigate, refreshProjectsSilently, sessionDeleteTarget, sessionId, tSidebar]);

  // 桌面端折叠后只留图标轨:侧栏连同外层边框都不渲染。
  // 技能优化是全局页面(不挂在项目下),Notebook 用 JupyterLab 自带的文件浏览器(从 home 起,与当前项目无关),
  // 这两页一律不渲染项目 / 会话侧栏;技能优化页上左轨的开合按钮改管它自己的导航(见 AppRail)。
  //
  // 开合状态:聊天页跟随持久化偏好 sidebarVisible(只有在聊天页亲手开合才写);其他页默认收起,
  // 在那里开合只改本地状态、不落盘,换页即复位。该偏好随账号同步到其他设备,
  // 若按当前标签页去写它,另一台设备停在文件页就会让本机聊天页刷新后侧栏消失。
  const [offChatSidebarOpen, setOffChatSidebarOpen] = useState(false);
  const lastSidebarTabRef = useRef(activeTab);
  useEffect(() => {
    if (lastSidebarTabRef.current === activeTab) return;
    lastSidebarTabRef.current = activeTab;
    setOffChatSidebarOpen(false);
  }, [activeTab]);
  const sidebarOpenHere = activeTab === 'chat' ? uiPreferences.sidebarVisible : offChatSidebarOpen;
  const toggleSidebarHere = useCallback(() => {
    if (activeTab === 'chat') {
      setPreference('sidebarVisible', !uiPreferences.sidebarVisible);
      return;
    }
    // Sidebar 自己也读这个偏好(为假时整棵不画):在别的页亲手「展开」而偏好是收着的,
    // 这是用户的明确意图,顺带把偏好也打开 —— 只有这一种情况会在非聊天页写偏好。
    if (!offChatSidebarOpen && !uiPreferences.sidebarVisible) setPreference('sidebarVisible', true);
    setOffChatSidebarOpen((open) => !open);
  }, [activeTab, offChatSidebarOpen, setPreference, uiPreferences.sidebarVisible]);

  const isSidebarCollapsed = !isMobile && (!sidebarOpenHere || editorMaximized
    || activeTab === 'skillwhet' || activeTab === 'notebook');

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

  // 每 5 秒轮询 /sessions/running;页面不可见时暂停,免得后台标签页一直请求。回到前台立即补一次再恢复周期。
  useEffect(() => {
    let interval: number | null = null;
    const start = () => {
      if (interval !== null) return;
      interval = window.setInterval(() => {
        void refreshRunningSessions();
      }, 5000);
    };
    const stop = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        void refreshRunningSessions();
        start();
      }
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
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
          sidebarOpen={sidebarOpenHere}
          onToggleSidebar={toggleSidebarHere}
        />
      )}
      {/*
        * 侧栏套错误边界:它是全应用数据最杂的一块(项目树、会话列表、运行状态、多选、权限徽标),
        * 任何一处渲染抛错都会整页白屏,连回到聊天都做不到。`Suspense` 只管懒加载的等待,兜不住运行时异常。
        *
        * `resetKeys` 用 selectedProject:侧栏崩溃多半是某条数据形状不对(比如字段意外为 null),
        * 换个项目正好换掉那批数据并重试一次。
        */}
      {!isMobile ? (
        isSidebarCollapsed ? null : (
          <div className="h-full flex-shrink-0 border-r border-border">
            <ErrorBoundary label={t('tabs.projects', { defaultValue: '项目' })} resetKeys={[selectedProject?.name ?? null]}>
              <Sidebar {...sidebarSharedProps} />
            </ErrorBoundary>
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
            {/* 移动端抽屉里的同一棵侧栏,同样要兜底 —— 崩了整页白屏。 */}
            <ErrorBoundary label={t('tabs.projects', { defaultValue: '项目' })} resetKeys={[selectedProject?.name ?? null]}>
              <Sidebar {...sidebarSharedProps} />
            </ErrorBoundary>
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
          onRenameSession={handleHeaderRenameSession}
          onDeleteSession={handleHeaderDeleteSession}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          onStartNewSession={handleNewSession}
          jupyterTarget={jupyterTarget}
        />
      </div>

      <SessionDeleteDialog
        target={sessionDeleteTarget}
        onCancel={() => setSessionDeleteTarget(null)}
        onConfirm={(hardDelete) => void confirmHeaderDeleteSession(hardDelete)}
        t={tSidebar}
      />

      {/* 设置弹窗挂在这一层而不在侧栏里:侧栏折叠时 `<Sidebar/>` 整棵不渲染,而设置的三个入口
          (轨上的齿轮、命令面板、主区)都在侧栏之外,挂在侧栏里会出现「折叠后点设置没反应」。
          弹窗 portal 到 body,挂在哪一层不影响显示位置。 */}
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
