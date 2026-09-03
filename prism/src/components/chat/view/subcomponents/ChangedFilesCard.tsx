import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GitBranchIcon,
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
    <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-card px-3 py-2.5 font-mono text-[11px] leading-[17px]">
      {lines.map((line, index) => {
        const isAdd = line.startsWith('+') && !line.startsWith('+++');
        const isDel = line.startsWith('-') && !line.startsWith('---');
        // 增行给 8% 绿底 + 代码墨色;删行不用红底,只弱化 + 删除线
        const tone = isAdd
          ? 'bg-primary/8 text-code'
          : isDel
            ? 'text-muted-foreground line-through'
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
          <AlertTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden />
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
                <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-card p-2">
                  {(blocker.commits || []).map((commit) => (
                    <li key={commit.hash} className="flex items-baseline gap-2 text-[11px]">
                      <code className="flex-shrink-0 font-mono text-muted-foreground">
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
                <p className="text-xs font-medium text-foreground">
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

/** 超过这个文件数就默认收起 —— 再多就该点开看,而不是霸着屏幕。 */
const COLLAPSE_ABOVE = 3;

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
  // 文件一多,这块面板就长在输入框正上方顶掉半屏正文 —— 超过 3 个默认收起,
  // 抬头那一行(文件数 + 总增删 + 回滚)本来就把要紧的都说完了。
  const [collapsed, setCollapsed] = useState(() => (state.files || []).length > COLLAPSE_ABOVE);
  const [restoreBlocker, setRestoreBlocker] = useState<RestoreBlockerPayload | null>(null);
  const [metaFlags, setMetaFlags] = useState<CheckpointMetaFlags | null>(null);

  /**
   * dv:换了 checkpoint(= 新的一轮)就把卡内状态整体重置。
   *
   * 这张卡是**同一个组件实例**被新一轮的 state 复用的(ChatInterface 里位置
   * 固定),而 `revertedPaths`、`notice`、`collapsed`、`expandedPath`、
   * `restoreBlocker` 全是首渲染之后就不再跟着 props 走的本地 state。于是上一轮
   * 还原过 `a.md`、新一轮又改了 `a.md`,它在新卡里一上来就是"已还原"的灰条,
   * 点不动;上一轮的成功/失败提示("✅ 已回滚")也留在新卡上误导人;
   * 折叠状态按上一轮的文件数定,新一轮文件数变了也不重算。
   */
  const fileCount = (state.files || []).length;
  useEffect(() => {
    setRevertedPaths(new Set());
    setNotice(null);
    setExpandedPath(null);
    setRestoreBlocker(null);
    setBusy(null);
    setCollapsed(fileCount > COLLAPSE_ABOVE);
    // checkpointId 是一轮的身份;文件数只用来决定默认折叠,一并入依赖。
  }, [state.checkpointId, fileCount]);

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
    /**
     * 宽度对齐到**对话列**,不再横贯整屏。
     *
     * 消息列、输入框、待审批横幅、排队消息卡片这四处早就都是
     * `mx-auto max-w-[54.25rem]`,只有这块面板留着 `mx-3` —— 于是它比正下方的
     * 输入框宽出一大截,两条边界对不上,看着像另一个层的东西压在上面。
     * (ar 轮只收了高度,没碰宽度,所以那轮之后依然是这样。)
     *
     * ef:消息列是 `max-w-[54.25rem] px-4`(正文 836px);输入框、待审批横幅、排队卡片
     * 与这块面板的外壳自带 px-4,所以它们的盒子取 52.25rem(= 868 − 32),外边缘才和
     * 正文左右两边对齐 —— 以前四处都是 54.25rem,输入框比正文每边宽出 16px。
     * 这几处保持一致而不另起变量:形式统一比省一个数字重要。
     */
    <div className="mx-auto mb-2 w-full max-w-[52.25rem] overflow-hidden rounded-panel border border-border">
      {/* 标头(设计稿 2a/2b):分支图标 → 本轮改动 → 文件数 → 总增删 → ml-auto → ckpt → 回滚本轮 */}
      <div className="flex items-center gap-2.5 border-b border-border bg-card px-3.5 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          aria-expanded={!collapsed}
        >
          {collapsed
            ? <ChevronRightIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" strokeWidth={2} />
            : <ChevronDownIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" strokeWidth={2} />}
          <GitBranchIcon className="h-4 w-4 flex-shrink-0 text-primary" strokeWidth={2} />
          <span className="flex-shrink-0 text-xs font-semibold leading-4 text-card-foreground">
            {t('checkpoint.changedFilesTitle', { defaultValue: '本轮改动' })}
          </span>
          <span className="flex-shrink-0 font-mono text-[11px] text-muted-foreground">
            {t('checkpoint.changedFiles', {
              defaultValue: '{{count}} file(s) changed this turn',
              count: files.length,
            })}
          </span>
          {/* 淡色下绿色不做小字,改墨色;深色沿用强调绿 */}
          <span className="hidden flex-shrink-0 font-mono text-[11px] text-card-foreground dark:text-primary sm:inline">
            +{totalAdditions} −{totalDeletions}
          </span>
          {state.checkpointId && (
            <span className="ml-auto hidden flex-shrink-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">
              {`ckpt_${state.checkpointId.slice(-6)}`}
            </span>
          )}
        </button>

        {/* dp:明确的「接受」。改动在 agent 干活时就已实时写盘,从来不存在
            "待接受的暂存态" —— 语义上关掉这张卡就是接受。但此前"接受"只是
            右上角一个 × 图标,与两个写着字的撤销按钮(还原/回滚本轮)摆在
            一起,观感变成了"只能回滚"。给默认动作一个名字和主色。 */}
        <button
          type="button"
          // dq:还原/回滚正在进行时禁点 —— 那一瞬把卡收掉,操作还在后台跑,
          // 结果(成功刷新或失败提示)就没有地方显示了。
          disabled={busy !== null}
          onClick={onDismiss}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-[3px] text-[11.5px] text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          title={t('checkpoint.keepTitle', { defaultValue: '改动已实时写入磁盘;保留 = 收起这张卡,什么都不改' })}
        >
          <CheckIcon className="h-4 w-4" strokeWidth={2} />
          {t('checkpoint.keep', { defaultValue: '保留改动' })}
        </button>

        {state.checkpointId && (
          <button
            type="button"
            disabled={isProcessing || busy !== null}
            onClick={handleRestore}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-[3px] text-[11.5px] text-card-foreground transition-colors hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
            title={t('checkpoint.restoreTitle', { defaultValue: 'Transactional rollback to the pre-turn git checkpoint' })}
          >
            <RotateCcwIcon className="h-4 w-4" strokeWidth={2} />
            {busy === '__restore__'
              ? t('checkpoint.restoring', { defaultValue: 'Rolling back…' })
              : t('checkpoint.restore', { defaultValue: 'Roll back turn' })}
          </button>
        )}

        <button
          type="button"
          onClick={onDismiss}
          className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t('checkpoint.dismiss', { defaultValue: 'Dismiss' })}
        >
          <XIcon className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {(hasSubmodules || isIncomplete) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border px-3.5 py-1">
          {hasSubmodules && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <AlertTriangleIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
              {t('checkpoint.submoduleWarning', { defaultValue: 'Submodule changes are not covered by rollback.' })}
            </p>
          )}
          {isIncomplete && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <AlertTriangleIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
              {t('checkpoint.incompleteBadge', { defaultValue: 'incomplete snapshot' })}
            </p>
          )}
        </div>
      )}

      {notice && (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">{notice}</div>
      )}

      {!collapsed && (
        <div className="scrollbar-thin max-h-52 overflow-y-auto">
          {files.map((file, index) => {
            const reverted = revertedPaths.has(file.path);
            const expanded = expandedPath === file.path;
            const status = (file.status || 'modified').slice(0, 1).toUpperCase();
            // 淡色下 M 用墨色(绿色不在浅底做小字),A/D/R 一律弱化
            const statusTone = file.status === 'added' || file.status === 'deleted' || file.status === 'renamed'
              ? 'text-muted-foreground'
              : 'text-card-foreground dark:text-primary';
            return (
              <div key={file.path} className={index === files.length - 1 ? '' : 'border-b border-border'}>
                <div className="flex items-center gap-2.5 px-3.5 py-[5px]">
                  <button
                    type="button"
                    onClick={() => setExpandedPath(expanded ? null : file.path)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    aria-expanded={expanded}
                  >
                    <span className={`w-3.5 flex-none font-mono text-[11px] ${statusTone}`} title={file.status || 'modified'}>
                      {status}
                    </span>
                    <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${reverted ? 'text-muted-foreground line-through' : 'text-code'}`}>
                      {file.status === 'renamed' && file.oldPath
                        ? `${file.oldPath} → ${file.path}`
                        : file.path}
                    </span>
                    <span className="hidden flex-none font-mono text-[11px] text-muted-foreground sm:inline">
                      +{file.additions ?? '?'} −{file.deletions ?? '?'}
                    </span>
                  </button>

                  {file.revertible && !reverted && state.checkpointId && (
                    <button
                      type="button"
                      disabled={isProcessing || busy !== null}
                      onClick={() => handleRevertFile(file)}
                      className="flex-none text-[11.5px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      title={t('checkpoint.revertFileTitle', { defaultValue: 'Revert only this file to its pre-turn state' })}
                    >
                      {busy === file.path
                        ? t('checkpoint.reverting', { defaultValue: 'Reverting…' })
                        : t('checkpoint.revertFile', { defaultValue: 'Revert' })}
                    </button>
                  )}
                </div>

                {expanded && (
                  <div className="px-3.5 pb-2.5">
                    {file.status === 'renamed' && file.oldPath && (
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {t('checkpoint.renamedFrom', { defaultValue: 'renamed from {{path}}', path: file.oldPath })}
                      </p>
                    )}
                    {file.diff
                      ? <DiffView diff={file.diff} />
                      : (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t('checkpoint.diffUnavailable', { defaultValue: 'Diff unavailable (binary or truncated).' })}
                        </p>
                      )}
                  </div>
                )}
              </div>
            );
          })}
          {state.truncated && (
            <p className="border-t border-border px-3.5 py-1.5 text-[10px] text-muted-foreground">
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
