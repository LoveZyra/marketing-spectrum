import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Bot, ChevronDown, Clock, Loader2, Pencil, Play, Plus, Search,
  Settings2, Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../utils/api';
import { useToast } from '../../shared/view/ui';
// 项目/会话/模型三个下拉抽成了共享实现:别处要用同一套交互时直接引它,
// 而不是照着抄一遍 —— 抄出来的第二份迟早会漂。
import { BrowseFolderFooter, FancySelect, type FancyOption } from '../../shared/view/ui/FancySelect';
import {
  useModelCatalog, useModelOptions, useProjectOptions, useProjectRows,
  useSessionOptions, useSessionRows,
} from '../../hooks/useTaskLikeOptions';
import FolderBrowserModal from '../project-creation-wizard/components/FolderBrowserModal';
import type { AppTab, Project } from '../../types/app';

/**
 * 定时任务页(cj 轮起,版式对照用户给的 Scheduled tasks 参考图)。
 *
 * 列表:大标题 + 搜索 + 「新建任务 ▾」(点开二选一:让 Claude 创建 / 手动填写表单)+ 双列卡片;
 * 详情:标题 + 启停开关 + 立即运行/编辑/删除,左栏最近运行,右栏指令/目标/频率;
 * 手动表单弹窗:对照 Create scheduled task 截图(名称与指令必填,指令大框
 * 内嵌项目与模型选择,另有频率、会话策略、权限、目标会话)。
 *
 * **创建的推荐路径是对话**(cm 轮,用户定):菜单里第一项「让 Claude 创建」切到
 * 对话页发一句人话,Claude 解析需求、缺什么问什么、齐了就建;第二项「手动填写
 * 表单」给要精确控制的场合,编辑已有任务也走它。按钮本身只展开菜单、不直接
 * 触发任何一种 —— 点一下就跳走会让人措手不及(用户反馈)。技术细节(一次性票据 + 接口用法)作为隐藏上下文随消息
 * 带给模型,页面上不出现 —— 全程不暴露登录 token,票据一次即焚、可撤销自己
 * 刚建的那一个。会话归属由 Claude 出选择题让用户二选一,不替他决定。
 */

export type WireTask = {
  id: string; name: string; instructions: string; projectPath: string;
  sessionMode: 'fixed' | 'new'; fixedSessionId: string | null;
  frequency: 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
  runAtHour: number | null; runAtMinute: number | null;
  runAtWeekday: number | null; runAtDay: number | null;
  model: string | null; permissionMode: string;
  enabled: boolean; running: boolean; createdAt: string;
  nextRunAt: string | null; lastRunAt: string | null;
  lastRunStatus: string | null; lastRunDetail: string | null; lastRunDurationMs: number | null;
  sessionPath: string | null;
};

type TasksPageProps = {
  selectedProject: Project | null;
  /** 用户当前所在的对话 —— 「就写进这条对话」靠它绑定(cm 轮)。 */
  selectedSession?: { id?: string | null } | null;
  setActiveTab: (tab: AppTab) => void;
  onNavigateToSession?: (sessionId: string) => void;
};

/** index 0=周日 … 6=周六,随界面语言给本地化的周几名(2023-01-01 是周日)。 */
function weekdayName(index: number, locale: string): string {
  try {
    return new Date(Date.UTC(2023, 0, 1 + index)).toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' });
  } catch {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][index] ?? String(index);
  }
}

function pad(value: number | null | undefined): string {
  return String(value ?? 0).padStart(2, '0');
}

/** 频率 → 人话(「每天 09:00」「工作日 15:30」…)。 */
function frequencyLabel(task: Pick<WireTask, 'frequency' | 'runAtHour' | 'runAtMinute' | 'runAtWeekday' | 'runAtDay'>, t: (k: string, o?: Record<string, unknown>) => string, locale: string): string {
  const time = `${pad(task.runAtHour ?? 9)}:${pad(task.runAtMinute)}`;
  switch (task.frequency) {
    case 'manual': return t('tasksPage.freq.manual', { defaultValue: '手动触发' });
    case 'hourly': return t('tasksPage.freq.hourly', { minute: pad(task.runAtMinute), defaultValue: '每小时 :{{minute}}' });
    case 'daily': return t('tasksPage.freq.daily', { time, defaultValue: '每天 {{time}}' });
    case 'weekdays': return t('tasksPage.freq.weekdays', { time, defaultValue: '工作日 {{time}}' });
    case 'weekly': return t('tasksPage.freq.weekly', { day: weekdayName(task.runAtWeekday ?? 1, locale), time, defaultValue: '每{{day}} {{time}}' });
    case 'monthly': return t('tasksPage.freq.monthly', { day: task.runAtDay ?? 1, time, defaultValue: '每月 {{day}} 号 {{time}}' });
    default: return task.frequency;
  }
}

/** 一次运行。对应 GET /api/tasks/:id/runs。 */
interface WireRun {
  id: number;
  trigger: 'schedule' | 'manual';
  status: 'completed' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  detail: string | null;
  sessionId: string | null;
}

/** 详情页一屏铺几条,「看更多」每次再加这么多。 */
const RUNS_PAGE = 8;

