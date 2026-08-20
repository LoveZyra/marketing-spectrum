import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { copyTextToClipboard } from '../../../utils/clipboard';

const COPIED_RESET_MS = 1600;

export interface ClampedBlockProps {
  children: React.ReactNode;
  /** 超过这个高度才折叠(px)。内容不超高时,展开按钮根本不出现。 */
  maxHeight?: number;
  /** 展开提示里的行数,例如「展开全部 · 42 行」。不给就只写「展开全部」。 */
  lineCount?: number;
  /** 给了就在右上角显示复制按钮(悬停出现)。 */
  copyText?: string;
  className?: string;
  contentClassName?: string;
}

/**
 * 会自己判断"要不要折"的内容块。
 *
 * 折叠不加渐隐遮罩 —— 设计系统里没有渐变;超高就硬裁,底下给一行明确的
 * 「展开全部 · N 行」。内容不超高时不显示任何多余控件。
 */
export function ClampedBlock({
  children,
  maxHeight = 220,
  lineCount,
  copyText,
  className,
  contentClassName,
}: ClampedBlockProps) {
  const { t } = useTranslation('chat');
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = React.useState(false);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    // 只在收起状态下量:展开后 scrollHeight 本来就等于 clientHeight
    setOverflows(element.scrollHeight > maxHeight + 8);
  }, [children, maxHeight, isExpanded]);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!copyText) return;
    const ok = await copyTextToClipboard(copyText);
    if (ok) setCopied(true);
  };

  const clamped = overflows && !isExpanded;

  return (
    <div className={cn('group/clamp relative', className)}>
      <div
        ref={contentRef}
        className={cn(clamped && 'overflow-hidden', contentClassName)}
        style={clamped ? { maxHeight } : undefined}
      >
        {children}
      </div>

      {copyText && (
        <button
          type="button"
          onClick={() => { void handleCopy(); }}
          aria-label={t('details.copy', { defaultValue: '复制' })}
          title={copied ? t('details.copied', { defaultValue: '已复制' }) : t('details.copy', { defaultValue: '复制' })}
          className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-sm border border-border bg-background text-muted-foreground opacity-0 transition-colors hover:text-foreground focus-visible:opacity-100 group-hover/clamp:opacity-100"
        >
          {copied
            ? <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2} />
            : <Copy className="h-3.5 w-3.5" strokeWidth={2} />}
        </button>
      )}

      {overflows && (
        <button
          type="button"
          onClick={() => setIsExpanded((current) => !current)}
          aria-expanded={isExpanded}
          className="mt-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {isExpanded
            ? t('details.collapse', { defaultValue: '收起' })
            : lineCount
              ? t('details.expandAllWithCount', { defaultValue: '展开全部 · {{count}} 行', count: lineCount })
              : t('details.expandAll', { defaultValue: '展开全部' })}
        </button>
      )}
    </div>
  );
}

export default ClampedBlock;
