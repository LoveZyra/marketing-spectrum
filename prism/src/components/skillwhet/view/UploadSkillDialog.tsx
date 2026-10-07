import { useEffect, useRef, useState } from 'react';
import { FolderUp, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import { useModalKeyboard } from '../../../shared/view/hooks/useModalKeyboard';
import { buildUploadBundle, type UploadBundle } from '../lib/skill-upload';
import { unwrap } from '../lib/types';

import { Badge } from './StatusStrip';

/**
 * 上传技能:选一个文件夹(SKILL.md 应在根上,在子目录里时明确提示),浏览器侧先把关,再整包 base64 送上去。
 *
 * 任何登录用户都能传;传上来的副本只有上传者本人与 root 能动。对话框会提示:
 * 没有 `tests/unit/` 的 skill,代码快环只能靠 G0–G3,建议带上测试;纯文档 skill 只走慢环。
 */
export default function UploadSkillDialog({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => Promise<void> }) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [bundle, setBundle] = useState<UploadBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  // 包里的 tasks.json 没能(全部)入库时,把 serve 回的 tasks 报告留在对话框里
  const [tasksNote, setTasksNote] = useState<string | null>(null);
  useModalKeyboard(dialogRef, { onClose });

  useEffect(() => {
    // React 的类型里没有 webkitdirectory,用 setAttribute 打上去(与 ProviderSkills 同一招)。
    inputRef.current?.setAttribute('webkitdirectory', '');
    inputRef.current?.setAttribute('directory', '');
  }, []);

  const pick = async (files: File[]) => {
    setError(null);
    setBundle(null);
    if (files.length === 0) return;
    setReading(true);
    try {
      setBundle(await buildUploadBundle(files));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReading(false);
    }
  };

  const submit = async () => {
    if (!bundle) return;
    setUploading(true);
    try {
      const data = await unwrap<{ tasks?: { file?: string; error?: string; message?: string; passed?: number; failed?: number; added?: { added?: number } | null } | null }>(await api.skillWhet.uploadSkill(bundle.name, bundle.files));
      toast({ message: t('upload.done', { defaultValue: '已上传 {{name}},副本已建', name: bundle.name }), variant: 'success' });
      await onUploaded();
      const tasks = data?.tasks;
      if (tasks && (tasks.error || (tasks.failed ?? 0) > 0 || !tasks.added)) {
        // 任务集没进库(或部分没进):留在对话框里说清楚,不直接关
        setTasksNote(tasks.error
          ? t('upload.tasksError', { defaultValue: '包里的 {{file}} 没能入库:{{msg}}', file: tasks.file ?? 'tasks.json', msg: tasks.message ?? tasks.error })
          : t('upload.tasksPartial', { defaultValue: '包里的 {{file}}:{{ok}} 行通过、{{bad}} 行没通过{{added}}', file: tasks.file ?? 'tasks.json', ok: tasks.passed ?? 0, bad: tasks.failed ?? 0, added: tasks.added?.added ? `,已入库 ${tasks.added.added} 条` : ',没有入库' }));
        return;
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUploading(false);
    }
  };

  const fmtBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="presentation">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="skillwhet-upload-title" className="w-full max-w-lg rounded-panel border border-border bg-card p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h2 id="skillwhet-upload-title" className="text-base font-semibold text-foreground">{t('upload.title', { defaultValue: '上传技能' })}</h2>
          <div className="flex-1" />
          <button type="button" onClick={onClose} aria-label={t('upload.close', { defaultValue: '关闭' })} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('upload.subtitle', { defaultValue: '选一个技能文件夹(根上有 SKILL.md)。副本只归你和 root 管;训练在副本上跑,不碰技能库。' })}</p>

        <label className="mt-4 flex cursor-pointer flex-col items-center gap-1.5 rounded-panel border border-dashed border-border-strong bg-muted px-4 py-6 text-center text-[13px] text-muted-foreground hover:border-primary">
          {reading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <FolderUp className="h-5 w-5" aria-hidden />}
          <span className="text-body">{t('upload.pick', { defaultValue: '点击选择技能文件夹' })}</span>
          <span className="text-xs">{t('upload.limits', { defaultValue: '≤ 500 个文件 · 总计 ≤ 30 MiB · 单文件 ≤ 5 MiB · .git / node_modules / .evo 自动跳过' })}</span>
          <input ref={inputRef} type="file" multiple className="sr-only" onChange={(event) => void pick(Array.from(event.target.files ?? []))} data-testid="skill-upload-input" />
        </label>

        {error && <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}
        {tasksNote && <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" data-testid="upload-tasks-note">{tasksNote}</div>}

        {bundle && (
          <div className="mt-3 rounded-md border border-border bg-background p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-foreground">{bundle.name}</span>
              <Badge>{t('upload.files', { defaultValue: '{{n}} 个文件', n: bundle.files.length })}</Badge>
              <Badge>{fmtBytes(bundle.totalBytes)}</Badge>
              <Badge>{t('upload.py', { defaultValue: '{{n}} 个 .py', n: bundle.pythonFiles })}</Badge>
              {bundle.hasUnitTests ? <Badge tone="ok">tests/unit</Badge> : <Badge tone="warn">{t('upload.noTests', { defaultValue: '无 tests/unit' })}</Badge>}
            </div>
            {bundle.nestedRoot && (
              <p className="mt-2 leading-5 text-amber-700 dark:text-amber-300" data-testid="upload-nested-note">
                {t('upload.nested', { defaultValue: 'SKILL.md 不在所选文件夹「{{picked}}」的根,而在子目录「{{nested}}」里 —— 将以子目录名「{{name}}」作为技能名上传;想用别的名字请直接选那个子目录。', picked: bundle.pickedFolder ?? '', nested: bundle.nestedRoot, name: bundle.name })}
              </p>
            )}
            <p className="mt-2 leading-5 text-muted-foreground">
              {bundle.pythonFiles === 0
                ? t('upload.docOnly', { defaultValue: '纯文档 skill:只走慢环(agent runner),六门里只有 G0 / G3 有意义。' })
                : bundle.hasUnitTests
                  ? t('upload.withTests', { defaultValue: '带单元测试:G4 能跑,快环会用它们当回归判据。' })
                  : t('upload.noTestsHint', { defaultValue: '没有 tests/unit/:代码快环只能靠 G0–G3 与训练时自写的 repro 测试,建议带上测试再传。' })}
            </p>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md border border-border bg-card px-3 text-sm text-foreground hover:border-border-strong">{t('upload.cancel', { defaultValue: '取消' })}</button>
          <button type="button" onClick={() => void submit()} disabled={!bundle || uploading} className="prism-action inline-flex h-8 items-center gap-1.5 rounded-md border px-3.5 text-sm disabled:opacity-50">
            {uploading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {t('upload.submit', { defaultValue: '上传并建副本' })}
          </button>
        </div>
      </div>
    </div>
  );
}