function formatWhen(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/* ── 手动创建 / 编辑弹窗 ─────────────────────────────────────────── */

type FormState = {
  name: string; instructions: string; projectPath: string;
  frequency: WireTask['frequency'];
  // 时刻三项在编辑期允许空串 —— 否则受控数字框永远删不掉旧值,
  // 用户一打字就变成 "015" 这种拼接(用户反馈)。提交时空串回落默认值。
  runAtHour: number | ''; runAtMinute: number | ''; runAtDay: number | '';
  runAtWeekday: number;
  sessionMode: 'fixed' | 'new';
  /** fixed 模式的目标会话;'' = 第一次运行时自动新建并固定(用户反馈:要能选已有会话)。 */
  fixedSessionId: string;
  model: string; permissionMode: string;
};

function TaskFormModal({
  initial, editingId, projects, models, defaultModelReal, onClose, onSaved,
}: {
  initial: FormState;
  editingId: string | null;
  projects: Array<{ path: string; name: string }>;
  models: FancyOption[];
  /** 「默认模型」实际指向谁(能查到就写在主行,别名退到副行)。 */
  defaultModelReal: string | null;
  onClose: () => void;
  onSaved: (task: WireTask) => void;
}) {
  const { t, i18n } = useTranslation('common');
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  // 「选择其它目录…」的文件夹浏览器挂在表单这一层(下拉面板一关就会卸载 footer)
  const [browsingFolder, setBrowsingFolder] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  /** 数字时刻框:允许清空(空串),其余取整并夹进 [min,max]。 */
  const setClamped = (key: 'runAtHour' | 'runAtMinute' | 'runAtDay', raw: string, min: number, max: number) => {
    if (raw === '') { set(key, ''); return; }
    const value = Number(raw);
    if (Number.isNaN(value)) return;
    set(key, Math.max(min, Math.min(max, Math.trunc(value))));
  };

  // 三个下拉的选项全部走共享 hook,不许各写一份。
  const projectOptions = useProjectOptions(projects, form.projectPath);
  const modelOptions = useModelOptions(models, form.model, defaultModelReal);
  const sessions = useSessionRows(form.projectPath);
  const sessionOptions = useSessionOptions(
    sessions,
    form.fixedSessionId,
    t('tasksPage.form.targetSessionAuto', { defaultValue: '自动新建一个并固定(默认)' }),
  );

  const submit = async () => {
    if (!form.name.trim() || !form.instructions.trim() || !form.projectPath.trim()) {
      toast({ message: t('tasksPage.form.required', { defaultValue: '名称、指令、项目都不能为空' }), variant: 'error' });
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({
        name: form.name, instructions: form.instructions, projectPath: form.projectPath,
        frequency: form.frequency,
        runAtHour: form.runAtHour === '' ? 9 : form.runAtHour,
        runAtMinute: form.runAtMinute === '' ? 0 : form.runAtMinute,
        runAtWeekday: form.runAtWeekday,
        runAtDay: form.runAtDay === '' ? 1 : form.runAtDay,
        sessionMode: form.sessionMode,
        fixedSessionId: form.sessionMode === 'fixed' ? (form.fixedSessionId || null) : null,
        model: form.model || null, permissionMode: form.permissionMode,
      });
      const response = editingId
        ? await authenticatedFetch(`/api/tasks/${editingId}`, { method: 'PATCH', body })
        : await authenticatedFetch('/api/tasks', { method: 'POST', body });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');
      onSaved(payload.task as WireTask);
      onClose();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : '保存失败', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30';
  const label = 'mb-1.5 block text-[13px] font-medium text-foreground';
  const req = <span className="ml-0.5 text-primary">*</span>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="prism-modal-shadow max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">
            {editingId
              ? t('tasksPage.form.editTitle', { defaultValue: '编辑定时任务' })
              : t('tasksPage.form.createTitle', { defaultValue: '新建定时任务' })}
          </h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">✕</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={label}>{t('tasksPage.form.name', { defaultValue: '名称' })}{req}</label>
            <input className={field} value={form.name} onChange={(e) => set('name', e.target.value)}
              placeholder={t('tasksPage.form.namePh', { defaultValue: '例如:每日晨报' })} />
          </div>

          <div>
            <label className={label}>{t('tasksPage.form.instructions', { defaultValue: '执行指令' })}{req}</label>
            <div className="overflow-hidden rounded-md border border-border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
              <textarea
                className="block h-32 w-full resize-y bg-transparent px-3 py-2 text-sm text-foreground focus:outline-none"
                value={form.instructions}
                onChange={(e) => set('instructions', e.target.value)}
                placeholder={t('tasksPage.form.instructionsPh', { defaultValue: '到点后发给 AI 的消息,例如:汇总昨日日志的关键指标成表格。' })}
              />
              {/* 大输入框底部内嵌 项目 与 模型 两个选择:自定义弹层(搜索 +
                  名称/路径两行 + 选中勾,对照 Claude 官方截图),项目下拉底部
                  带「新建项目 / 其他目录…」,模型选项来自真实模型目录。 */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/60 px-2 py-1.5">
                <FancySelect
                  variant="chip"
                  className="max-w-[55%] flex-1"
                  value={form.projectPath}
                  onChange={(next) => set('projectPath', next)}
                  placeholder={t('tasksPage.form.pickProject', { defaultValue: '选择项目…' })}
                  searchable
                  searchPlaceholder={t('tasksPage.select.searchProjects', { defaultValue: '搜索项目…' })}
                  options={projectOptions}
                  footer={(close) => <BrowseFolderFooter onBrowse={() => setBrowsingFolder(true)} close={close} />}
                />
                <FancySelect
                  variant="chip"
                  className="w-44"
                  value={form.model}
                  onChange={(next) => set('model', next)}
                  placeholder={t('tasksPage.form.defaultModel', { defaultValue: '默认模型' })}
                  options={modelOptions}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>{t('tasksPage.form.frequency', { defaultValue: '频率' })}</label>
              <FancySelect
                variant="field"
                value={form.frequency}
                onChange={(next) => set('frequency', next as FormState['frequency'])}
                options={[
                  { value: 'manual', label: t('tasksPage.freq.manual', { defaultValue: '手动触发' }) },
                  { value: 'hourly', label: t('tasksPage.freqOpt.hourly', { defaultValue: '每小时' }) },
                  { value: 'daily', label: t('tasksPage.freqOpt.daily', { defaultValue: '每天' }) },
                  { value: 'weekdays', label: t('tasksPage.freqOpt.weekdays', { defaultValue: '工作日' }) },
                  { value: 'weekly', label: t('tasksPage.freqOpt.weekly', { defaultValue: '每周' }) },
                  { value: 'monthly', label: t('tasksPage.freqOpt.monthly', { defaultValue: '每月' }) },
                ]}
              />
            </div>
            <div>
              <label className={label}>{t('tasksPage.form.time', { defaultValue: '时刻' })}</label>
              <div className="flex items-center gap-1.5">
                {form.frequency === 'weekly' && (
                  <FancySelect
                    variant="field"
                    className="w-28 flex-none"
                    value={String(form.runAtWeekday)}
                    onChange={(next) => set('runAtWeekday', Number(next))}
                    options={Array.from({ length: 7 }, (_, index) => ({
                      value: String(index),
                      label: weekdayName(index, i18n.language),
                    }))}
                  />
                )}
                {form.frequency === 'monthly' && (
                  <input type="number" min={1} max={28} placeholder="1" className={`${field} w-20`} value={form.runAtDay}
                    onChange={(e) => setClamped('runAtDay', e.target.value, 1, 28)} />
                )}
                {form.frequency !== 'hourly' && form.frequency !== 'manual' && (
                  <input type="number" min={0} max={23} placeholder="9" className={`${field} w-20`} value={form.runAtHour}
                    onChange={(e) => setClamped('runAtHour', e.target.value, 0, 23)} />
                )}
                {form.frequency !== 'manual' && (
                  <>
                    <span className="text-muted-foreground">:</span>
                    <input type="number" min={0} max={59} placeholder="0" className={`${field} w-20`} value={form.runAtMinute}
                      onChange={(e) => setClamped('runAtMinute', e.target.value, 0, 59)} />
                  </>
                )}
                {form.frequency === 'manual' && (
                  <span className="text-[12.5px] text-muted-foreground">{t('tasksPage.form.manualHint', { defaultValue: '只在点「立即运行」时执行' })}</span>
                )}
              </div>
            </div>
            <div>
              <label className={label}>{t('tasksPage.form.sessionMode', { defaultValue: '会话' })}</label>
              <FancySelect
                variant="field"
                value={form.sessionMode}
                onChange={(next) => set('sessionMode', next as 'fixed' | 'new')}
                options={[
                  { value: 'fixed', label: t('tasksPage.form.sessionFixed', { defaultValue: '固定会话(历史连续,推荐)' }) },
                  { value: 'new', label: t('tasksPage.form.sessionNew', { defaultValue: '每次新建会话' }) },
                ]}
              />
            </div>
            <div>
              <label className={label}>{t('tasksPage.form.permissions', { defaultValue: '权限' })}</label>
              <FancySelect
                variant="field"
                value={form.permissionMode}
                onChange={(next) => set('permissionMode', next)}
                options={[
                  { value: 'bypassPermissions', label: t('tasksPage.form.permAuto', { defaultValue: '自动执行(无人值守)' }) },
                  { value: 'acceptEdits', label: t('tasksPage.form.permEdits', { defaultValue: '自动批准编辑' }) },
                  { value: 'default', label: t('tasksPage.form.permDefault', { defaultValue: '默认(工具需审批,无人在会挂起)' }) },
                ]}
              />
            </div>
          </div>

          {form.sessionMode === 'fixed' && (
            <div>
              <label className={label}>{t('tasksPage.form.targetSession', { defaultValue: '目标会话' })}</label>
              <FancySelect
                variant="field"
                searchable
                searchPlaceholder={t('tasksPage.select.searchSessions', { defaultValue: '搜索会话…' })}
                value={form.fixedSessionId}
                onChange={(next) => set('fixedSessionId', next)}
                placeholder={t('tasksPage.form.targetSessionAuto', { defaultValue: '自动新建一个并固定(默认)' })}
                options={sessionOptions}
              />
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="rounded-md border border-border bg-card px-4 py-2 text-sm text-foreground hover:border-border-strong">
            {t('tasksPage.form.cancel', { defaultValue: '取消' })}
          </button>
          <button type="button" onClick={() => void submit()} disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary-hover disabled:opacity-60">
            {saving ? t('tasksPage.form.saving', { defaultValue: '保存中…' }) : t('tasksPage.form.save', { defaultValue: '保存任务' })}
          </button>
        </div>
      </div>

      {/* 「选择其它目录…」的文件夹浏览器 —— 与创建新项目向导用的是同一个组件 */}
      <FolderBrowserModal
        isOpen={browsingFolder}
        autoAdvanceOnSelect={false}
        onClose={() => setBrowsingFolder(false)}
        onFolderSelected={(folderPath) => {
          setBrowsingFolder(false);
          if (folderPath) set('projectPath', folderPath);
        }}
      />
    </div>
  );
}

/* ── 主页面 ───────────────────────────────────────────────────────── */

export default function TasksPage({ selectedProject, selectedSession, setActiveTab, onNavigateToSession }: TasksPageProps) {
  const { t, i18n } = useTranslation('common');
  const { toast } = useToast();
  const [tasks, setTasks] = useState<WireTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<{ editingId: string | null; initial: FormState } | null>(null);
  // 项目目录与模型目录都走共享 hook。
  const projects = useProjectRows();
  const { models, defaultModelReal } = useModelCatalog();

  const refresh = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/tasks');
      const payload = await response.json();
      if (response.ok) setTasks((payload.tasks ?? []) as WireTask[]);
    } catch { /* 列表读不到就保持现状 */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // 运行状态是活的:页面开着时轻轮询
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter((task) => `${task.name}\n${task.instructions}`.toLowerCase().includes(needle));
  }, [tasks, query]);

  const detail = detailId ? tasks.find((task) => task.id === detailId) ?? null : null;

  /* ── 运行记录 ────────────────────────────────────────────────────
   * 不塞进任务列表接口:列表一次几十个任务,每个都带一串运行记录,
   * 而这东西只有点开详情才看得到。单独一个分页接口,按需拉。
   */
  const [runs, setRuns] = useState<WireRun[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsShown, setRunsShown] = useState(RUNS_PAGE);

  const loadRuns = useCallback(async (taskId: string, limit: number) => {
    setRunsLoading(true);
    try {
      const response = await authenticatedFetch(`/api/tasks/${taskId}/runs?limit=${limit}`);
      if (!response.ok) return;
      const payload = await response.json();
      setRuns(Array.isArray(payload.runs) ? payload.runs : []);
      setRunsTotal(Number(payload.total) || 0);
    } catch {
      /* 拿不到就维持原样,详情页其余部分照常 */
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!detailId) { setRuns([]); setRunsTotal(0); setRunsShown(RUNS_PAGE); return; }
    void loadRuns(detailId, RUNS_PAGE);
  }, [detailId, loadRuns]);

  // 跑完一轮(running 由 true 变 false)就把记录重拉一次,不用手工刷新
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(detail?.running);
    if (wasRunning.current && !running && detailId) void loadRuns(detailId, runsShown);
    wasRunning.current = running;
  }, [detail?.running, detailId, loadRuns, runsShown]);


  const emptyForm = (): FormState => ({
    name: '', instructions: '',
    projectPath: selectedProject?.fullPath || selectedProject?.path || projects[0]?.path || '',
    frequency: 'daily', runAtHour: 9, runAtMinute: 0, runAtWeekday: 1, runAtDay: 1,
    sessionMode: 'fixed', fixedSessionId: '', model: '', permissionMode: 'bypassPermissions',
  });

  const openEdit = (task: WireTask) => setModal({
    editingId: task.id,
    initial: {
      name: task.name, instructions: task.instructions, projectPath: task.projectPath,
      frequency: task.frequency, runAtHour: task.runAtHour ?? 9, runAtMinute: task.runAtMinute ?? 0,
      runAtWeekday: task.runAtWeekday ?? 1, runAtDay: task.runAtDay ?? 1,
      sessionMode: task.sessionMode, fixedSessionId: task.fixedSessionId ?? '',
      model: task.model ?? '', permissionMode: task.permissionMode,
    },
  });

  /**
   * ea:三个动作原来都可能**静默失败**。
   *
   * `patchTask` 的 `await response.json()` 没有兜底 —— 代理拦下请求回一页 HTML
   * (或干脆断连),json() 一抛整个 async 函数就以未处理拒绝收场:没有 toast、
   * 状态不变、控制台里也只有一行 Unhandled rejection。用户看到的就是"开关点了
   * 没反应"(Windows 实测)。删除那条更彻底:非 ok 连 toast 都没有。
   * 网络层的失败一律要说出来 —— 带上状态码,排查时才知道是代理拦的还是服务端拒的。
   */
  const describeFailure = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return message === 'Failed to fetch' || /NetworkError|Load failed/.test(message)
      ? '网络请求没有发出去(可能被代理拦截),请检查网络后重试'
      : message;
  };
  const readPayload = async (response: Response): Promise<{ task?: WireTask; error?: string }> =>
    (await response.json().catch(() => ({}))) as { task?: WireTask; error?: string };
  const failureMessage = (response: Response, payload: { error?: string }, fallback: string) =>
    payload.error || `${fallback}(HTTP ${response.status})`;

  const patchTask = async (id: string, body: Record<string, unknown>) => {
    try {
      const response = await authenticatedFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const payload = await readPayload(response);
      if (response.ok && payload.task) {
        const saved = payload.task;
        setTasks((current) => current.map((task) => (task.id === id ? saved : task)));
      } else {
        toast({ message: failureMessage(response, payload, '操作失败'), variant: 'error' });
      }
    } catch (error) {
      toast({ message: `操作失败:${describeFailure(error)}`, variant: 'error' });
    }
  };

  const removeTask = async (task: WireTask) => {
    if (!window.confirm(t('tasksPage.confirmDelete', { name: task.name, defaultValue: '删除定时任务「{{name}}」?此操作不可撤销。' }))) return;
    try {
      const response = await authenticatedFetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (response.ok) {
        setTasks((current) => current.filter((item) => item.id !== task.id));
        setDetailId(null);
      } else {
        const payload = await readPayload(response);
        toast({ message: failureMessage(response, payload, '删除失败'), variant: 'error' });
      }
    } catch (error) {
      toast({ message: `删除失败:${describeFailure(error)}`, variant: 'error' });
    }
  };

  const runNow = async (task: WireTask) => {
    try {
      const response = await authenticatedFetch(`/api/tasks/${task.id}/run`, { method: 'POST' });
      const payload = await readPayload(response);
      if (response.ok) {
        toast({ message: t('tasksPage.runStarted', { defaultValue: '任务已开始执行,可进入目标会话旁观。' }), variant: 'success' });
        void refresh();
      } else {
        toast({
          message: payload.error === 'already_running'
            ? t('tasksPage.alreadyRunning', { defaultValue: '任务正在运行中' })
            : failureMessage(response, payload, '启动失败'),
          variant: 'error',
        });
      }
    } catch (error) {
      toast({ message: `启动失败:${describeFailure(error)}`, variant: 'error' });
    }
  };

  /**
   * 「新建任务」的主路径(cm 轮起是默认入口):页面上只发一句人话,让 Claude
   * 解析需求、缺什么问什么;票据与接口用法作为**隐藏上下文**随消息带给模型 ——
   * 气泡和历史里不出现 curl。
   *
   * 会话归属这件事在 cm 轮才算说清楚。以前隐藏说明里只有"最近会话清单",模型
   * 选了 `fixed` 却没填 id,服务端就新开了一个会话 —— 用户以为"固定"却看见
   * 侧栏多出一条(用户反馈)。现在:
   * - 领票时把**当前所在对话**随票记在服务端,模型写 `sessionMode:"current"`
   *   即可绑定它,**不用手抄 UUID**;
   * - 隐藏说明要求模型把「写进当前对话 / 新开专属会话」作为选择题问用户,
   *   不许自己替用户决定。
   */
  const createWithClaude = async () => {
    setMenuOpen(false);
    const projectPath = selectedProject?.fullPath || selectedProject?.path || '';
    if (!projectPath) {
      toast({ message: t('tasksPage.needProject', { defaultValue: '先在左侧选一个项目,再让 AI 帮你建任务。' }), variant: 'error' });
      return;
    }
    try {
      const currentSessionId = selectedSession?.id || '';
      const response = await authenticatedFetch('/api/tasks/ticket', {
        method: 'POST',
        body: JSON.stringify(currentSessionId ? { originSessionId: currentSessionId } : {}),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '领票据失败');
      const ticket = payload.ticket as string;
      const hasOriginSession = payload.hasOriginSession === true;
      const origin = window.location.origin;
      const now = new Date();

      const sessionLines = hasOriginSession
        ? [
          '会话归属有两种,**必须让用户二选一**(用选择题问,不要替他决定):',
          '  (1)写进他当前正在聊的这条对话 → `"sessionMode":"current"`(服务端已记住是哪条,你不用填 id);',
          '  (2)新开一个专属会话、以后每次都写那里 → `"sessionMode":"fixed"` 且不填 fixedSessionId(首次运行时自动创建并长期固定);',
          '  另有 `"sessionMode":"new"` = 每次运行都新开一条,只在用户明确要"每次都新的"时用。',
        ]
        : [
          '会话归属有两种,**必须让用户二选一**(用选择题问,不要替他决定):',
          '  (1)新开一个专属会话、以后每次都写那里 → `"sessionMode":"fixed"` 且不填 fixedSessionId;',
          '  (2)每次运行都新开一条 → `"sessionMode":"new"`。',
          '  (当前没有可绑定的对话,所以没有"写进当前对话"这个选项。)',
        ];

      const text = '我想设置一个定时任务。先简单说明 Prism 的定时任务是怎么工作的,然后问我几个问题,弄清楚要让 Claude 定期做什么、什么时候运行、结果写到哪个会话;我确认后你就直接创建,并把任务名、频率和下一次运行时间告诉我。';
      const hiddenContext = [
        '[系统随消息附带的技术说明,用户在页面上看不到这段;不要复述它,更不要把 ticket 展示出来]',
        `现在是 ${now.toLocaleString()}(服务器与用户同一时区,偏移 UTC${-now.getTimezoneOffset() / 60 >= 0 ? '+' : ''}${-now.getTimezoneOffset() / 60});任务的时刻按这个时区理解。`,
        '需求里缺哪一项就问哪一项(任务名、要做什么、多久跑一次、几点跑、写进哪个会话),能从用户话里推断出来的不要多问;一次问全,别挤牙膏。',
        ...sessionLines,
        '',
        '配置齐了之后用这条命令创建(ticket 只许建这一次,30 分钟内有效):',
        `curl -s -X POST '${origin}/api/tasks/via-ticket' -H 'X-Prism-Task-Ticket: ${ticket}' -H 'Content-Type: application/json' -d '<JSON>'`,
        `JSON 字段:name(任务名)、instructions(到点发给 Claude 的指令)、projectPath(不特别指定就用 ${projectPath})、frequency(manual/hourly/daily/weekdays/weekly/monthly)、runAtHour(0-23)、runAtMinute(0-59);weekly 另加 runAtWeekday(0=周日…6=周六);monthly 另加 runAtDay(1-28);sessionMode 见上;permissionMode 默认 bypassPermissions。`,
        `建错了可在票据有效期内用同一票据撤销刚建的那一个:curl -s -X DELETE '${origin}/api/tasks/via-ticket/<创建返回的 task id>' -H 'X-Prism-Task-Ticket: ${ticket}' —— 票据只能删它自己建的这一个;其它修改/删除请让用户到「定时任务」页操作,你没有那些权限。`,
        '创建成功后把任务名、频率、下一次运行时间、以及结果会写进哪个会话复述给用户;失败则把错误原因告诉用户。',
      ].join('\n');
      window.dispatchEvent(new CustomEvent('prism:send-chat-message', { detail: { text, hiddenContext } }));
      setActiveTab('chat');
      toast({ message: t('tasksPage.claudeStarted', { defaultValue: '已把需求发给 AI,到对话页继续聊即可。' }), variant: 'success' });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : '发起失败', variant: 'error' });
    }
  };

  /* ── 详情视图 ── */
  if (detail) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          <button type="button" onClick={() => setDetailId(null)}
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> {t('tasksPage.back', { defaultValue: '返回任务列表' })}
          </button>

          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-foreground">{detail.name}</h1>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{detail.instructions}</p>
            </div>
            <div className="flex flex-none items-center gap-2">
              <button type="button" onClick={() => openEdit(detail)} title={t('tasksPage.edit', { defaultValue: '编辑' })}
                className="rounded-md border border-border p-2 text-muted-foreground hover:border-border-strong hover:text-foreground">
                <Pencil className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => void removeTask(detail)} title={t('tasksPage.delete', { defaultValue: '删除' })}
                className="rounded-md border border-border p-2 text-muted-foreground hover:border-border-strong hover:text-foreground">
                <Trash2 className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => void runNow(detail)} disabled={detail.running}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60">
                {detail.running
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> {t('tasksPage.running', { defaultValue: '运行中' })}</>
                  : <><Play className="h-4 w-4" /> {t('tasksPage.runNow', { defaultValue: '立即运行' })}</>}
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3">
            {/* 启停开关 */}
            <button
              type="button"
              role="switch"
              aria-checked={detail.enabled}
              onClick={() => void patchTask(detail.id, { enabled: !detail.enabled })}
              className={`relative h-5 w-9 rounded-full transition-colors ${detail.enabled ? 'bg-primary' : 'bg-border-strong/50'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${detail.enabled ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-xs ${detail.enabled ? 'border-primary/30 bg-primary/10 text-foreground' : 'border-border bg-muted text-muted-foreground'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${detail.enabled ? 'bg-primary' : 'bg-muted-foreground/60'}`} />
              {detail.enabled ? t('tasksPage.enabled', { defaultValue: '启用中' }) : t('tasksPage.paused', { defaultValue: '已暂停' })}
            </span>
            {detail.running && (
              <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                <Loader2 className="h-3 w-3 animate-spin" /> {t('tasksPage.running', { defaultValue: '运行中' })}
              </span>
            )}
          </div>

          <div className="mt-6 grid grid-cols-1 gap-8 border-t border-border pt-6 md:grid-cols-[280px_1fr]">
            {/* 左栏:最近运行 */}
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{t('tasksPage.history', { defaultValue: '运行记录' })}</h3>
              {runs.length > 0 ? (
                <>
                  <ul className="space-y-px">
                    {runs.map((run) => (
                      <li key={run.id} className="border-b border-border py-2 last:border-b-0">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-foreground">{formatWhen(run.finishedAt)}</span>
                          <span className={`shrink-0 rounded px-1.5 py-px text-[11.5px] font-medium ${run.status === 'completed' ? 'bg-primary/10 text-foreground' : 'bg-destructive/10 text-destructive'}`}>
                            {run.status === 'completed'
                              ? t('tasksPage.statusOk', { defaultValue: '成功' })
                              : t('tasksPage.statusFail', { defaultValue: '失败' })}
                            {` · ${Math.max(1, Math.round(run.durationMs / 1000))}s`}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                          <span>
                            {run.trigger === 'manual'
                              ? t('tasksPage.triggerManual', { defaultValue: '手动' })
                              : t('tasksPage.triggerSchedule', { defaultValue: '定时' })}
                          </span>
                          {run.sessionId && onNavigateToSession && (
                            <button type="button"
                              onClick={() => { onNavigateToSession(run.sessionId!); setActiveTab('chat'); }}
                              className="text-primary hover:underline">
                              {t('tasksPage.openRunSession', { defaultValue: '看这次的会话' })}
                            </button>
                          )}
                        </div>
                        {run.status === 'failed' && run.detail && (
                          <p className="mt-1 break-words text-xs text-muted-foreground">{run.detail}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                  {runs.length < runsTotal && (
                    <button type="button" disabled={runsLoading}
                      onClick={() => {
                        const next = runsShown + RUNS_PAGE;
                        setRunsShown(next);
                        if (detailId) void loadRuns(detailId, next);
                      }}
                      className="mt-2 block text-sm text-primary hover:underline disabled:opacity-50">
                      {t('tasksPage.moreRuns', { count: runsTotal - runs.length, defaultValue: '看更早的({{count}} 条)' })}
                    </button>
                  )}
                </>
              ) : detail.lastRunAt ? (
                // 存量任务:cz 之前跑的那些没有明细行,只剩摘要,照旧显示一条。
                <div className="flex items-center justify-between gap-2 border-b border-border pb-2 text-sm">
                  <span className="text-foreground">{formatWhen(detail.lastRunAt)}</span>
                  <span className={`rounded px-1.5 py-px text-[11.5px] font-medium ${detail.lastRunStatus === 'completed' ? 'bg-primary/10 text-foreground' : 'bg-muted text-muted-foreground'}`}>
                    {detail.lastRunStatus === 'completed'
                      ? t('tasksPage.statusOk', { defaultValue: '成功' })
                      : t('tasksPage.statusFail', { defaultValue: '失败' })}
                    {detail.lastRunDurationMs ? ` · ${Math.round(detail.lastRunDurationMs / 1000)}s` : ''}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('tasksPage.neverRan', { defaultValue: '还没有跑过。' })}</p>
              )}
              {runs.length === 0 && detail.lastRunStatus === 'failed' && detail.lastRunDetail && (
                <p className="mt-2 break-words text-xs text-muted-foreground">{detail.lastRunDetail}</p>
              )}
              {detail.sessionPath && (
                <button type="button"
                  onClick={() => {
                    const sessionId = detail.fixedSessionId;
                    if (sessionId && onNavigateToSession) { onNavigateToSession(sessionId); setActiveTab('chat'); }
                  }}
                  className="mt-3 block text-sm text-primary hover:underline">
                  {t('tasksPage.openSession', { defaultValue: '打开目标会话 →' })}
                </button>
              )}
            </div>

            {/* 右栏:指令/目标/频率 */}
            <div className="min-w-0 space-y-5">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('tasksPage.instructions', { defaultValue: '执行指令' })}</h3>
                <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 text-sm leading-6 text-foreground">
                  {detail.instructions}
                </div>
              </div>
              <div>
                <h3 className="mb-1.5 text-sm font-semibold text-muted-foreground">{t('tasksPage.target', { defaultValue: '目标' })}</h3>
                <p className="break-all text-sm text-foreground">
                  📁 {detail.projectPath}
                  <span className="ml-2 text-muted-foreground">
                    {detail.sessionMode === 'fixed'
                      ? t('tasksPage.fixedSession', { defaultValue: '固定会话' })
                      : t('tasksPage.newSession', { defaultValue: '每次新建会话' })}
                  </span>
                </p>
                {/* 固定会话到底固定在哪个会话上 —— 写出完整 id(用户点名),
                    点它直接跳过去;还没跑过时说明第一次运行会自动建一个。 */}
                {detail.sessionMode === 'fixed' && (
                  detail.fixedSessionId ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (onNavigateToSession) { onNavigateToSession(detail.fixedSessionId!); setActiveTab('chat'); }
                      }}
                      title={t('tasksPage.openSession', { defaultValue: '打开目标会话 →' })}
                      className="mt-1 block break-all text-left font-mono text-[11.5px] leading-4 text-muted-foreground hover:text-primary hover:underline"
                    >
                      {detail.fixedSessionId}
                    </button>
                  ) : (
                    <p className="mt-1 text-[11.5px] leading-4 text-muted-foreground">
                      {t('tasksPage.fixedSessionPending', { defaultValue: '首次运行时自动创建并固定' })}
                    </p>
                  )
                )}
              </div>
              <div>
                <h3 className="mb-1.5 text-sm font-semibold text-muted-foreground">{t('tasksPage.repeats', { defaultValue: '重复' })}</h3>
                <p className="text-sm text-foreground">{frequencyLabel(detail, t, i18n.language)}
                  {detail.nextRunAt && detail.enabled && (
                    <span className="ml-2 text-muted-foreground">{t('tasksPage.nextRun', { when: formatWhen(detail.nextRunAt), defaultValue: '下一次:{{when}}' })}</span>
                  )}
                </p>
              </div>
              {(detail.model || detail.permissionMode !== 'bypassPermissions') && (
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold text-muted-foreground">{t('tasksPage.execution', { defaultValue: '执行配置' })}</h3>
                  <p className="text-sm text-foreground">
                    {/* 与下拉同一份文案(实际模型名,已知网关模型则括在后面) */}
                    {t('tasksPage.modelIs', {
                      model: detail.model
                        ? models.find((model) => model.value === detail.model)?.label ?? detail.model
                        : (defaultModelReal
                          ? `${t('tasksPage.defaultModel', { defaultValue: '默认模型' })}(${defaultModelReal})`
                          : t('tasksPage.defaultModel', { defaultValue: '默认模型' })),
                      defaultValue: '模型 {{model}}',
                    })}
                    <span className="ml-2 text-muted-foreground">{detail.permissionMode}</span>
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {modal && (
          <TaskFormModal
            initial={modal.initial}
            editingId={modal.editingId}
            projects={projects}
            models={models}
            defaultModelReal={defaultModelReal}
            onClose={() => setModal(null)}
            onSaved={(task) => { setTasks((current) => current.map((item) => (item.id === task.id ? task : item))); }}
          />
        )}
      </div>
    );
  }

  /* ── 列表视图 ── */
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-foreground">
              <Clock className="h-5 w-5" /> {t('tasksPage.title', { defaultValue: '定时任务' })}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('tasksPage.subtitle', { defaultValue: '按计划或随时手动执行任务,结果写进目标会话。服务端调度,浏览器关了也照跑。' })}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('tasksPage.searchPh', { defaultValue: '搜索任务…' })}
                className="w-44 rounded-md border border-border bg-background py-2 pl-8 pr-2 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            {/* 一个按钮,点开永远是同一份选项(用户点名):按钮本体和小箭头都
                只负责"展开怎么建",不直接触发任何一种 —— 直接跳走会让人措手不及。
                菜单里「让 Claude 创建」排第一,是推荐路径。 */}
            <div className="relative flex-none">
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                title={t('tasksPage.newTaskHint', { defaultValue: '选择创建方式:让 AI 问齐细节,或自己填表' })}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                <Plus className="h-4 w-4" /> {t('tasksPage.newTask', { defaultValue: '新建任务' })}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                  <div role="menu" className="prism-modal-shadow absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover py-1">
                    <button type="button" role="menuitem" onClick={() => void createWithClaude()}
                      className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-muted">
                      <Bot className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{t('tasksPage.createWithClaude', { defaultValue: '让 AI 创建' })}</span>
                        <span className="block text-[11.5px] leading-4 text-muted-foreground">
                          {t('tasksPage.createWithClaudeHint', { defaultValue: '说一句需求,缺的细节它会问你' })}
                        </span>
                      </span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setModal({ editingId: null, initial: emptyForm() }); }}
                      className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-muted">
                      <Settings2 className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{t('tasksPage.setupManually', { defaultValue: '手动填写表单' })}</span>
                        <span className="block text-[11.5px] leading-4 text-muted-foreground">
                          {t('tasksPage.setupManuallyHint', { defaultValue: '自己填名称、频率、目标会话' })}
                        </span>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {loading ? (
          <p className="mt-10 text-center text-sm text-muted-foreground">{t('tasksPage.loading', { defaultValue: '加载中…' })}</p>
        ) : filtered.length === 0 ? (
          <div className="mt-14 text-center">
            <Clock className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-3 text-sm text-muted-foreground">
              {tasks.length === 0
                ? t('tasksPage.empty', { defaultValue: '还没有定时任务。点右上角「新建任务」,让 AI 问齐细节帮你建,或自己填表。' })
                : t('tasksPage.noMatch', { defaultValue: '没有匹配的任务。' })}
            </p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
            {filtered.map((task) => (
              <button key={task.id} type="button" onClick={() => setDetailId(task.id)}
                className="rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-border-strong">
                <div className="text-[15px] font-semibold text-foreground">{task.name}</div>
                <div className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">{task.instructions}</div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {task.running ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-px text-[11.5px] font-medium text-primary">
                      <Loader2 className="h-3 w-3 animate-spin" /> {t('tasksPage.running', { defaultValue: '运行中' })}
                    </span>
                  ) : task.enabled ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-px text-[11.5px] text-foreground">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {t('tasksPage.enabled', { defaultValue: '启用中' })}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-px text-[11.5px] text-muted-foreground">
                      ⏸ {t('tasksPage.paused', { defaultValue: '已暂停' })}
                    </span>
                  )}
                  <span className="rounded-md border border-border bg-background px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                    {frequencyLabel(task, t, i18n.language)}
                  </span>
                  {task.enabled && task.nextRunAt && (
                    <span className="text-[11.5px] text-muted-foreground">
                      {t('tasksPage.nextRun', { when: formatWhen(task.nextRunAt), defaultValue: '下一次:{{when}}' })}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {modal && (
        <TaskFormModal
          initial={modal.initial}
          editingId={modal.editingId}
          projects={projects}
          models={models}
          defaultModelReal={defaultModelReal}
          onClose={() => setModal(null)}
          onSaved={(task) => {
            setTasks((current) => {
              const exists = current.some((item) => item.id === task.id);
              return exists ? current.map((item) => (item.id === task.id ? task : item)) : [task, ...current];
            });
          }}
        />
      )}
    </div>
  );
}
