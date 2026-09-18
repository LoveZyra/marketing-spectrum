import ReactDOM from 'react-dom';
import { AlertTriangle, EyeOff, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from './ui';

export type SessionDeleteTarget = {
  sessionId: string;
  sessionTitle: string;
  /** 已经在归档里 —— 只给「永久删除」,不再提供「归档」。 */
  isArchived?: boolean;
  /**
   * 当前用户能不能永久删除这条(判据见 `utils/sessionDeletePermission`)。
   *
   * `false` 时**不画**那枚红色「永久删除」按钮 —— 否则就是给用户一个必然撞
   * 403 的主按钮(2026-09-15 非 root 实测)。不传 = 老行为(画出来,服务端拦),
   * 这样没来得及接线的调用方不会因此少一个按钮。
   */
  canDeletePermanently?: boolean;
};

type Props = {
  target: SessionDeleteTarget | null;
  onCancel: () => void;
  /** hardDelete=false 归档、true 永久删除。 */
  onConfirm: (hardDelete: boolean) => void;
  t: TFunction;
};

/**
 * 会话删除确认。
 *
 * ef:从 `SidebarModals` 里抽出来 —— 顶栏「…」也有「删除会话」,而侧栏折叠时
 * `<Sidebar/>` 整棵都不渲染(它的弹窗跟着消失)。同一个对话框两处共用,
 * 文案与两档语义(归档 / 永久删除)只此一份。
 */
export default function SessionDeleteDialog({ target, onCancel, onConfirm, t }: Props) {
  if (!target) return null;

  const mayDelete = target.canDeletePermanently !== false;
  // 归档态 + 不能永久删除 = 这个框里一件事也做不了。与其给个空框,不如直接说清楚。
  const nothingToDo = Boolean(target.isArchived) && !mayDelete;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,16,16,0.72)] p-4">
      <div className="prism-modal-shadow w-full max-w-md overflow-hidden rounded-dialog border border-border bg-card">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="mb-2 text-lg font-semibold text-foreground">
                {t('deleteConfirmation.deleteSession')}
              </h3>
              <p className="mb-1 text-sm text-muted-foreground">
                {t('deleteConfirmation.confirmDelete')}{' '}
                <span className="font-medium text-foreground">
                  {target.sessionTitle || t('sessions.unnamed')}
                </span>
                ?
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                {target.isArchived
                  ? t('deleteConfirmation.archivedSessionNotice', 'This session is already archived. You can keep it hidden or delete it permanently.')
                  : t('deleteConfirmation.archiveSessionNotice', 'Archive keeps the session out of the active list while preserving its history.')}
              </p>
              {/* gk:永久删除 = 进「最近删除」,保留期内可恢复;只有项目负责人 / 管理员可以做。说在按钮上方,别让人以为是彻底销毁。 */}
              <p className="mt-2 text-xs text-muted-foreground">
                {mayDelete
                  ? t('deleteConfirmation.permanentDeleteNotice', '永久删除会把会话(含对话记录)移入「最近删除」,保留期内可由项目负责人恢复;只有项目负责人或管理员可以永久删除。')
                  : nothingToDo
                    ? t('deleteConfirmation.archivedAndCannotDelete', '这条会话已经在归档里。永久删除只有项目负责人或管理员能做,所以这里没有可执行的操作。')
                    : t('deleteConfirmation.cannotDeletePermanently', '你不是这个项目的负责人,所以只能归档 —— 归档后它从活跃列表里消失,记录都还在。')}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-border bg-card p-4">
          {!target.isArchived && (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => onConfirm(false)}
            >
              <EyeOff className="mr-2 h-4 w-4" />
              {t('deleteConfirmation.archiveSession', 'Archive session')}
            </Button>
          )}
          {mayDelete && (
            <Button
              variant="destructive"
              className="w-full justify-start bg-destructive text-destructive-foreground hover:bg-destructive"
              onClick={() => onConfirm(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}
            </Button>
          )}
          <Button variant="ghost" className="w-full" onClick={onCancel}>
            {nothingToDo ? t('actions.close', '关闭') : t('actions.cancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
