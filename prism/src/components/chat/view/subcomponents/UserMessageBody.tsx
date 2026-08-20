import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Link as LinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { splitAttachedDocuments } from '../../utils/attachedDocuments';

type UserMessageBodyProps = {
  content: string;
};

function formatChars(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

/**
 * prism: the text of a user turn, with content attachments folded away.
 *
 * The transcript stores the prompt and its attachments as one string, so a
 * turn that attached a parsed PDF would otherwise render the whole extracted
 * document inside the chat bubble. Each attachment collapses to a one-line
 * chip that expands on click — the text is still there, it just no longer
 * buries the sentence the person actually wrote.
 */
export default function UserMessageBody({ content }: UserMessageBodyProps) {
  const { t } = useTranslation('chat');
  const segments = useMemo(() => splitAttachedDocuments(content), [content]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const toggle = (index: number) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return (
            <div
              key={index}
              dir="auto"
              className="whitespace-pre-wrap break-words"
            >
              {segment.text}
            </div>
          );
        }

        const isOpen = expanded.has(index);
        const Icon = segment.source === 'url' ? LinkIcon : FileText;
        return (
          <div key={index} className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => toggle(index)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {isOpen
                ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
                : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
              <Icon className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate">{segment.name}</span>
              <span className="flex-shrink-0">
                {formatChars(segment.text.length)}
                {segment.truncated
                  ? ` · ${t('attachments.truncated', { defaultValue: 'truncated' })}`
                  : ''}
              </span>
            </button>
            {isOpen && (
              <div
                dir="auto"
                className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-border px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
              >
                {segment.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
