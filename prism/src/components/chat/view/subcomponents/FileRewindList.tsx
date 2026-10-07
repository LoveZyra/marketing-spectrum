import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, RotateCcwIcon, Search } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import { uiLocale } from '../../../../utils/uiLocale';
import type { FileRewindTurn } from '../../utils/fileRewind';

/**
 * 非 git 目录的「撤销这一轮之后的文件改动」(CLI 文件检查点)。
 *
 * git 仓库里每轮有 Prism 自己的 git 检查点;非 git 工作区靠这里回退。
 * 按轮列出,先「预览」(dryRun:会动哪些文件、增删多少行),确认后再真退。
 * 覆盖面:Claude 用 Write / Edit 碰过的文件(之后又被 Bash 改了也算)和新建的文件;
 * 只被 Bash 动过、从没经过文件工具的文件不在内。
 */
type Preview = { files: string[]; insertions: number; deletions: number };
type RewindResponse = { ok?: boolean; reason?: string; error?: string; files?: string[]; insertions?: number; deletions?: number };

type Props = {
  sessionId: string;
  turns: FileRewindTurn[];
  isProcessing: boolean;
  onReverted?: () => void;
};

export default function FileRewindList({ sessionId, turns, isProcessing, onReverted }: Props) {
  const { t } = useTranslation('chat');
  const [busy, setBusy] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const call = async (turnUuid: string, dryRun: boolean): Promise<RewindResponse> => {
    const response = await authenticatedFetch(
      `/api/providers/claude/sessions/${encodeURIComponent(sessionId)}/runtime/rewind-files`,
      { method: 'POST', body: JSON.stringify({ turnUuid, dryRun }) },
    );
    const body = (await response.json().catch(() => ({}))) as RewindResponse;
    // 409:在跑 / 终端接管中 / 同目录别的会话在跑 —— 服务端带着 reason 与一句原因
    if (response.status === 409) return { ok: false, reason: body.reason || 'busy', error: body.error };
    return body;
  };

  const reasonText = (body: RewindResponse): string => {
    if (body.reason === 'not_enabled') return t('fileRewind.notEnabled');
    if (body.reason === 'busy') return t('fileRewind.busy');
    if (body.reason === 'not_resident') return t('fileRewind.notResident');
    return body.error || body.reason || t('fileRewind.failed');
  };

  const preview = async (turn: FileRewindTurn) => {
    setBusy(turn.turnUuid);
    setNotice(null);
    try {
      const body = await call(turn.turnUuid, true);
      if (!body.ok) {
        setNotice(`⚠️ ${reasonText(body)}`);
        return;
      }
      setPreviews((current) => ({
        ...current,
        [turn.turnUuid]: { files: body.files ?? [], insertions: body.insertions ?? 0, deletions: body.deletions ?? 0 },
      }));
    } catch (error) {
      setNotice(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const rewind = async (turn: FileRewindTurn) => {
    if (!window.confirm(t('fileRewind.confirm'))) return;
    setBusy(turn.turnUuid);
    setNotice(null);
    try {
      const body = await call(turn.turnUuid, false);
      if (!body.ok) {
        setNotice(`⚠️ ${reasonText(body)}`);
        return;
      }
      setPreviews({});
      setNotice(t('fileRewind.done'));
      onReverted?.();
    } catch (error) {
      setNotice(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(uiLocale());
    } catch {
      return iso;
    }
  };

  return (
    <div data-file-rewind="list">
      <p className="mb-2 px-1 text-[11.5px] leading-5 text-muted-foreground">{t('fileRewind.intro')}</p>
      {notice && <p className="mb-2 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground">{notice}</p>}
      <ol className="space-y-2">
        {turns.map((turn, index) => {
          const shown = previews[turn.turnUuid];
          return (
            <li key={turn.turnUuid} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-medium text-foreground dark:text-primary">
                  {turns.length - index}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{turn.prompt || t('checkpoint.noPrompt', { defaultValue: '(无提示词)' })}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{formatTime(turn.timestamp)}</p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={isProcessing || busy !== null}
                    onClick={() => void preview(turn)}
                    className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Search className="h-3 w-3" />
                    {t('fileRewind.preview')}
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing || busy !== null || !shown || shown.files.length === 0}
                    onClick={() => void rewind(turn)}
                    title={!shown ? t('fileRewind.previewFirst') : undefined}
                    className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-muted px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcwIcon className="h-3 w-3" />
                    {t('fileRewind.rewind')}
                  </button>
                </div>
              </div>
              {shown && (
                <div className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
                  {shown.files.length === 0 ? (
                    <p>{t('fileRewind.nothing')}</p>
                  ) : (
                    <>
                      <p className="mb-1">{t('fileRewind.summary', { count: shown.files.length, insertions: shown.insertions, deletions: shown.deletions })}</p>
                      <ul className="space-y-0.5">
                        {shown.files.slice(0, 20).map((file) => (
                          <li key={file} className="flex items-center gap-1 truncate font-mono" title={file}>
                            <FileText className="h-3 w-3 shrink-0" aria-hidden />
                            {file}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
