import React from 'react';

import { ClampedBlock, Collapsible, CollapsibleTrigger, CollapsibleContent } from '../../../../shared/view/ui';

import { CollapsibleSection } from './CollapsibleSection';
import { JsonView } from './ContentRenderers/JsonView';

interface CollapsibleDisplayProps {
  toolName: string;
  toolId?: string;
  title: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  badge?: React.ReactNode;
  onTitleClick?: () => void;
  children: React.ReactNode;
  showRawParameters?: boolean;
  rawContent?: string;
  className?: string;
  toolCategory?: string;
}

const borderColorMap: Record<string, string> = {
  edit: 'border-l-primary',
  search: 'border-l-border',
  bash: 'border-l-primary',
  todo: 'border-l-border',
  task: 'border-l-border',
  agent: 'border-l-border',
  plan: 'border-l-primary',
  question: 'border-l-primary',
  default: 'border-l-border',
};

export const CollapsibleDisplay: React.FC<CollapsibleDisplayProps> = ({
  toolName,
  title,
  defaultOpen = false,
  action,
  badge,
  onTitleClick,
  children,
  showRawParameters = false,
  rawContent,
  className = '',
  toolCategory,
}) => {
  const borderColor = borderColorMap[toolCategory || 'default'] || borderColorMap.default;

  return (
    <div className={`border-l-2 ${borderColor} my-1 py-0.5 pl-3 ${className}`}>
      <CollapsibleSection
        title={title}
        toolName={toolName}
        open={defaultOpen}
        action={action}
        badge={badge}
        onTitleClick={onTitleClick}
      >
        {children}

        {showRawParameters && rawContent && (
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
              <svg
                className="h-2.5 w-2.5 flex-shrink-0 transition-transform duration-150 data-[state=open]:rotate-90"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              raw params
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ClampedBlock
                className="mt-1"
                maxHeight={200}
                copyText={rawContent}
                contentClassName="rounded-md border border-border bg-card px-3 py-2"
              >
                <JsonView text={rawContent} />
              </ClampedBlock>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CollapsibleSection>
    </div>
  );
};
