import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, FlaskConical, Inbox, Loader2, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import {
  checkTasks, detectFormat, keepPassing, TASK_TEMPLATES, type LocalReport, type TaskFormat,
} from '../lib/task-upload';
import { unwrap, type InboxRow, type TaskValidateResponse } from '../lib/types';
import type { SkillWhetData } from '../SkillWhetPage';

import HarvestWizard from './HarvestWizard';
import { Badge } from './StatusStrip';

/**
 * gy:任务集 —— 按 skill 挂;JSON / JSONL / CSV 粘贴或选文件 → 浏览器先逐行校验 →
 * 服务端复校 → 入库。入库的权限与副本一致(技能库来源 → root;上传来源 → 上传者或 root),
 * 前端只是把不能点的按钮说明白,门在服务端。
 *
 * gz 加两样:「从测试派生」(tests/unit 的用例 → 规则型任务,权限同入库)和
 * 「来自反馈 · 待入库」(root;👎 与调查卡的期望结果 → 任务,勾选后一键转换,回填 task_id)。
 * ha 再加「从会话挖」(root;HarvestWizard):dry-run 列会话 → 挖 → 预览 → 勾选入库。
 */
export default function Tasks({ data, isRoot, username }: { data: SkillWhetData; isRoot: boolean; username: string }) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const skills = useMemo(() => data.skills?.skills ?? [], [data.skills]);
  const [skill, setSkill] = useState('');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [format, setFormat] = useState<TaskFormat>('json');
  const [report, setReport] = useState<LocalReport | null>(null);
  const [serverReport, setServerReport] = useState<TaskValidateResponse['report'] | null>(null);
  const [busy, setBusy] = useState<'validate' | 'add' | 'derive' | 'accept' | null>(null);
  const [inbox, setInbox] = useState<InboxRow[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!skill && skills.length > 0) setSkill(skills[0].name);
  }, [skill, skills]);

  const target = skills.find((item) => item.name === skill) ?? null;
  const mayAdd = Boolean(target) && (isRoot || (target?.source === 'upload' && target.uploaded_by === username));

  const loadInbox = useCallback(async () => {
    if (!isRoot) return;
    try {
      const res = await unwrap<{ inbox: InboxRow[] }>(await api.skillWhet.feedbackInbox(null));
      setInbox(Array.isArray(res.inbox) ? res.inbox : []);
    } catch {
      setInbox([]);
    }
  }, [isRoot]);

  useEffect(() => { void loadInbox(); }, [loadInbox]);

  const derive = async () => {
    if (!skill) return;
    setBusy('derive');
    try {
      const result = await unwrap<{ derived: number; total?: number }>(await api.skillWhet.tasksDerive(skill));
      toast({ message: t('tasks.deriveDone', { defaultValue: '从 tests/unit 派生 {{n}} 条规则型任务', n: result.derived }), variant: 'success' });
      await data.refresh();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const acceptInbox = async () => {
    if (picked.size === 0) return;
    setBusy('accept');
    try {
      const result = await unwrap<{ accepted: Array<{ id: number; taskId: string; skill: string }> }>(await api.skillWhet.feedbackInboxAccept([...picked]));
      toast({ message: t('tasks.acceptDone', { defaultValue: '{{n}} 条反馈已转成任务', n: result.accepted.length }), variant: 'success' });
      setPicked(new Set());
      await Promise.all([loadInbox(), data.refresh()]);
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const togglePick = (id: number) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const runLocal = useCallback((text: string, name: string | null, forced?: TaskFormat) => {
    const fmt = forced ?? detectFormat(name, text);
    setFormat(fmt);
    setServerReport(null);
    setReport(text.trim() ? checkTasks(text, fmt) : null);
  }, []);
  // hl(动态 P3):格式允许手选 —— 自动识别把坏了一行的 JSONL 当 JSON 时,用户能切回 jsonl 看逐行结果
  const onFormat = (fmt: TaskFormat) => runLocal(content, fileName, fmt);

  const onText = (text: string) => { setContent(text); setFileName(null); runLocal(text, null); };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setContent(text);
    setFileName(file.name);
    runLocal(text, file.name);
  };

  const validateRemote = async () => {
    if (!content.trim() || !skill) return;
    setBusy('validate');
    try {
      const result = await unwrap<TaskValidateResponse | TaskValidateResponse['report']>(await api.skillWhet.tasksValidate(skill, format, content));
      // serve 的 /tasks/validate 直接回 { format, passed, failed, rows };/tasks 才包一层 report
      const report = 'report' in result ? result.report : result;
      setServerReport(Array.isArray(report?.rows) ? report : null);
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const addRemote = async () => {
    if (!content.trim() || !skill) return;
    setBusy('add');
    try {
      const result = await unwrap<TaskValidateResponse>(await api.skillWhet.tasksAdd(skill, format, content, false));
      toast({ message: t('tasks.addDone', { defaultValue: '已入库 {{n}} 条,{{skill}} 现有 {{total}} 条', n: result.added ?? 0, skill, total: result.total ?? '?' }), variant: 'success' });
      setContent(''); setFileName(null); setReport(null); setServerReport(null);
      await data.refresh();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const onKeepPassing = () => {
    if (!report || report.fatal) return;
    try {
      const next = keepPassing(content, format, report);
      setContent(next.content); setFileName(null); setFormat(next.format);
      setServerReport(null);
      setReport(checkTasks(next.content, next.format));
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    }
  };

  const downloadTemplate = (name: keyof typeof TASK_TEMPLATES) => {
    const blob = new Blob([TASK_TEMPLATES[name]], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    URL.revokeObjectURL(url);
  };

  // 服务端复校过就以它为准;否则用本地结果。
  const shown = useMemo(() => {
    if (serverReport) {
      return {
        rows: serverReport.rows.map((row) => ({ row: row.row, taskId: row.task_id, ok: row.ok, errors: row.errors, warnings: row.warnings, referenceKind: row.reference_kind, family: row.family })),
        passed: serverReport.passed, failed: serverReport.failed, fatal: null as string | null, remote: true,
      };
    }
    return report ? { ...report, remote: false } : null;
  }, [report, serverReport]);

  const canSubmit = Boolean(shown && !shown.fatal && shown.passed > 0 && shown.failed === 0 && skill);
  const inputClass = 'rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-foreground">{t('tasks.title', { defaultValue: '任务集' })}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('tasks.subtitle', { defaultValue: '按 skill 挂;JSON / JSONL / CSV 粘贴或选文件,浏览器先校验、服务端再校一遍,再入库。' })}</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('tasks.templates', { defaultValue: '模板' })}
          {(Object.keys(TASK_TEMPLATES) as Array<keyof typeof TASK_TEMPLATES>).map((name) => (
            <button key={name} type="button" onClick={() => downloadTemplate(name)} className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2 font-mono text-[11px] text-foreground hover:border-border-strong">
              <Download className="h-3 w-3" aria-hidden />{name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-4 max-lg:grid-cols-1">
        <section className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-foreground">{t('tasks.import', { defaultValue: '导入' })}</h2>
            {target?.has_unit_tests && (
              <button type="button" onClick={() => void derive()} disabled={!mayAdd || busy !== null} title={t('tasks.deriveHint', { defaultValue: '把 tests/unit 的用例变成规则型任务(权限同入库)' })} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50" data-testid="tasks-derive">
                {busy === 'derive' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FlaskConical className="h-3 w-3" aria-hidden />}{t('tasks.derive', { defaultValue: '从测试派生' })}
              </button>
            )}
            <span className="flex-1" />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              {t('tasks.targetSkill', { defaultValue: '目标 skill' })}
              <select value={skill} onChange={(event) => setSkill(event.target.value)} className={`${inputClass} h-7 font-mono`} aria-label={t('tasks.targetSkill', { defaultValue: '目标 skill' })}>
                {skills.length === 0 && <option value="">{t('tasks.noSkills', { defaultValue: '(先导入或上传一个 skill)' })}</option>}
                {skills.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
              </select>
            </label>
          </div>

          <label className="flex cursor-pointer flex-col items-center gap-1 rounded-panel border border-dashed border-border-strong bg-muted px-4 py-4 text-center text-[13px] text-muted-foreground hover:border-primary">
            <Upload className="h-[18px] w-[18px]" aria-hidden />
            <span className="text-body">{fileName ? fileName : t('tasks.dropTitle', { defaultValue: '选择 tasks.json / .jsonl / .csv,或粘贴到下面' })}</span>
            <span className="text-xs">{t('tasks.dropHint', { defaultValue: '单文件 ≤ 5 MiB · ≤ 5,000 条 · input 与 expected_output(或 rubric)必填(0 / false / null 是合法值)' })}</span>
            <input ref={fileRef} type="file" accept=".json,.jsonl,.ndjson,.csv,text/plain" className="sr-only" onChange={(event) => void onFile(event.target.files?.[0])} data-testid="task-file-input" />
          </label>
          <label className="flex items-center gap-2 self-end text-xs text-muted-foreground">
            {t('tasks.format', { defaultValue: '格式' })}
            <select value={format} onChange={(event) => onFormat(event.target.value as TaskFormat)} className={`${inputClass} h-7 font-mono`} aria-label={t('tasks.format', { defaultValue: '格式' })} data-testid="task-format">
              <option value="json">json</option><option value="jsonl">jsonl</option><option value="csv">csv</option>
            </select>
          </label>

          <textarea
            value={content}
            onChange={(event) => onText(event.target.value)}
            rows={7}
            spellCheck={false}
            aria-label={t('tasks.paste', { defaultValue: '粘贴任务集' })}
            placeholder={'[{"task_id":"case-001","input":{...},"expected_output":{...}}]'}
            className={`${inputClass} resize-none font-mono`}
          />

          {shown?.fatal && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{shown.fatal}</div>
          )}

          {shown && !shown.fatal && (
            <div className="max-h-[320px] overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-left text-[11px] text-muted-foreground">
                  <tr><th className="w-12 px-2 py-1 font-normal">{t('tasks.colRow', { defaultValue: '行' })}</th><th className="w-32 px-2 py-1 font-normal">task_id</th><th className="px-2 py-1 font-normal">{t('tasks.colCheck', { defaultValue: '校验' })}{shown.remote ? ` · ${t('tasks.remote', { defaultValue: '服务端' })}` : ''}</th></tr>
                </thead>
                <tbody>
                  {shown.rows.map((row) => (
                    <tr key={row.row} className="border-t border-border">
                      <td className="px-2 py-1 font-mono text-muted-foreground">{row.row}</td>
                      <td className="truncate px-2 py-1 font-mono text-body">{row.taskId}</td>
                      <td className="px-2 py-1">
                        {row.ok
                          ? <><Badge tone="ok"><Check className="h-[11px] w-[11px]" aria-hidden />{t('tasks.pass', { defaultValue: '通过' })}</Badge> <span className="text-muted-foreground">{row.referenceKind}{row.family ? ` · family ${row.family}` : ''}</span></>
                          : row.errors.map((message) => <Badge key={message} tone="bad" className="mr-1"><X className="h-[11px] w-[11px]" aria-hidden />{message}</Badge>)}
                        {row.warnings.map((message) => <Badge key={message} tone="warn" className="ml-1">{message}</Badge>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-body">
              {shown && !shown.fatal
                ? t('tasks.summary', { defaultValue: '{{n}} 条 · {{ok}} 通过 · {{bad}} 需修正', n: shown.rows.length, ok: shown.passed, bad: shown.failed })
                : t('tasks.summaryEmpty', { defaultValue: '粘贴或选文件后这里逐行给结果' })}
            </span>
            <span className="flex-1" />
            {shown && !shown.fatal && shown.failed > 0 && shown.passed > 0 && (
              <button type="button" onClick={onKeepPassing} className="h-7 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong">{t('tasks.keepPassing', { defaultValue: '只留通过的' })}</button>
            )}
            <button type="button" onClick={() => void validateRemote()} disabled={!content.trim() || !skill || busy !== null} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50">
              {busy === 'validate' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}{t('tasks.validateRemote', { defaultValue: '服务端复校' })}
            </button>
            <button type="button" onClick={() => void addRemote()} disabled={!canSubmit || !mayAdd || busy !== null} title={!mayAdd && target ? (target.source === 'upload' ? t('tasks.uploaderOnly', { defaultValue: '只有上传者本人或 root 能入库' }) : t('tasks.rootOnly', { defaultValue: '技能库来源的 skill 只有 root 能入库' })) : undefined} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-3 text-xs disabled:opacity-50">
              {busy === 'add' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
              {t('tasks.add', { defaultValue: '校验并入库' })}
              {target?.source !== 'upload' && <span className="rounded-sm border border-border px-1 font-mono text-[9px]">root</span>}
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2 rounded-panel border border-border bg-card p-4">
          <h2 className="text-[15px] font-semibold text-foreground">{t('tasks.stored', { defaultValue: '已入库' })}</h2>
          {data.taskSummary.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">{t('tasks.storedEmpty', { defaultValue: '还没有任务集。左边导入第一批。' })}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] text-muted-foreground">
                <tr><th className="py-1 font-normal">skill</th><th className="py-1 font-normal">{t('tasks.colTotal', { defaultValue: '任务数' })}</th><th className="py-1 font-normal">train / val / test</th><th className="py-1 font-normal">{t('tasks.colSources', { defaultValue: '来源' })}</th></tr>
              </thead>
              <tbody>
                {data.taskSummary.map((row) => (
                  <tr key={row.skill} className="border-t border-border">
                    <td className="py-1.5 font-mono text-foreground">{row.skill}</td>
                    <td className="py-1.5 font-mono text-body">{row.total}</td>
                    <td className="py-1.5 font-mono text-body">{row.splits.train} / {row.splits.val} / {row.splits.test}</td>
                    <td className="py-1.5">{Object.entries(row.sources).map(([source, count]) => <Badge key={source} className="mr-1">{source} {count}</Badge>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!isRoot && <p className="mt-auto text-[11px] leading-4 text-muted-foreground">{t('tasks.feedbackRootOnly', { defaultValue: '「来自反馈 · 待入库」(把 👎 与调查卡的期望结果转成任务)由 root 处理。' })}</p>}
        </section>
      </div>

      {isRoot && skills.length > 0 && <HarvestWizard skills={skills} onImported={data.refresh} />}

      {isRoot && (
        <section className="flex flex-col gap-2 rounded-panel border border-border bg-card p-4" data-testid="tasks-inbox">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-foreground"><Inbox className="h-4 w-4" aria-hidden />{t('tasks.inbox', { defaultValue: '来自反馈 · 待入库' })}</h2>
            <span className="font-mono text-[11px] text-muted-foreground">{inbox ? inbox.length : '…'}</span>
            <span className="flex-1" />
            <button type="button" onClick={() => void acceptInbox()} disabled={picked.size === 0 || busy !== null} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-3 text-xs disabled:opacity-50" data-testid="tasks-inbox-accept">
              {busy === 'accept' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
              {t('tasks.acceptPicked', { defaultValue: '转成任务 ({{n}})', n: picked.size })}
            </button>
          </div>
          <p className="text-[11px] leading-4 text-muted-foreground">{t('tasks.inboxHint', { defaultValue: '👎 / 调查卡带待优化点或期望结果的反馈。有期望结果 → exact 任务;只有待优化点 → rubric 任务。好 / 一般 / 差 → outcome success / mixed / fail。' })}</p>
          {inbox === null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />…</div>
          ) : inbox.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-muted-foreground">{t('tasks.inboxEmpty', { defaultValue: '没有待处理的反馈。带待优化点或期望结果的 👎 / 调查答复会出现在这里。' })}</p>
          ) : (
            <div className="max-h-[360px] overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-left text-[11px] text-muted-foreground">
                  <tr>
                    <th className="w-8 px-2 py-1 font-normal"><input type="checkbox" aria-label={t('tasks.pickAll', { defaultValue: '全选' })} checked={picked.size === inbox.length && inbox.length > 0} onChange={(e) => setPicked(e.target.checked ? new Set(inbox.map((r) => r.id)) : new Set())} /></th>
                    <th className="px-2 py-1 font-normal">skill</th>
                    <th className="px-2 py-1 font-normal">{t('tasks.colIntent', { defaultValue: '用户原话' })}</th>
                    <th className="px-2 py-1 font-normal">{t('tasks.colNote', { defaultValue: '待优化点 / 期望结果' })}</th>
                    <th className="px-2 py-1 font-normal">{t('tasks.colKind', { defaultValue: '类型' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {inbox.map((row) => (
                    <tr key={row.id} className="border-t border-border align-top">
                      <td className="px-2 py-1"><input type="checkbox" aria-label={`#${row.id}`} checked={picked.has(row.id)} onChange={() => togglePick(row.id)} /></td>
                      <td className="px-2 py-1 font-mono text-foreground">{row.skill}</td>
                      <td className="max-w-[320px] px-2 py-1 text-body"><span className="line-clamp-2" title={row.intent}>{row.intent || <span className="text-muted-foreground">—</span>}</span></td>
                      <td className="max-w-[320px] px-2 py-1 text-body">
                        {row.expectedOutput ? <span className="line-clamp-2 font-mono" title={row.expectedOutput}>{row.expectedOutput}</span> : null}
                        {row.note ? <span className="line-clamp-2" title={row.note}>{row.note}</span> : null}
                      </td>
                      <td className="px-2 py-1">
                        <Badge tone={row.verdict === 1 ? 'ok' : row.verdict === -1 ? 'bad' : 'muted'}>{row.verdict === 1 ? t('card.good', { defaultValue: '好' }) : row.verdict === -1 ? t('card.bad', { defaultValue: '差' }) : t('card.neutral', { defaultValue: '一般' })}</Badge>
                        <Badge className="ml-1">{row.referenceKind}</Badge>
                        <Badge className="ml-1">{row.source}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
