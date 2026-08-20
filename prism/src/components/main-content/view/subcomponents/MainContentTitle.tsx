import { useTranslation } from 'react-i18next';

import type { AppTab, Project, ProjectSession } from '../../../../types/app';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
};

function getTabTitle(activeTab: AppTab, t: (key: string) => string) {
  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'notebook') {
    return 'JupyterLab';
  }

  return 'Project';
}

// Cursor sessions were titled from `name`; Claude sessions only carry a summary.
function getSessionTitle(session: ProjectSession): string {
  return (session.summary as string) || 'New Session';
}

/**
 * 顶栏标题块(设计稿 2a / 2b):
 * 第一行 15px / 600 / 21px 的标题,第二行等宽 11px / 16px 的坐标
 * ——「项目 · 路径 · 会话短 id」,上边距 3px。两行都单行省略。
 */
export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
}: MainContentTitleProps) {
  const { t } = useTranslation();

  const title = activeTab === 'chat'
    ? (selectedSession ? getSessionTitle(selectedSession) : t('mainContent.newSession'))
    : getTabTitle(activeTab, t);

  const projectPath = selectedProject.fullPath || selectedProject.path || '';
  const coordinates = [
    selectedProject.displayName,
    projectPath,
    selectedSession?.id ? `sess_${String(selectedSession.id).slice(-6)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="min-w-0 flex-1">
      <h2 title={title} className="truncate text-[15px] font-semibold leading-[21px] text-foreground">
        {title}
      </h2>
      <div title={coordinates} className="mt-[3px] truncate font-mono text-[11px] leading-4 text-muted-foreground">
        {coordinates}
      </div>
    </div>
  );
}
