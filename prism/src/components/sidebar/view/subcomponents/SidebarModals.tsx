import { lazy, Suspense, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, EyeOff, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import SessionDeleteDialog from '../../../../shared/view/SessionDeleteDialog';
import type { DeleteProjectConfirmation, SessionDeleteConfirmation } from '../../types/types';
import { ModalLoadingFallback } from '../../../../shared/view/LazyPanel';

/**
 * 侧栏自己的弹窗。
 *
 * **设置弹窗不在这里** —— 它搬去了 `settings/view/SettingsModalHost`,挂在应用外层。
 * 原因是侧栏折叠时 `AppContent` 压根不渲染 `<Sidebar/>`,而设置的三个入口
 * (轨上的齿轮、命令面板、主区)全在侧栏之外:住在这里等于"折叠后按了没反应"。
 *
 * 留在这里的三个弹窗唯一入口都在侧栏内部,侧栏没渲染时本来也点不到。
 */
const ProjectCreationWizard = lazy(() => import('../../../project-creation-wizard/ProjectCreationWizard'));

type SidebarModalsProps = {
  showNewProject: boolean;
  onCloseNewProject: () => void;
  onProjectCreated: () => void;
  deleteConfirmation: DeleteProjectConfirmation | null;
  onCancelDeleteProject: () => void;
  onConfirmDeleteProject: (deleteData?: boolean) => void;
  sessionDeleteConfirmation: SessionDeleteConfirmation | null;
  onCancelDeleteSession: () => void;
  onConfirmDeleteSession: (hardDelete?: boolean) => void;
  t: TFunction;
};

export default function SidebarModals({
  showNewProject,
  onCloseNewProject,
  onProjectCreated,
  deleteConfirmation,
  onCancelDeleteProject,
  onConfirmDeleteProject,
  sessionDeleteConfirmation,
  onCancelDeleteSession,
  onConfirmDeleteSession,
  t,
}: SidebarModalsProps) {
  // 空闲时预取新建项目向导的代码块,免得第一次点开先闪一下 fallback 遮罩。
  useEffect(() => {
    let cancelled = false;
    const prefetch = () => {
      if (cancelled) return;
      void import('../../../project-creation-wizard/ProjectCreationWizard');
    };
    const scheduler = window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timerId: number | null = null;
    if (typeof scheduler.requestIdleCallback === 'function') {
      idleId = scheduler.requestIdleCallback(prefetch);
    } else {
      timerId = window.setTimeout(prefetch, 1500);
    }
    return () => {
      cancelled = true;
      if (idleId !== null && typeof scheduler.cancelIdleCallback === 'function') {
        scheduler.cancelIdleCallback(idleId);
      }
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  return (
    <>
      {showNewProject &&
        ReactDOM.createPortal(
          <Suspense fallback={<ModalLoadingFallback />}>
            <ProjectCreationWizard
              onClose={onCloseNewProject}
              onProjectCreated={onProjectCreated}
            />
          </Suspense>,
          document.body,
        )}

      {deleteConfirmation &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,16,16,0.72)] p-4">
            <div className="prism-modal-shadow w-full max-w-md overflow-hidden rounded-dialog border border-border bg-card">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-muted">
                    <AlertTriangle className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteProject')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('deleteConfirmation.confirmDelete')}{' '}
                      <span className="font-medium text-foreground">
                        {deleteConfirmation.project.displayName || deleteConfirmation.project.projectId}
                      </span>
                      ?
                    </p>
                    {deleteConfirmation.sessionCount > 0 && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('deleteConfirmation.sessionCount', { count: deleteConfirmation.sessionCount })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-card p-4">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onConfirmDeleteProject(false)}
                >
                  <EyeOff className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.archiveProject', 'Archive project')}
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-destructive text-destructive-foreground hover:bg-destructive"
                  onClick={() => onConfirmDeleteProject(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteAllData')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeleteProject}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* ef:会话删除确认抽成 shared/view/SessionDeleteDialog —— 顶栏「…」也用它。 */}
      <SessionDeleteDialog
        target={sessionDeleteConfirmation
          ? {
            sessionId: sessionDeleteConfirmation.sessionId,
            sessionTitle: sessionDeleteConfirmation.sessionTitle,
            isArchived: sessionDeleteConfirmation.isArchived,
          }
          : null}
        onCancel={onCancelDeleteSession}
        onConfirm={(hardDelete) => onConfirmDeleteSession(hardDelete)}
        t={t}
      />

    </>
  );
}
