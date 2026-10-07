import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { StagingDiff } from '../lib/types';

/**
 * 「代码与文档」:staging 的 `proposed/` 相对 diff 底(`base`)的逐文件 unified diff,服务端算好、这里只上色。
 * 左边文件条(+/− 计数),右边正文;没有 diff = 这份 staging 没有改动(通常是"未改进,staged S₀")。
 */
export default function DiffView({ diffs, base = 'copy' }: { diffs: StagingDiff[]; base?: 'base' | 'backup' | 'copy' }) {
  const { t } = useTranslation('skillwhet');
  const [active, setActive] = useState(0);
  // 底是 base / backup 时,采纳 / 发布之后也照样看得到这份 staging 当初改了什么;copy 才是对比副本当前内容。
  const caption = base === 'base'
    ? t('diff.baseTraining', { defaultValue: '对比:训练开始时的副本 → 这份 staging' })
    : base === 'backup'
      ? t('diff.baseBackup', { defaultValue: '对比:采纳前的副本 → 这份 staging' })
      : t('diff.baseCopy', { defaultValue: '对比:副本当前内容 → 这份 staging' });
  if (diffs.length === 0) {
    return <div className="rounded-panel border border-dashed border-border px-6 py-10 text-center text-[13px] text-muted-foreground">{base === 'copy'
      ? t('diff.none', { defaultValue: '这份 staging 与副本当前内容一致,没有可看的改动。' })
      : t('diff.noneSince', { defaultValue: '这份 staging 没有改动任何文件(训练没有找到更好的版本,留的是原样)。' })}</div>;
  }
  const current = diffs[Math.min(active, diffs.length - 1)];
  const lines = (current.diff ?? '').split('\n');
  return (
    <div className="flex flex-col gap-2">
    <div className="text-[11px] text-muted-foreground" data-testid="diff-base">{caption}</div>
    <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-3 max-lg:grid-cols-1">
      <ul className="flex flex-col gap-1">
        {diffs.map((d, i) => (
          <li key={d.rel}>
            <button type="button" onClick={() => setActive(i)} className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left font-mono text-[11px] ${i === active ? 'border-primary bg-accent text-accent-foreground' : 'border-border bg-card text-body hover:border-border-strong'}`}>
              <span className="min-w-0 flex-1 truncate">{d.rel}{d.new ? ` (${t('diff.new', { defaultValue: '新文件' })})` : ''}</span>
              {d.binary ? <span className="text-muted-foreground">bin</span> : <span><span className="text-emerald-600">+{d.added ?? 0}</span> <span className="text-red-600">−{d.removed ?? 0}</span></span>}
            </button>
          </li>
        ))}
      </ul>
      <pre className="max-h-[70vh] overflow-auto rounded-panel border border-border bg-card p-0 font-mono text-[11.5px] leading-[18px]">
        {current.binary ? (
          <div className="p-3 text-muted-foreground">{t('diff.binary', { defaultValue: '二进制文件,不展示内容' })}</div>
        ) : lines.map((line, i) => {
          const cls = line.startsWith('+++') || line.startsWith('---') ? 'text-muted-foreground'
            : line.startsWith('@@') ? 'bg-muted text-muted-foreground'
              : line.startsWith('+') ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                : line.startsWith('-') ? 'bg-red-500/10 text-red-800 dark:text-red-200' : 'text-body';
          return <div key={i} className={`whitespace-pre px-3 ${cls}`}>{line || ' '}</div>;
        })}
      </pre>
    </div>
    </div>
  );
}
