import ReactDOM from 'react-dom';
import { AlertTriangle, EyeOff, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from './ui';

export type SessionDeleteTarget = {
  sessionId: string;
  sessionTitle: string;
  /** 已经在归档里 —— 只给「永久删除」,不再提供「归档」。 */
  isArchived?: boolean;
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
          <Button
            variant="destructive"
            className="w-full justify-start bg-destructive text-destructive-foreground hover:bg-destructive"
            onClick={() => onConfirm(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}
          </Button>
          <Button variant="ghost" className="w-full" onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
