import React from 'react';

import { Markdown } from '../../../view/subcomponents/Markdown';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * Markdown body for tool details, in the chat's prose style.
 * Used by: PlanDisplay (ExitPlanMode) and the subagent `Task` input / result.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = 'mt-1 prose prose-sm max-w-none dark:prose-invert'
}) => {
  return (
    <Markdown className={className}>
      {content}
    </Markdown>
  );
};
