import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  History,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';

export interface ChangedFileEntry {
  path: string;
  /** Previous path when the file was renamed during the turn. */
  oldPath?: string;
  status?: string;
  additions?: number | null;
  deletions?: number | null;
  diff?: string | null;
  diffTruncated?: boolean;
  revertible?: boolean;
  untracked?: boolean;
}

export interface ChangedFilesState {
  checkpointId: string | null;
  files: ChangedFileEntry[];
  truncated?: boolean;
  /** Optional extras from the changes endpoint (may be absent over WS). */
  hasSubmodules?: boolean;
  incomplete?: boolean;
  incompleteReason?: string | null;
}

interface ChangedFilesCardProps {
  state: ChangedFilesState;
  isProcessing: boolean;
  onDismiss: () => void;
  /** Called after a successful rollback / file revert so the view can refresh. */
  onReverted?: () => void;
}

/** Refusal payload of a 409 restore response (force-confirmable codes). */
export interface RestoreBlockerPayload {
  code?: string;
  codes?: string[];
  commits?: Array<{ hash: string; subject: string }>;
  commitCount?: number;
  reason?: string | null;
  sessionId?: string;
  error?: string;
}

/** Subset of checkpoint metadata the card cares about (GET /api/checkpoints/:id). */
interface CheckpointMetaFlags {
  hasSubmodules?: boolean;
  incomplete?: boolean;
  incompleteReason?: string | null;
}

const FORCE_CONFIRMABLE_CODES = new Set(['COMMITS_AFTER_CHECKPOINT', 'CHECKPOINT_INCOMPLETE']);

