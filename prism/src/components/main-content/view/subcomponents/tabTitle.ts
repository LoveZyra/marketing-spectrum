import type { AppTab } from '../../../../types/app';

/**
 * 非聊天页签的顶栏标题:复用页签自己的 `tabs.*` 键(各 locale 都齐全)。
 * files 用 `mainContent.projectFiles`(「项目文件」比「文件」说得清);notebook 显示产品名 JupyterLab。
 */
export function getTabTitle(activeTab: AppTab, t: (key: string, fallback: string) => string) {
  if (activeTab === 'files') {
    return t('mainContent.projectFiles', '项目文件');
  }

  if (activeTab === 'notebook') {
    return 'JupyterLab';
  }

  return t(`tabs.${activeTab}`, activeTab);
}
