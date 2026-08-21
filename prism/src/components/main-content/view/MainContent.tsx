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

// Every tab below the chat tab is already mounted only while it is the active
// tab, so deferring its module costs nothing and keeps xterm and the plugin
// runtime out of the entry chunk. ChatInterface stays
// eager: it is the default tab and is kept mounted (hidden) across tab
// switches, so lazily loading it would only delay first paint.
//
// EditorSidebar also stays eager — it is always rendered — but it lazily loads
// CodeMirror itself, since it returns null until a file is actually open.
const FileTree = lazy(() => import('../../file-tree/view/FileTree'));
const StandaloneShell = lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const JupyterPanel = lazy(() => import('../../jupyter/JupyterPanel'));
// Imported by concrete path rather than through the package barrels: the

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
  externalMessageUpdate,
  newSessionTrigger,
  jupyterTarget,
}: MainContentProps) {
  const { t } = useTranslation('common');
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  // 「常驻会话」判定 —— 服务端把跑过一轮的会话留成常驻运行时(PRISM_PERSISTENT_SESSIONS
  // 默认开),客户端没有直查接口,所以只认自己亲眼见过的:某个会话一旦进入过处理中,
  // 它在服务端就有了运行时。刷新页面后这份记忆清空,宁可少显示也不谎报。
  const residentSessionsRef = React.useRef<Set<string>>(new Set());
  const activeSessionId = selectedSession?.id;
  if (activeSessionId && processingSessions.has(activeSessionId)) {
    residentSessionsRef.current.add(activeSessionId);
  }
  const isPersistentSession = Boolean(activeSessionId && residentSessionsRef.current.has(activeSessionId));

  // notebook 标签页首次激活后保持挂载(CSS 隐藏):iframe 卸载 = lab 界面重载,
  // 正在跑的 kernel 虽然不会死(在服务端),但界面状态全丢。与 chat 同一策略。
  const [notebookMounted, setNotebookMounted] = useState(false);
  useEffect(() => {
    if (activeTab === 'notebook') {
      setNotebookMounted(true);
    }
  }, [activeTab]);



  const {
    editingFile,
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
  });

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
    return (
      <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} activeTab={activeTab} />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        isPersistentSession={isPersistentSession}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary label={t('tabs.chat')} showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                isConnected={isConnected}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
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
