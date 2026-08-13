import React, { lazy, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { authenticatedFetch } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { Project } from '../../../types/app';
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
const PluginTabContent = lazy(() => import('../../plugins/view/PluginTabContent'));
// Imported by concrete path rather than through the package barrels: the
// task-master barrel also re-exports TaskMasterProvider, which App mounts
// eagerly, and going through the barrel would drag the whole module graph of
// both into whichever chunk loads first.
const BrowserUsePanel = lazy(() => import('../../browser-use/view/BrowserUsePanel'));
const TaskMasterPanel = lazy(() => import('../../task-master/view/TaskMasterPanel'));

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

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
}: MainContentProps) {
  const { t } = useTranslation('common');
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

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

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;

    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/browser-use/settings');
      const data = await response.json();
      setBrowserUseEnabled(Boolean(response.ok && data?.success !== false && data?.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

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
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
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
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
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

          {shouldShowTasksTab && (
            <LazyPanel label={t('tabs.tasks')} fullHeight={activeTab === 'tasks'}>
              <TaskMasterPanel isVisible={activeTab === 'tasks'} />
            </LazyPanel>
          )}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <LazyPanel label={t('tabs.browser')}>
                <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
              </LazyPanel>
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <LazyPanel label={activeTab.replace('plugin:', '')}>
                <PluginTabContent
                  pluginName={activeTab.replace('plugin:', '')}
                  selectedProject={selectedProject}
                  selectedSession={selectedSession}
                />
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
