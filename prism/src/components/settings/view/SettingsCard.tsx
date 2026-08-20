import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';

type SettingsCardProps = {
  children: ReactNode;
  className?: string;
  divided?: boolean;
};

export default function SettingsCard({ children, className, divided }: SettingsCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border',
        divided && 'divide-y divide-border',
        className,
      )}
    >
      {children}
    </div>
  );
}
