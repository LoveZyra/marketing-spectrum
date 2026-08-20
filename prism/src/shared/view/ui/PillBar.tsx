import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

/* ── Container ─────────────────────────────────────────────────── */
type PillBarProps = {
  children: ReactNode;
  className?: string;
};

export function PillBar({ children, className }: PillBarProps) {
  return (
    <div className={cn('inline-flex items-center gap-[2px] rounded-md bg-muted p-[3px]', className)}>
      {children}
    </div>
  );
}

/* ── Individual pill button ────────────────────────────────────── */
type PillProps = {
  isActive: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
};

export function Pill({ isActive, onClick, children, className }: PillProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex touch-manipulation items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'border border-border bg-card text-foreground'
          : 'border border-transparent text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}
