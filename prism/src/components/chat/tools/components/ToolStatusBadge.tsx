import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';

export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

/**
 * dv:标签走 i18n。这四个词此前写死英文,在全中文界面里就是四块英文补丁 ——
 * 而同一张工具卡上其余文案都是中文的。defaultValue 保留英文原文,漏译时行为不变。
 */
const STATUS_CONFIG: Record<ToolStatus, { i18nKey: string; fallback: string; className: string }> = {
  running: {
    i18nKey: 'toolStatus.running',
    fallback: 'Running',
    className: 'bg-primary/[0.08] text-card-foreground dark:text-primary',
  },
  completed: {
    i18nKey: 'toolStatus.completed',
    fallback: 'Completed',
    className: 'bg-primary/[0.08] text-card-foreground dark:text-primary',
  },
  error: {
    i18nKey: 'toolStatus.error',
    fallback: 'Error',
    className: 'bg-muted text-muted-foreground',
  },
  denied: {
    i18nKey: 'toolStatus.denied',
    fallback: 'Denied',
    className: 'bg-muted text-muted-foreground',
  },
};

interface ToolStatusBadgeProps {
  status: ToolStatus;
  className?: string;
}

export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const { t } = useTranslation('chat');
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {t(config.i18nKey, { defaultValue: config.fallback })}
    </span>
  );
}
