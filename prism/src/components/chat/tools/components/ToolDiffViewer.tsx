import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

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
 * Compact diff for Edit / Write / ApplyPatch: a file header with a badge, then the
 * +/- lines (capped at MAX_RENDERED_DIFF_LINES).
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
  const { t } = useTranslation('chat');
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

  /** 单次渲染的 diff 行上限,超出部分用一行提示代替(原因见下方渲染处)。 */
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
          * 超长 diff 只渲染前 N 行:每行两个 `<span>`,展开一条写了上万行文件的 Write
          * 会一次生成几万个 DOM 节点,主线程卡住数秒以上。
          */}
        {hiddenDiffLineCount > 0 && (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            {t('details.diffHiddenLines', {
              count: hiddenDiffLineCount,
              defaultValue: '还有 {{count}} 行未显示 —— 完整内容请打开文件查看。',
            })}
          </div>
        )}
      </div>
    </div>
  );
};
