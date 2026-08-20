import { cn } from '../../../../lib/utils';

export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

const STATUS_CONFIG: Record<ToolStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-primary/[0.08] text-card-foreground dark:text-primary',
  },
  completed: {
    label: 'Completed',
    className: 'bg-primary/[0.08] text-card-foreground dark:text-primary',
  },
  error: {
    label: 'Error',
    className: 'bg-muted text-muted-foreground',
  },
  denied: {
    label: 'Denied',
    className: 'bg-muted text-muted-foreground',
  },
};

interface ToolStatusBadgeProps {
  status: ToolStatus;
  className?: string;
}

export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  );
}
