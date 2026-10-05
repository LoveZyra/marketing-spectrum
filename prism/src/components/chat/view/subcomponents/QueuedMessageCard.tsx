import { useTranslation } from 'react-i18next';
import { ArrowUpIcon, PencilIcon, XIcon } from 'lucide-react';

interface QueuedMessageCardProps {
  content: string;
  imageCount?: number;
  /** 省略即不显示铅笔 —— 服务端那条已经发出去了,没有"编辑"可言。 */
  onEdit?: () => void;
  onDelete: () => void;
  /**
   * ho:「立即发送」(send now)—— 不等这一轮结束,现在就插进去(模型在下一个工具间隙看到它)。
   * 省略即不显示(服务端那条、带图片的那条都不给)。
   */
  onSendNow?: () => void;
  /** 覆盖标题(默认「Queued」)。服务端排队用不同的措辞,以免和本地排队混淆。 */
  label?: string;
  hint?: string;
}

export default function QueuedMessageCard({ content, imageCount = 0, onEdit, onDelete, onSendNow, label, hint }: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[52.25rem] rounded-panel border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground dark:text-primary/70">
            <span>{label ?? t('input.queue.label', { defaultValue: 'Queued' })}</span>
            <span className="normal-case text-muted-foreground">
              · {hint ?? t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 break-words text-sm text-body">{content}</p>
          {imageCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {imageCount} {imageCount === 1 ? 'image' : 'images'} attached
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {onSendNow && (
            <button
              type="button"
              onClick={onSendNow}
              data-queue-action="send-now"
              title={t('input.queue.sendNowHint')}
              className="mr-1 inline-flex items-center gap-1 rounded-md border border-primary/30 bg-background px-2 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-primary/[0.08] dark:text-primary"
            >
              <ArrowUpIcon className="h-3.5 w-3.5" aria-hidden />
              {t('input.queue.sendNow')}
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
              title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
