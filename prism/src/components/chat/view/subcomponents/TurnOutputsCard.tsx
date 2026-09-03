import { useState } from 'react';
import { Download, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import type { TurnOutputFile } from '../../utils/turnOutputs';

import FileTypeIcon from './FileTypeIcon';

type Props = {
  files: TurnOutputFile[];
  onFileOpen?: (filePath: string) => void;
  /**
   * ei:会话 id —— 下载走「这段会话的产出」通道,所以**落在项目目录之外的产出
   * 也能下**(计划文件、/tmp 脚本…,项目文件接口对它们一律 403)。
   */
  sessionId?: string | null;
};

/**
 * 一轮的「产出」卡(设计稿:回答正文下面那张卡)。
 *
 * 右侧工作面板那份是**会话级**累计表 —— 翻几天前的文件用;这张是**本轮**刚写出
 * 来的东西,就摆在说出结论的那段话下面:读完"详见产出"这句,文件就在下一行,
 * 不用把视线甩到右栏再找一遍。数据同源(消息流里成功执行的 Write),所以
 * 两边永远一致。行右端是写入量(+N 行),点行或点眼睛都进预览。
 */
export default function TurnOutputsCard({ files, onFileOpen, sessionId }: Props) {
  const { t } = useTranslation('chat');
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const download = async (file: TurnOutputFile) => {
    if (!sessionId) return;
    setBusyPath(file.path);
    try {
      const response = await api.sessionOutputBlob(sessionId, file.path);
      if (!response.ok) return;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.path.split(/[\\/]/).pop() || 'download';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // 释放放到下一拍 —— 有些浏览器在 click 返回时还没开始读这个 URL。
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setBusyPath(null);
    }
  };

  if (files.length === 0) return null;

  return (
    <div data-turn-outputs className="overflow-hidden rounded-panel border border-border bg-card">
      <div className="flex h-8 items-center gap-1.5 px-3 text-xs font-semibold text-foreground">
        {t('workPanel.outputsShort', { defaultValue: '产出' })}
        <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">{files.length}</span>
      </div>
      {files.map((file) => (
        <div
          key={file.path}
          className="group/turn-output flex h-8 items-center gap-2 border-t border-border px-3"
        >
          <FileTypeIcon path={file.path} />
          {onFileOpen ? (
            <button
              type="button"
              onClick={() => onFileOpen(file.path)}
              title={`${file.path} · ${t('workPanel.open', { defaultValue: '打开' })}`}
              className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px] text-foreground transition-colors hover:text-primary"
            >
              {file.display}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground" title={file.path}>
              {file.display}
            </span>
          )}
          {file.metric && (
            <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">{file.metric}</span>
          )}
          {sessionId && (
            <button
              type="button"
              disabled={busyPath === file.path}
              onClick={() => void download(file)}
              aria-label={t('workPanel.download', { defaultValue: '下载此文件' })}
              title={t('workPanel.download', { defaultValue: '下载此文件' })}
              className={cn(
                'grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/turn-output:opacity-100 disabled:cursor-not-allowed',
                busyPath === file.path && 'animate-pulse opacity-100',
              )}
            >
              <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          )}
          {onFileOpen && (
            <button
              type="button"
              onClick={() => onFileOpen(file.path)}
              aria-label={t('workPanel.open', { defaultValue: '打开' })}
              title={t('workPanel.open', { defaultValue: '打开' })}
              className="grid h-6 w-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
