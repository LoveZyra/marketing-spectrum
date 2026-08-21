import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Shimmer } from '../../../../shared/view/ui';
import type { MainContentStateViewProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';

const TAB_LABEL_KEY: Record<string, string> = {
  chat: 'tabs.chat',
  shell: 'tabs.shell',
  files: 'tabs.files',
  notebook: 'tabs.notebook',
};

export default function MainContentStateView({ mode, isMobile, onMenuClick, activeTab }: MainContentStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';
  /**
   * 没选项目时,四个页签渲染的都是这块空态 —— 点了终端 / 文件 / notebook,
   * 轨上的图标亮了,主区却一动不动,读起来就是"点了没反应"。
   * 这里把用户刚点的那个页签名说出来:点是点到了,缺的是一个项目。
   * 聊天是默认页签,不额外提示,免得刚进来就先看到一句多余的话。
   */
  const pendingTabLabel = activeTab && activeTab !== 'chat'
    ? t(TAB_LABEL_KEY[activeTab] ?? '', { defaultValue: '' })
    : '';

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 border-b border-border bg-background p-2 sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          {/* 设计系统不用 spinner:加载态是一行会呼吸的文字,不是转圈 */}
          <div className="text-center">
            <Shimmer as="h2" className="mb-1 text-lg font-semibold">
              {t('mainContent.loading')}
            </Shimmer>
            <p className="text-sm text-muted-foreground">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-lg bg-muted">
              <Folder className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
              {pendingTabLabel
                ? t('mainContent.tabNeedsProject', {
                    tab: pendingTabLabel,
                    defaultValue: '「{{tab}}」需要先选一个项目 —— 从左侧选一个就会打开。',
                  })
                : t('mainContent.selectProjectDescription')}
            </p>
            <div className="rounded-md border border-border p-3.5">
              {/* 浅色模式下绿色不做小字(#10b981 配白底仅 2.6:1),只在深色里用绿 */}
              <p className="text-sm text-body dark:text-primary">
                <strong>{t('mainContent.tip')}:</strong> {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
