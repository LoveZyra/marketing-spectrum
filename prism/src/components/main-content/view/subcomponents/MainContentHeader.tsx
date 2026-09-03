import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../../../shared/view/ui';
import { downloadSessionExport, type SessionExportOptions } from '../../../../utils/session-export';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { api } from '../../../../utils/api';
import type { MainContentHeaderProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import SessionActionsMenu from './SessionActionsMenu';

/**
 * 主区顶栏(设计稿 2a / 2b)。桌面端的标签切换已移到左侧图标轨(AppRail),
 * 移动端保留顶部标签栏。
 *
 * ef:整条顶栏收成**一行 44px** —— 左边标题(带就地改名的铅笔)+ 项目芯片
 * (路径 / 会话 id / 常驻状态进标题的悬停提示),右边一枚「…」:导出对话、
 * 常驻会话开关、复制项目路径、删除会话。原来的「常驻会话」胶囊和「导出」按钮撤掉。
 *
 * 「常驻会话」这一行是**真状态**:挂载时问一次 `/runtime`,开 = prewarm、
 * 关 = release(见 server/index.js 的两个 runtime 路由)。之前那个胶囊只认
 * "本页见过它在跑",刷新即忘、也关不掉。
 */
export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  isMobile,
  onMenuClick,
  isPersistentSession = false,
  onRenameSession,
  onDeleteSession,
}: MainContentHeaderProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [resident, setResident] = useState(false);
  const [residentBusy, setResidentBusy] = useState(false);

  const sessionId = selectedSession?.id ? String(selectedSession.id) : null;
  const showMenu = activeTab === 'chat' && Boolean(sessionId);
  const projectPath = selectedProject.fullPath || selectedProject.path || '';

  // 常驻状态:切会话时问一次服务端。失败按"没常驻"处理 —— 这一行只是个开关,
  // 查不到就别谎报开着。
  const refreshResident = useCallback(async (id: string) => {
    try {
      const response = await api.sessionRuntime(id);
      if (!response.ok) { setResident(false); return; }
      const data = await response.json();
      setResident(Boolean(data?.resident));
    } catch {
      setResident(false);
    }
  }, []);

  useEffect(() => {
    if (!sessionId || activeTab !== 'chat') { setResident(false); return; }
    void refreshResident(sessionId);
  }, [sessionId, activeTab, refreshResident]);

  // 本页见过它在跑 = 服务端一定给它建了运行时(MainContent 的老判据),
  // 拿来做乐观更新:回合一开跑就把开关点亮,不用等下一次查询。
  useEffect(() => {
    if (isPersistentSession) setResident(true);
  }, [isPersistentSession]);

  const handleExport = async (options: SessionExportOptions) => {
    if (!selectedSession || isExporting) return;
    setIsExporting(true);
    try {
      await downloadSessionExport(
        selectedSession.id,
        (selectedSession.summary as string) || 'session',
        options,
      );
    } catch {
      // 失败给提示,不再静默(点了没反应最困惑);当前会话不受影响。
      toast({ message: t('tooltips.exportSessionFailed', { defaultValue: '导出会话失败,请重试。' }), variant: 'error' });
    } finally {
      setIsExporting(false);
    }
  };

  const handleTogglePersistent = async (next: boolean) => {
    if (!sessionId || residentBusy) return;
    setResidentBusy(true);
    try {
      const response = next
        ? await api.prewarmSession(sessionId, {})
        : await api.releaseSessionRuntime(sessionId);
      const data = response.ok ? await response.json() : null;
      if (next) {
        const warmed = Boolean(data?.warmed);
        setResident(warmed);
        toast(warmed
          ? { message: t('mainContent.persistentOnDone', { defaultValue: '已挂起常驻运行时,下一轮不用重建进程' }), variant: 'success' }
          : { message: t('mainContent.persistentOnFailed', { defaultValue: '暂时挂不上常驻运行时(可能是常驻池已满或本轮正忙)' }), variant: 'error' });
      } else {
        const released = data?.released !== false;
        setResident(!released ? Boolean(data?.resident) : false);
        toast(released
          ? { message: t('mainContent.persistentOffDone', { defaultValue: '已释放常驻运行时,下一轮会重建进程' }), variant: 'success' }
          : { message: t('mainContent.persistentOffBusy', { defaultValue: '这一轮还在跑,跑完再释放' }), variant: 'error' });
      }
    } catch {
      toast({ message: t('mainContent.persistentFailed', { defaultValue: '常驻开关没生效,请重试' }), variant: 'error' });
    } finally {
      setResidentBusy(false);
      if (sessionId) void refreshResident(sessionId);
    }
  };

  const copyProjectPath = async () => {
    if (!projectPath) return;
    // 生产走 HTTP(127.0.0.1:8080 反代),navigator.clipboard 不可用 —— 走带 execCommand 回退的封装。
    const copied = await copyTextToClipboard(projectPath);
    toast(copied
      ? { message: t('mainContent.pathCopied', { defaultValue: '已复制项目路径' }), variant: 'success' }
      : { message: t('mainContent.pathCopyFailed', { defaultValue: '复制失败,请手动复制' }), variant: 'error' });
  };

  // 设计稿:顶栏正好 44px(含下边框,box-sizing 全局是 border-box)。高度写死而
  // 不是靠内边距凑 —— 标题、芯片、「…」三者高度不同,靠 padding 撑会随内容漂。
  // 移动端留 52px:那里还挤着菜单键与标签栏。
  return (
    <div className="pwa-header-safe flex h-[52px] flex-shrink-0 items-center border-b border-border bg-background px-3 sm:h-11 sm:px-5">
      <div className="flex w-full items-center gap-3">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <MainContentTitle
          activeTab={activeTab}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          isPersistentSession={resident || isPersistentSession}
          onRenameSession={onRenameSession}
        />

        {/* 移动端:顶部标签栏(桌面端由图标轨接管) */}
        <div className="min-w-0 flex-shrink-0 md:hidden">
          <MainContentTabSwitcher
            activeTab={activeTab}
            setActiveTab={setActiveTab}
          />
        </div>

        {showMenu && (
          <SessionActionsMenu
            isPersistent={resident}
            persistentBusy={residentBusy}
            onTogglePersistent={(next) => void handleTogglePersistent(next)}
            onExport={(options) => void handleExport(options)}
            isExporting={isExporting}
            projectPath={projectPath}
            onOpen={() => { if (sessionId) void refreshResident(sessionId); }}
            onCopyPath={() => void copyProjectPath()}
            onDelete={() => {
              if (sessionId) {
                onDeleteSession?.(sessionId, (selectedSession?.summary as string) || t('mainContent.newSession'));
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
