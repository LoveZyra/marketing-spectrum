import { X } from 'lucide-react';

import type { CodeEditorFile } from '../types/types';

type Props = {
  files: CodeEditorFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
};

/**
 * 编辑器标签条(F10)。
 *
 * 只在开着**两个以上**文件时出现 —— 一个标签的标签条只是白占一行高度,而侧栏
 * 编辑器本来就窄。
 *
 * 中键点击关闭(与浏览器、VS Code 一致);标签上的 ✕ 只在悬停或活动时显形,
 * 否则一排 ✕ 会把本来就短的文件名挤没。
 */
export default function EditorTabs({ files, activePath, onSelect, onClose }: Props) {
  if (files.length < 2) return null;

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-background px-1 py-0.5">
      {files.map((file) => {
        const isActive = file.path === activePath;
        return (
          <div
            key={file.path}
            role="tab"
            aria-selected={isActive}
            title={file.path}
            onClick={() => onSelect(file.path)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(file.path);
              }
            }}
            className={`group flex max-w-[180px] flex-shrink-0 cursor-pointer items-center gap-1 rounded-t px-2 py-1 text-xs transition-colors ${
              isActive
                ? 'border-b-2 border-primary bg-card font-medium text-foreground'
                : 'border-b-2 border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <span className="truncate">{file.name}</span>
            <button
              type="button"
              aria-label={`关闭 ${file.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(file.path);
              }}
              className={`rounded p-0.5 transition-opacity hover:bg-accent ${
                isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
              }`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
