import React, { lazy, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../types/types';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import ErrorBoundary from '../../../shared/view/ErrorBoundary';
import LazyPanel from '../../../shared/view/LazyPanel';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import MobileMenuButton from './subcomponents/MobileMenuButton';

// Tabs other than chat mount only once they are activated, so deferring their
// modules costs nothing and keeps heavy dependencies such as xterm out of the
// entry chunk. ChatInterface stays eager: it is the default tab and is kept
// mounted (hidden) across tab switches, so lazily loading it would only delay
// first paint.
//
// EditorSidebar also stays eager — it is always rendered — but it lazily loads
// CodeMirror itself, since it returns null until a file is actually open.
const FileTree = lazy(() => import('../../file-tree/view/FileTree'));
const TasksPage = lazy(() => import('../../tasks/TasksPage'));
const SkillWhetPage = lazy(() => import('../../skillwhet/SkillWhetPage'));
const StandaloneShell = lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const JupyterPanel = lazy(() => import('../../jupyter/JupyterPanel'));

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  isConnected,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  onEditorMaximizedChange,
  onRenameSession,
  onDeleteSession,
  externalMessageUpdate,
  newSessionTrigger,
  onStartNewSession,
  jupyterTarget,
}: MainContentProps) {
  const { t } = useTranslation('common');
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  // 「常驻会话」的本地判据:服务端会把跑过一轮的会话留成常驻运行时(PRISM_PERSISTENT_SESSIONS
  // 默认开),所以某个会话只要在本页进入过处理中,服务端就有它的运行时。刷新页面后这份记忆清空,
  // 宁可少显示也不谎报;准确状态由顶栏查询 /runtime 得到(见 MainContentHeader)。
  const residentSessionsRef = React.useRef<Set<string>>(new Set());
  const activeSessionId = selectedSession?.id;
  if (activeSessionId && processingSessions.has(activeSessionId)) {
    residentSessionsRef.current.add(activeSessionId);
  }
  const isPersistentSession = Boolean(activeSessionId && residentSessionsRef.current.has(activeSessionId));

  // notebook 标签页首次激活后保持挂载(切走时用 CSS 隐藏):iframe 卸载会让 lab 界面重载,
  // kernel 在服务端不受影响,但界面状态全丢。与 chat 同一策略。
  const [notebookMounted, setNotebookMounted] = useState(false);
  useEffect(() => {
    if (activeTab === 'notebook') {
      setNotebookMounted(true);
    }
  }, [activeTab]);



  const {
    editingFile,
    openFiles,
    handleSelectFile,
    handleCloseFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
    // 项目目录之外的产出文件按「这段会话的产出」只读打开,需要当前会话 id。
    activeSessionId: selectedSession?.id ? String(selectedSession.id) : null,
  });

  // 预览最大化时通知上层把项目侧栏也收起,还原时放回;只在状态变化时通知。
  useEffect(() => {
    onEditorMaximizedChange?.(editorExpanded);
  }, [editorExpanded, onEditorMaximizedChange]);
  // 卸载(切项目 / 切页)时还原,别把侧栏留在"被最大化压住"的状态。
  useEffect(() => () => onEditorMaximizedChange?.(false), [onEditorMaximizedChange]);

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    // 技能优化、Notebook、定时任务都不挂在项目下,没选项目也照常可用(JupyterLab 的文件浏览器从 home 起,
    // 定时任务表单有自己的项目下拉)。聊天 / 文件 / 终端以项目为前提,显示「先选项目」空态。
    if (activeTab === 'skillwhet') {
      return (
        <div className="flex h-full flex-col">
          {isMobile && (
            <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
              <MobileMenuButton onMenuClick={onMenuClick} compact />
              <span className="text-sm font-medium text-foreground">{t('tabs.skillwhet', { defaultValue: '技能优化' })}</span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <LazyPanel label={t('tabs.skillwhet', { defaultValue: '技能优化' })}>
              <SkillWhetPage />
            </LazyPanel>
          </div>
        </div>
      );
    }
    if (activeTab === 'notebook') {
      return (
        <div className="flex h-full flex-col">
          {isMobile && (
            <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
              <MobileMenuButton onMenuClick={onMenuClick} compact />
              <span className="text-sm font-medium text-foreground">{t('tabs.notebook', { defaultValue: 'Notebook' })}</span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <LazyPanel label={t('tabs.notebook', { defaultValue: 'Notebook' })}>
              <JupyterPanel target={jupyterTarget ?? { path: null, nonce: 0 }} />
            </LazyPanel>
          </div>
        </div>
      );
    }
    if (activeTab === 'tasks') {
      return (
        <div className="flex h-full flex-col">
          {isMobile && (
            <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
              <MobileMenuButton onMenuClick={onMenuClick} compact />
              <span className="text-sm font-medium text-foreground">{t('tabs.tasks', { defaultValue: '定时任务' })}</span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <LazyPanel label={t('tabs.tasks', { defaultValue: '定时任务' })}>
              <TasksPage
                selectedProject={null}
                selectedSession={selectedSession}
                setActiveTab={setActiveTab}
                onNavigateToSession={onNavigateToSession}
              />
            </LazyPanel>
          </div>
        </div>
      );
    }
    return (
      <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} activeTab={activeTab} />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 技能优化与 Notebook 是全局页面,不挂项目标题 / 项目徽标,免得让人以为它们跟着项目走
          (技能优化有自己的面包屑,JupyterLab 有自己的菜单栏)。手机上只留一条带菜单按钮的窄栏,
          与没选项目时一致。 */}
      {activeTab === 'skillwhet' || activeTab === 'notebook' ? (isMobile && (
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
          <span className="text-sm font-medium text-foreground">{activeTab === 'notebook'
            ? t('tabs.notebook', { defaultValue: 'Notebook' })
            : t('tabs.skillwhet', { defaultValue: '技能优化' })}</span>
        </div>
      )) : (
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        isPersistentSession={isPersistentSession}
        onRenameSession={onRenameSession}
        onDeleteSession={onDeleteSession}
      />
      )}

      {/* 项目被移除(归档 / 删除 / 收回可见性)时保留对话区以便查看,只加一条提示:后续操作多半会失败。 */}
      {selectedProject.removedFromView && (
        <div role="status" className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {t('mainContent.projectRemovedNotice', { defaultValue: '这个项目已被归档、删除,或你已不再能访问它。当前对话仅供查看,后续操作可能失败。' })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 这一栏 = 聊天正文 + 工作面板:CSS 只保证正文的 280px(与 EditorSidebar 的 MIN_CHAT_BODY_WIDTH 同一个数),面板宽度由 measureLeftFloor 实测计入预算;不用 min-w-min(正文 min-content 约 390,与预算对不上,会把编辑器挤到溢出被裁) */}
        <div className={`flex min-h-0 min-w-[280px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary label={t('tabs.chat')} showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                isConnected={isConnected}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                isEditorOpen={Boolean(editingFile)}
                isActive={activeTab === 'chat'}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onStartNewSession={onStartNewSession}
              />
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <LazyPanel label={t('tabs.files')}>
                <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
              </LazyPanel>
            </div>
          )}

          {activeTab === 'skillwhet' && (
            <div className="h-full overflow-hidden">
              <LazyPanel label={t('tabs.skillwhet', { defaultValue: '技能优化' })}>
                <SkillWhetPage />
              </LazyPanel>
            </div>
          )}

          {activeTab === 'tasks' && (
            <div className="h-full overflow-hidden">
              <LazyPanel label={t('tabs.tasks', { defaultValue: '定时任务' })}>
                <TasksPage
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                  setActiveTab={setActiveTab}
                  onNavigateToSession={onNavigateToSession}
                />
              </LazyPanel>
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="h-full w-full overflow-hidden">
              <LazyPanel label={t('tabs.shell')}>
                <StandaloneShell
                  project={selectedProject}
                  session={selectedSession}
                  showHeader={false}
                  isActive={activeTab === 'shell'}
                />
              </LazyPanel>
            </div>
          )}

          {notebookMounted && (
            <div className={`h-full w-full overflow-hidden ${activeTab === 'notebook' ? 'block' : 'hidden'}`}>
              <LazyPanel label={t('tabs.notebook', { defaultValue: 'Notebook' })}>
                <JupyterPanel target={jupyterTarget ?? { path: null, nonce: 0 }} />
              </LazyPanel>
            </div>
          )}

        </div>

        <EditorSidebar
          editingFile={editingFile}
          openFiles={openFiles}
          onSelectFile={handleSelectFile}
          onCloseFile={handleCloseFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
      </div>
    </div>
  );
}

export default React.memo(MainContent);
