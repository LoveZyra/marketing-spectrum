import type { AppTab } from '../../../../types/app';

/**
 * 非聊天页签的标题。
 *
 * 原来 files / notebook 之外一律回落到写死的 `'Project'` —— 于是中文界面下打开
 * 「定时任务」或「终端」,顶栏大写着一个英文 **Project**(2026-09-15 实测)。
 * 侧栏那排页签早就有 `tabs.*` 这组键、两个 locale 都全,直接用它就行。
 * files 继续用 `mainContent.projectFiles`(「项目文件」比「文件」更说得清)。
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
