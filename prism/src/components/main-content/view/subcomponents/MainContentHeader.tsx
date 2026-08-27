import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../../../../shared/view/ui';
import { downloadSessionExport, type SessionExportOptions } from '../../../../utils/session-export';
import SessionExportMenu from '../../../../shared/view/SessionExportMenu';
import type { MainContentHeaderProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';

/**
 * 主区顶栏(设计稿 2a / 2b)。桌面端的标签切换已移到左侧图标轨(AppRail),
 * 这里只留标题块 + 右侧两个元素:常驻会话胶囊与导出;移动端保留顶部标签栏。
 *
 * 稿子规格:发丝线下边框、内边距 12px 20px、元素间距 16px。
 */
export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  isMobile,
  onMenuClick,
  isPersistentSession = false,
}: MainContentHeaderProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  const showExport = activeTab === 'chat' && Boolean(selectedSession);
  const showPersistentPill = !isMobile && activeTab === 'chat' && Boolean(selectedSession) && isPersistentSession;

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

  return (
    <div className="pwa-header-safe flex-shrink-0 border-b border-border bg-background px-3 py-2.5 sm:px-5 sm:py-3">
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
          />
        </div>

        {/* 移动端:顶部标签栏(桌面端由图标轨接管) */}
        <div className="min-w-0 flex-shrink-0 md:hidden">
          <MainContentTabSwitcher
            activeTab={activeTab}
            setActiveTab={setActiveTab}
          />
        </div>

        {/* 常驻会话胶囊:淡色下文字走墨色 —— 绿色不在浅底做小字 */}
        {showPersistentPill && (
          <span
            className="hidden flex-shrink-0 items-center gap-1.5 rounded-full border border-primary/40 px-2.5 py-1 text-xs text-foreground dark:border-primary/[0.32] dark:text-primary md:inline-flex"
            title={t('mainContent.persistentSessionHint', {
              defaultValue: '这段对话在服务端挂着常驻运行时,下一轮无需重建进程',
            })}
          >
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" aria-hidden />
            {t('mainContent.persistentSession', { defaultValue: '常驻会话' })}
          </span>
        )}

        {/* 桌面端右侧动作:导出(F12 起点开选格式) */}
        {!isMobile && showExport && (
          <SessionExportMenu onExport={(options) => void handleExport(options)}>
            {({ onClick, ref }) => (
              <button
                ref={ref}
                type="button"
                onClick={onClick}
                disabled={isExporting}
                className="hidden flex-shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-card-foreground transition-colors hover:border-border-strong hover:bg-card active:translate-y-px disabled:opacity-60 md:inline-flex"
              >
                {isExporting
                  ? t('mainContent.exporting', { defaultValue: '导出中…' })
                  : t('mainContent.export')}
              </button>
            )}
          </SessionExportMenu>
        )}
      </div>
    </div>
  );
}
