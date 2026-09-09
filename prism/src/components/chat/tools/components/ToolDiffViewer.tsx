import React, { useMemo } from 'react';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface ToolDiffViewerProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileClick?: () => void;
  badge?: string;
  badgeColor?: 'gray' | 'green';
}

/**
 * Compact diff viewer — VS Code-style
 */
export const ToolDiffViewer: React.FC<ToolDiffViewerProps> = ({
  oldContent,
  newContent,
  filePath,
  createDiff,
  onFileClick,
  badge = 'Diff',
  badgeColor = 'gray'
}) => {
  const badgeClasses = badgeColor === 'green'
    ? 'bg-primary/[0.08] text-card-foreground dark:text-primary'
    : 'bg-muted text-muted-foreground';

  const diffLines = useMemo(
    () => {
      if (oldContent === undefined || newContent === undefined) {
        return [];
      }
      return createDiff(oldContent, newContent)
    },
    [createDiff, oldContent, newContent]
  );

  /** fj:单次渲染的 diff 行上限 —— 超出的用一行提示代替(见下面的说明)。 */
  const MAX_RENDERED_DIFF_LINES = 500;
  const visibleDiffLines = diffLines.length > MAX_RENDERED_DIFF_LINES
    ? diffLines.slice(0, MAX_RENDERED_DIFF_LINES)
    : diffLines;
  const hiddenDiffLineCount = diffLines.length - visibleDiffLines.length;

  return (
    <div className="overflow-hidden rounded border border-border">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-muted px-2.5 py-1">
        {onFileClick ? (
          <button
            onClick={onFileClick}
            className="cursor-pointer truncate font-mono text-[11px] text-foreground transition-colors hover:text-primary dark:text-primary"
          >
            {filePath}
          </button>
        ) : (
          <span className="truncate font-mono text-[11px] text-body">
            {filePath}
          </span>
        )}
        <span className={`rounded px-1.5 py-px text-[10px] font-medium ${badgeClasses} ml-2 flex-shrink-0`}>
          {badge}
        </span>
      </div>

      {/* Diff lines */}
      <div className="font-mono text-[11px] leading-[18px]">
        {visibleDiffLines.map((diffLine, i) => (
          <div key={i} className="flex">
            <span
              className={`w-6 flex-shrink-0 select-none text-center ${
                diffLine.type === 'removed'
                  ? 'text-muted-foreground'
                  : 'bg-primary/8 text-code'
              }`}
            >
              {diffLine.type === 'removed' ? '-' : '+'}
            </span>
            <span
              className={`flex-1 whitespace-pre-wrap px-2 ${
                diffLine.type === 'removed'
                  ? 'text-muted-foreground line-through'
                  : 'bg-primary/8 text-code'
              }`}
            >
              {diffLine.content}
            </span>
          </div>
        ))}
        {/*
          * fj:超长 diff 只渲染前 N 行。
          *
          * 这里原来是无上限的 `diffLines.map`,每行两个 `<span>`;而
          * `defaultOpen: false` 只是 CSS(`CollapsibleContent` 永远渲染 children),
          * 所以点开一条写了几千上万行文件的 Write,一次点击就生成几万个 DOM
          * 节点,主线程冻住数秒到数十秒。
          */}
        {hiddenDiffLineCount > 0 && (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            还有 {hiddenDiffLineCount} 行未显示 —— 完整内容请打开文件查看。
          </div>
        )}
      </div>
    </div>
  );
};
