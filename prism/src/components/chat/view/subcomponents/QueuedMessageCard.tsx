import { useTranslation } from 'react-i18next';
import { PencilIcon, XIcon } from 'lucide-react';

interface QueuedMessageCardProps {
  content: string;
  imageCount?: number;
  /** 省略即不显示铅笔 —— 服务端那条已经发出去了,没有"编辑"可言。 */
  onEdit?: () => void;
  onDelete: () => void;
  /** 覆盖标题(默认「Queued」)。服务端排队用不同的措辞,以免和本地排队混淆。 */
  label?: string;
  hint?: string;
}

export default function QueuedMessageCard({ content, imageCount = 0, onEdit, onDelete, label, hint }: QueuedMessageCardProps) {
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
