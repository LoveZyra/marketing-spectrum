import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangleIcon, History, RotateCcwIcon, XIcon, Loader2 } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';

import { RestoreForceDialog } from './ChangedFilesCard';
import type { RestoreBlockerPayload } from './ChangedFilesCard';

interface CheckpointMeta {
  id: string;
  createdAt: string;
  prompt?: string | null;
  head?: string;
  untrackedCount?: number;
  incomplete?: boolean;
  incompleteReason?: string | null;
  hasSubmodules?: boolean;
}

interface CheckpointHistoryPanelProps {
  sessionId: string | null;
  isProcessing: boolean;
  onClose: () => void;
  onReverted?: () => void;
}

/**
 * Slide-over drawer listing every git checkpoint for the session, newest
 * first, each restorable via the transactional rollback endpoint. Prism
 * feature — complements the per-turn ChangedFilesCard.
 */
export default function CheckpointHistoryPanel({
  sessionId,
  isProcessing,
  onClose,
  onReverted,
}: CheckpointHistoryPanelProps) {
  const { t } = useTranslation('chat');
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 409 refusal awaiting the user's force confirmation, tied to a checkpoint.
  const [restoreBlocker, setRestoreBlocker] = useState<
    { checkpointId: string; payload: RestoreBlockerPayload } | null
  >(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setCheckpoints([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await authenticatedFetch(
        `/api/checkpoints?sessionId=${encodeURIComponent(sessionId)}`,
      );
      const data = await response.json().catch(() => ({}));
      setCheckpoints(Array.isArray(data?.checkpoints) ? data.checkpoints : []);
    } catch {
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const performRestore = useCallback(async (checkpointId: string, force: boolean) => {
    setBusy(checkpointId);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/checkpoints/${checkpointId}/restore${force ? '?force=1' : ''}`,
        { method: 'POST' },
      );
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload?.code
        && (payload.code === 'COMMITS_AFTER_CHECKPOINT' || payload.code === 'CHECKPOINT_INCOMPLETE')) {
        setRestoreBlocker({ checkpointId, payload: payload as RestoreBlockerPayload });
        return;
      }
      if (response.status === 409 && payload?.code === 'DIRECTORY_BUSY') {
        setRestoreBlocker(null);
        setNotice(`⚠️ ${t('checkpoint.directoryBusy', {
          defaultValue: 'Another session ({{sessionId}}) is actively running in this directory. Stop it before rolling back.',
          sessionId: payload?.sessionId || '?',
        })}`);
        return;
      }
      if (!response.ok) throw new Error(payload?.error || `Restore failed (${response.status})`);
      setRestoreBlocker(null);
      let message = t('checkpoint.restored', { defaultValue: '✅ Rolled back to the pre-turn checkpoint.' });
      if (payload?.skippedUntrackedCleanup) {
        message += ` ${t('checkpoint.skippedUntrackedCleanup', {
          defaultValue: "Note: cleanup of newly created untracked files was skipped because this checkpoint's snapshot is incomplete.",
        })}`;
      }
      setNotice(message);
      onReverted?.();
    } catch (error) {
      setRestoreBlocker(null);
      setNotice(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [onReverted, t]);

  const handleRestore = useCallback(async (checkpoint: CheckpointMeta) => {
    const confirmText = t('checkpoint.restoreConfirm', {
      defaultValue: 'Roll the working tree back to before this turn? Staged, unstaged, and untracked files will all be restored.',
    });
    if (!window.confirm(confirmText)) return;
    await performRestore(checkpoint.id, false);
  }, [performRestore, t]);

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <History className="h-4 w-4 text-primary" />
          <h2 className="flex-1 text-sm font-medium text-foreground">
            {t('checkpoint.historyTitle', { defaultValue: '检查点历史' })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={t('checkpoint.dismiss', { defaultValue: 'Dismiss' })}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {notice && (
          <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">{notice}</div>
        )}

        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('checkpoint.loading', { defaultValue: '加载中…' })}
            </div>
          ) : checkpoints.length === 0 ? (
            <div className="px-2 py-10 text-center text-sm text-muted-foreground">
              {t('checkpoint.empty', { defaultValue: '本会话还没有检查点。每一轮改动会自动存档到这里。' })}
            </div>
          ) : (
            <ol className="space-y-2">
              {checkpoints.map((checkpoint, index) => (
                <li
                  key={checkpoint.id}
                  className="rounded-xl border border-border/70 bg-background/60 p-3"
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-primary">
                      {checkpoints.length - index}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">
                        {checkpoint.prompt?.trim()
                          || t('checkpoint.noPrompt', { defaultValue: '(无提示词)' })}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {formatTime(checkpoint.createdAt)}
                        {typeof checkpoint.untrackedCount === 'number' && checkpoint.untrackedCount > 0
                          ? ` · ${checkpoint.untrackedCount} ${t('checkpoint.untracked', { defaultValue: '个未跟踪文件' })}`
                          : ''}
                      </p>
                      {checkpoint.incomplete && (
                        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-orange-600 dark:text-orange-400">
                          <AlertTriangleIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
                          {t('checkpoint.incompleteBadge', { defaultValue: 'incomplete snapshot' })}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={isProcessing || busy !== null}
                      onClick={() => handleRestore(checkpoint)}
                      className="inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-lg border border-orange-300/60 bg-orange-50 px-2 text-[11px] font-medium text-orange-700 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25"
                    >
                      {busy === checkpoint.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcwIcon className="h-3 w-3" />
                      )}
                      {t('checkpoint.restore', { defaultValue: '回滚' })}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {restoreBlocker && (
        <RestoreForceDialog
          blocker={restoreBlocker.payload}
          busy={busy === restoreBlocker.checkpointId}
          onCancel={() => setRestoreBlocker(null)}
          onConfirm={() => { void performRestore(restoreBlocker.checkpointId, true); }}
        />
      )}
    </div>
  );
}
