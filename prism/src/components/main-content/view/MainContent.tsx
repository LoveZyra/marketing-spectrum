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

// Every tab below the chat tab is already mounted only while it is the active
// tab, so deferring its module costs nothing and keeps xterm and the plugin
// runtime out of the entry chunk. ChatInterface stays
// eager: it is the default tab and is kept mounted (hidden) across tab
// switches, so lazily loading it would only delay first paint.
//
// EditorSidebar also stays eager — it is always rendered — but it lazily loads
// CodeMirror itself, since it returns null until a file is actually open.
const FileTree = lazy(() => import('../../file-tree/view/FileTree'));
const TasksPage = lazy(() => import('../../tasks/TasksPage'));
const SkillWhetPage = lazy(() => import('../../skillwhet/SkillWhetPage'));
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
    // ei:项目目录之外的产出文件按"这段会话的产出"读取(只读)。
    activeSessionId: selectedSession?.id ? String(selectedSession.id) : null,
  });

  // ee:最大化 → 通知上层把项目侧栏也收起(还原时放回);只在状态真的变化时发。
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
    // 定时任务列表是全局的(不挂在某个项目下),没选项目也照常可看可建 ——
    // 表单里有自己的项目下拉。其余标签页(聊天/文件/终端)都以项目为前提,
    // 保持原来的"先选项目"空态。
    // gy:技能优化同理 —— 全局页面,不挂在项目下。
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
    // hh:Notebook 也不挂在项目下(JupyterLab 自己的文件浏览器从 home 起)—— 没选项目照样能开
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
      {/* hc:技能优化是全局页面 —— 不挂项目标题 / 项目徽标(原来显示「技能优化 · <当前项目>」),
          页面自己有面包屑;手机上留一条带菜单按钮的窄栏,和没选项目时同一个样子 */}
      {/* hh:Notebook 同理 —— JupyterLab 有自己的菜单栏,顶上再挂「JupyterLab · <项目>」只会让人以为它跟着项目走 */}
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

      {/* hl 复核 P3-8:项目被移除(归档 / 删除 / 收回可见性)时不再把对话区切掉 —— 留着能看,
          给一条提示:再操作多半会失败,去侧栏换个项目。 */}
      {selectedProject.removedFromView && (
        <div role="status" className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          {t('mainContent.projectRemovedNotice', { defaultValue: '这个项目已被归档、删除,或你已不再能访问它。当前对话仅供查看,后续操作可能失败。' })}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* dy:下限交给 min-content,不再写死。
            这一栏装的是「聊天正文 + 工作面板」两块。原来写死 200px —— 预览栏
            一开,整栏被压到 200,而工作面板(flex-none,300/xl:320)照样占满,
            被挤到 0 的是**聊天正文**,连面板自己都被 overflow-hidden 裁掉
            (用户截图:文件名少首字母、收起按钮整个不见)。
            正确的下限由两部分组成:正文的 280px(见 ChatInterface)+ 面板此刻
            的实际宽度。后者会变(展开 300/320、折起 40、<lg 不渲染),所以**不在
            这里写死**:CSS 只保证正文那 280,面板那部分由 EditorSidebar 实测后
            计入预算(measureLeftFloor),两边共用同一个 280。
            (试过 min-w-min 让浏览器自己算——正文的 min-content 实测 ~390,
             比 280 大,预算和 CSS 对不上,反而把编辑器挤到溢出被裁。) */}
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