function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split('\n'), [diff]);
  return (
    <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border/50 bg-muted/30 p-2 text-[11px] leading-relaxed">
      {lines.map((line, index) => {
        const tone = line.startsWith('+') && !line.startsWith('+++')
          ? 'text-green-600 dark:text-green-400'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'text-red-600 dark:text-red-400'
            : line.startsWith('@@')
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-muted-foreground';
        return (
          <div key={index} className={`whitespace-pre-wrap break-all ${tone}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Modal shown when the restore endpoint refuses with a force-confirmable 409
 * (commits made after the checkpoint, or an incomplete untracked snapshot).
 * Confirming retries the restore with force=1. Shared markup for both codes —
 * when the server reports both, the dialog lists both problems at once.
 */
export function RestoreForceDialog({
  blocker,
  busy,
  onCancel,
  onConfirm,
}: {
  blocker: RestoreBlockerPayload;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('chat');
  const codes = blocker.codes && blocker.codes.length > 0
    ? blocker.codes
    : blocker.code ? [blocker.code] : [];
  const hasCommits = codes.includes('COMMITS_AFTER_CHECKPOINT');
  const hasIncomplete = codes.includes('CHECKPOINT_INCOMPLETE');
  const title = hasCommits
    ? t('checkpoint.confirm.commitsTitle', { defaultValue: 'Commits were created after this checkpoint' })
    : t('checkpoint.confirm.incompleteTitle', { defaultValue: 'Checkpoint snapshot is incomplete' });

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogContent className="max-w-md p-4">
        <DialogTitle>{title}</DialogTitle>
        <div className="flex items-start gap-2">
          <AlertTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-orange-500" aria-hidden />
          <div className="min-w-0 flex-1 space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>

            {hasCommits && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  {t('checkpoint.confirm.commitsWarning', {
                    defaultValue: 'Rolling back will move the branch pointer back past {{count}} commit(s) made after this checkpoint. They will disappear from your branch (the safety checkpoint keeps them recoverable):',
                    count: blocker.commitCount ?? blocker.commits?.length ?? 0,
                  })}
                </p>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 bg-muted/30 p-2">
                  {(blocker.commits || []).map((commit) => (
                    <li key={commit.hash} className="flex items-baseline gap-2 text-[11px]">
                      <code className="flex-shrink-0 font-mono text-orange-600 dark:text-orange-400">
                        {commit.hash.slice(0, 7)}
                      </code>
                      <span className="truncate text-foreground">{commit.subject || '—'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hasIncomplete && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  {blocker.reason === 'untracked_bytes_budget'
                    ? t('checkpoint.confirm.incompleteReasonBudget', { defaultValue: "The untracked files exceeded the checkpoint's size budget, so not every file's content was saved." })
                    : t('checkpoint.confirm.incompleteReasonTooMany', { defaultValue: 'This turn had more untracked files than the checkpoint could record, so the snapshot does not list every file that existed.' })}
                </p>
                <p className="text-xs font-medium text-orange-600 dark:text-orange-400">
                  {t('checkpoint.confirm.incompleteSkipNote', { defaultValue: 'For safety, rolling back will NOT delete any untracked files; only tracked changes and saved snapshots will be restored.' })}
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="outline" className="h-8 px-3 text-xs" disabled={busy} onClick={onCancel}>
                {t('checkpoint.confirm.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button variant="destructive" className="h-8 px-3 text-xs" disabled={busy} onClick={onConfirm}>
                {busy
                  ? t('checkpoint.restoring', { defaultValue: 'Rolling back…' })
                  : t('checkpoint.confirm.forceRestore', { defaultValue: 'Roll back anyway' })}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Post-turn summary of files Claude changed, with per-file revert and a
 * transactional whole-turn rollback (git checkpoint, prism feature).
 */
export default function ChangedFilesCard({ state, isProcessing, onDismiss, onReverted }: ChangedFilesCardProps) {
  const { t } = useTranslation('chat');
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revertedPaths, setRevertedPaths] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [restoreBlocker, setRestoreBlocker] = useState<RestoreBlockerPayload | null>(null);
  const [metaFlags, setMetaFlags] = useState<CheckpointMetaFlags | null>(null);

  const files = state.files || [];
  const totalAdditions = files.reduce((sum, file) => sum + (file.additions || 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);

  // The WS payload only carries checkpointId/files/truncated, so warning flags
  // (submodules, incomplete snapshot) are fetched from the checkpoint meta.
  useEffect(() => {
    let cancelled = false;
    setMetaFlags(null);
    if (!state.checkpointId) return undefined;
    void (async () => {
      try {
        const response = await authenticatedFetch(`/api/checkpoints/${state.checkpointId}`);
        const payload = await response.json().catch(() => ({}));
        if (!cancelled && response.ok && payload?.checkpoint) {
          setMetaFlags(payload.checkpoint as CheckpointMetaFlags);
        }
      } catch { /* warnings are best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [state.checkpointId]);

  const hasSubmodules = Boolean(state.hasSubmodules || metaFlags?.hasSubmodules);
  const isIncomplete = Boolean(state.incomplete || metaFlags?.incomplete);

  const callApi = async (path: string, body?: Record<string, unknown>) => {
    const response = await authenticatedFetch(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || `Request failed (${response.status})`) as Error & {
        status?: number;
        payload?: RestoreBlockerPayload;
      };
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  };

  const performRestore = async (force: boolean) => {
    if (!state.checkpointId) return;
    setBusy('__restore__');
    setNotice(null);
    try {
      const payload = await callApi(
        `/api/checkpoints/${state.checkpointId}/restore${force ? '?force=1' : ''}`,
      );
      setRestoreBlocker(null);
      let message = t('checkpoint.restored', { defaultValue: '✅ Rolled back to the pre-turn checkpoint.' });
      if (payload?.skippedUntrackedCleanup) {
        message += ` ${t('checkpoint.skippedUntrackedCleanup', {
          defaultValue: "Note: cleanup of newly created untracked files was skipped because this checkpoint's snapshot is incomplete.",
        })}`;
      }
      setNotice(message);
      setRevertedPaths(new Set(files.map((file) => file.path)));
      onReverted?.();
    } catch (error) {
      const apiError = error as Error & { status?: number; payload?: RestoreBlockerPayload };
      const code = apiError.payload?.code;
      if (apiError.status === 409 && code && FORCE_CONFIRMABLE_CODES.has(code)) {
        setRestoreBlocker(apiError.payload || { code });
        return;
      }
      if (apiError.status === 409 && code === 'DIRECTORY_BUSY') {
        setRestoreBlocker(null);
        setNotice(`⚠️ ${t('checkpoint.directoryBusy', {
          defaultValue: 'Another session ({{sessionId}}) is actively running in this directory. Stop it before rolling back.',
          sessionId: apiError.payload?.sessionId || '?',
        })}`);
        return;
      }
      setRestoreBlocker(null);
      setNotice(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    if (!state.checkpointId) return;
    const confirmText = t('checkpoint.restoreConfirm', {
      defaultValue: 'Roll the working tree back to before this turn? Staged, unstaged, and untracked files will all be restored.',
    });
    if (!window.confirm(confirmText)) return;
    await performRestore(false);
  };

  const handleRevertFile = async (file: ChangedFileEntry) => {
    if (!state.checkpointId) return;
    setBusy(file.path);
    setNotice(null);
    try {
      await callApi(`/api/checkpoints/${state.checkpointId}/revert-file`, { path: file.path });
      setRevertedPaths((previous) => new Set([...previous, file.path]));
      setNotice(t('checkpoint.fileReverted', {
        defaultValue: '✅ Reverted {{path}}',
        path: file.path,
      }));
      onReverted?.();
    } catch (error) {
      const apiError = error as Error & { status?: number; payload?: RestoreBlockerPayload };
      if (apiError.status === 409 && apiError.payload?.code === 'DIRECTORY_BUSY') {
        setNotice(`⚠️ ${t('checkpoint.directoryBusy', {
          defaultValue: 'Another session ({{sessionId}}) is actively running in this directory. Stop it before rolling back.',
          sessionId: apiError.payload?.sessionId || '?',
        })}`);
        return;
      }
      setNotice(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  if (files.length === 0) return null;

  return (
    <div className="mx-3 mb-2 rounded-xl border border-border/70 bg-card/95 shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {collapsed
            ? <ChevronRightIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            : <ChevronDownIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
          <FileDiffIcon className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="truncate text-xs font-medium text-foreground">
            {t('checkpoint.changedFiles', {
              defaultValue: '{{count}} file(s) changed this turn',
              count: files.length,
            })}
          </span>
          <span className="hidden flex-shrink-0 text-[11px] text-muted-foreground sm:inline">
            <span className="text-green-600 dark:text-green-400">+{totalAdditions}</span>
            {' '}
            <span className="text-red-600 dark:text-red-400">−{totalDeletions}</span>
          </span>
        </button>

        {state.checkpointId && (
          <button
            type="button"
            disabled={isProcessing || busy !== null}
            onClick={handleRestore}
            className="inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-lg border border-orange-300/60 bg-orange-50 px-2 text-[11px] font-medium text-orange-700 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25"
            title={t('checkpoint.restoreTitle', { defaultValue: 'Transactional rollback to the pre-turn git checkpoint' })}
          >
            <History className="h-3 w-3" />
            {busy === '__restore__'
              ? t('checkpoint.restoring', { defaultValue: 'Rolling back…' })
              : t('checkpoint.restore', { defaultValue: 'Roll back turn' })}
          </button>
        )}

        <button
          type="button"
          onClick={onDismiss}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t('checkpoint.dismiss', { defaultValue: 'Dismiss' })}
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {(hasSubmodules || isIncomplete) && (
        <div className="flex flex-col gap-0.5 border-t border-border/50 px-3 py-1.5">
          {hasSubmodules && (
            <p className="flex items-center gap-1.5 text-[11px] text-orange-600 dark:text-orange-400">
              <AlertTriangleIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
              {t('checkpoint.submoduleWarning', { defaultValue: 'Submodule changes are not covered by rollback.' })}
            </p>
          )}
          {isIncomplete && (
            <p className="flex items-center gap-1.5 text-[11px] text-orange-600 dark:text-orange-400">
              <AlertTriangleIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
              {t('checkpoint.incompleteBadge', { defaultValue: 'incomplete snapshot' })}
            </p>
          )}
        </div>
      )}

      {notice && (
        <div className="border-t border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">{notice}</div>
      )}

      {!collapsed && (
        <div className="max-h-72 overflow-y-auto border-t border-border/50 px-2 py-1.5">
          {files.map((file) => {
            const reverted = revertedPaths.has(file.path);
            const expanded = expandedPath === file.path;
            return (
              <div key={file.path} className="rounded-lg px-1 py-0.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setExpandedPath(expanded ? null : file.path)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-accent/60"
                  >
                    {expanded
                      ? <ChevronDownIcon className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                      : <ChevronRightIcon className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
                    <span className={`truncate font-mono text-[11px] ${reverted ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                      {file.status === 'renamed' && file.oldPath
                        ? `${file.oldPath} → ${file.path}`
                        : file.path}
                    </span>
                    <span className={`flex-shrink-0 rounded px-1 text-[10px] uppercase ${
                      file.status === 'added'
                        ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                        : file.status === 'deleted'
                          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                          : file.status === 'renamed'
                            ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                            : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    }`}
                    >
                      {file.status || 'modified'}
                    </span>
                    <span className="hidden flex-shrink-0 text-[10px] text-muted-foreground sm:inline">
                      <span className="text-green-600 dark:text-green-400">+{file.additions ?? '?'}</span>
                      {' '}
                      <span className="text-red-600 dark:text-red-400">−{file.deletions ?? '?'}</span>
                    </span>
                  </button>

                  {file.revertible && !reverted && state.checkpointId && (
                    <button
                      type="button"
                      disabled={isProcessing || busy !== null}
                      onClick={() => handleRevertFile(file)}
                      className="inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      title={t('checkpoint.revertFileTitle', { defaultValue: 'Revert only this file to its pre-turn state' })}
                    >
                      <RotateCcwIcon className="h-3 w-3" />
                      {busy === file.path
                        ? t('checkpoint.reverting', { defaultValue: 'Reverting…' })
                        : t('checkpoint.revertFile', { defaultValue: 'Revert' })}
                    </button>
                  )}
                </div>

                {expanded && file.status === 'renamed' && file.oldPath && (
                  <p className="mt-0.5 px-1 font-mono text-[10px] text-muted-foreground">
                    {t('checkpoint.renamedFrom', { defaultValue: 'renamed from {{path}}', path: file.oldPath })}
                  </p>
                )}
                {expanded && file.diff && <DiffView diff={file.diff} />}
                {expanded && !file.diff && (
                  <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                    {t('checkpoint.diffUnavailable', { defaultValue: 'Diff unavailable (binary or truncated).' })}
                  </p>
                )}
              </div>
            );
          })}
          {state.truncated && (
            <p className="px-2 py-1 text-[10px] text-muted-foreground">
              {t('checkpoint.truncated', { defaultValue: 'Some diffs were truncated due to size limits.' })}
            </p>
          )}
        </div>
      )}

      {restoreBlocker && (
        <RestoreForceDialog
          blocker={restoreBlocker}
          busy={busy === '__restore__'}
          onCancel={() => setRestoreBlocker(null)}
          onConfirm={() => { void performRestore(true); }}
        />
      )}
    </div>
  );
}
