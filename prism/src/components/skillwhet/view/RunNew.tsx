import { useEffect, useMemo, useState } from 'react';
import { Info, Loader2, Play, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { NumberInput, useToast } from '../../../shared/view/ui';
import { useModelCatalog } from '../../../hooks/useTaskLikeOptions';
import { unwrap, type Budget, type ManagedSkill, type PyramidResult, type TaskSummary } from '../lib/types';

import SkillWhetModelSelect from './SkillWhetModelSelect';
import { Badge } from './StatusStrip';

/**
 * 新建训练。表单字段 ↔ `whet train` 旗标(服务端白名单校验)。费用 / 时长超过 .env 上限时,非 root 直接拦下并说明
 * 怎么改,root 可越过到硬上限(审计记一笔);服务端仍会钳住其余超限参数,并把被钳的参数名回给页面。
 * 非 root 先看两条硬前置:G1 安全门 PASS、今日剩余额度,任一不满足按钮灰掉并说原因。
 * 提交失败的原话留在表单上,成功后显示排队位次。
 */
type RunNewProps = {
  skills: ManagedSkill[];
  taskSummary: TaskSummary[];
  isRoot: boolean;
  username: string;
  initialSkill?: string | null;
  onCreated: (jobId: string) => void;
};

/** 拿不到预算、或服务端不回 allowedModels 时,非 root 的兜底名单。 */
const FALLBACK_MODELS = ['haiku', 'sonnet', 'opus'];

export default function RunNew({ skills, taskSummary, isRoot, username, initialSkill, onCreated }: RunNewProps) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const mine = useMemo(() => skills.filter((s) => isRoot || (s.source === 'upload' && s.uploaded_by === username)), [skills, isRoot, username]);
  const [skill, setSkill] = useState(initialSkill ?? '');
  const [budget, setBudget] = useState<Budget | null>(null);
  const [gate, setGate] = useState<PyramidResult & { cached?: boolean } | null>(null);
  const [rounds, setRounds] = useState(2);
  const [runner, setRunner] = useState<'pytest' | 'agent' | 'simulate' | 'mixed'>('pytest');
  const [runnerTouched, setRunnerTouched] = useState(false);
  const [maxCost, setMaxCost] = useState('');
  const [maxMinutes, setMaxMinutes] = useState('');
  const [fastModel, setFastModel] = useState('haiku');
  const [slowModel, setSlowModel] = useState('sonnet');
  const [evalModel, setEvalModel] = useState('opus');
  const [advanced, setAdvanced] = useState(false);
  const [k, setK] = useState(4);
  const [budgetP2, setBudgetP2] = useState(6);
  const [refine, setRefine] = useState(1);
  const [workers, setWorkers] = useState(2);
  const [judgeSamples, setJudgeSamples] = useState(1);
  const [noAccept, setNoAccept] = useState(2);
  const [mock, setMock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 模型从目录选(与对话同一份);非 root 只列允许的(服务端 /jobs/budget 的 allowedModels)
  const { models: catalogModels, aliasModels, realModels } = useModelCatalog();

  useEffect(() => {
    // 只能选自己能训练的:预选的 skill 不在名单里(非 root 从技能库卡片跳过来)就换成第一个
    if (mine.length === 0) { if (skill) setSkill(''); return; }
    if (!skill || !mine.some((s) => s.name === skill)) setSkill(initialSkill && mine.some((s) => s.name === initialSkill) ? initialSkill : mine[0].name);
  }, [skill, mine, initialSkill]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await unwrap<Budget>(await api.skillWhet.jobBudget());
        if (cancelled) return;
        setBudget(data);
        // 非 root 的默认费用上限:不超过今天剩下的额度,免得一打开就是"额度不够"
        if (!data.isRoot) {
          const remaining = Math.max(0, data.userDailyMaxCostUsd - data.spentToday);
          setMaxCost((prev) => (prev === '' ? String(Math.min(data.maxCostUsd, Math.floor(remaining * 100) / 100)) : prev));
        }
      } catch { /* 拿不到预算就不画那一行 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setGate(null);
    if (!skill) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const data = await unwrap<PyramidResult & { cached?: boolean }>(await api.skillWhet.gate(skill, false));
        if (!cancelled) setGate(data);
      } catch { if (!cancelled) setGate(null); }
    })();
    return () => { cancelled = true; };
  }, [skill]);

  const selected = skills.find((s) => s.name === skill) ?? null;
  // 默认 runner 跟着 skill 走:有 tests/unit 用 pytest(零模型费),没有就 agent;手动改过就不再动
  const hasUnitTests = selected?.has_unit_tests ?? null;
  useEffect(() => {
    if (hasUnitTests === null || runnerTouched) return;
    setRunner(hasUnitTests ? 'pytest' : 'agent');
  }, [skill, hasUnitTests, runnerTouched]);
  const tasks = taskSummary.find((row) => row.skill === skill) ?? null;
  const g1 = gate?.results?.find((r) => r.gate === 'G1.security') ?? null;
  const g1Pass = Boolean(gate?.cached && g1?.verdict === 'pass');
  const remaining = budget ? Math.max(0, budget.userDailyMaxCostUsd - budget.spentToday) : null;
  const costCap = budget?.maxCostUsd ?? 2;
  const minutesCap = (budget?.maxHours ?? 2) * 60;
  // .env 的上限只管非 root;root 可以填到硬上限(超过 .env 的那一次审计记 cost_override)
  const costHard = isRoot ? (budget?.hardMaxCostUsd ?? costCap) : costCap;
  const minutesHard = isRoot ? (budget?.hardMaxHours ?? minutesCap / 60) * 60 : minutesCap;
  const costAsked = Number(maxCost) > 0 ? Number(maxCost) : costCap;
  const minutesAsked = Number(maxMinutes) > 0 ? Number(maxMinutes) : minutesCap;
  const effectiveCost = Math.min(costAsked, costHard);
  // 服务端(夜训与训练器 Roles.validate)要求评估模型既不同于慢环、也不同于快环。
  // 按真实模型比:`opus` 映射到 glm-5.2 时,与直接选 glm-5.2 是同一个模型(服务端同样按真名拦)。
  const realOf = (model: string) => realModels[model] ?? model;
  const sameModel = (realOf(evalModel) === realOf(slowModel) || realOf(evalModel) === realOf(fastModel)) && !mock;
  // 非 root:预算还没拿到、或服务端不回 allowedModels 时按三个别名收紧(不给手填),与服务端的默认一致
  const allowedModels = isRoot ? null : (budget?.allowedModels ?? FALLBACK_MODELS);
  const disallowed = Array.isArray(allowedModels)
    ? [fastModel, slowModel, evalModel].filter((model) => !allowedModels.includes(model))
    : [];
  const blockers: string[] = [];
  if (!selected) blockers.push(t('run.noSkill', { defaultValue: '先选一个自己能训练的 skill' }));
  else if (!selected.bootstrapped) blockers.push(t('run.notBootstrapped', { defaultValue: '这个副本还没 bootstrap(冻结 S₀)' }));
  if (selected && (!tasks || tasks.total === 0)) blockers.push(t('run.noTasks', { defaultValue: '这个 skill 还没有任务集' }));
  // G1 因服务器缺工具而 SKIP 时直说缺什么,不让人以为是 skill 的问题
  const g1Missing = Array.isArray(g1?.detail?.missing_tools) ? (g1?.detail?.missing_tools as unknown[]).map(String) : [];
  if (!isRoot && !g1Pass) blockers.push(g1 && g1.verdict === 'skip' && g1Missing.length > 0
    ? t('run.g1MissingTools', { defaultValue: 'G1 安全门没查成:服务器上缺 {{tools}},请管理员装好后重跑体检', tools: g1Missing.join(' / ') })
    : g1 ? t('run.g1Fail', { defaultValue: 'G1 安全门是 {{v}},非 root 不能起训练 —— 修好再体检', v: (g1.verdict ?? '').toUpperCase() }) : t('run.g1Unknown', { defaultValue: '还没体检过;先在技能资产页「重跑体检」' }));
  if (!isRoot && remaining !== null && effectiveCost > remaining) blockers.push(t('run.overBudget', { defaultValue: '今日剩余额度 ${{left}} 不够这次的费用上限 ${{cost}}', left: remaining.toFixed(2), cost: effectiveCost.toFixed(2) }));
  if (sameModel) blockers.push(t('run.sameModel', { defaultValue: '评估模型必须不同于提议模型(快环与慢环都不能同名;别名按它映射到的真实模型比)' }));
  if (disallowed.length > 0) blockers.push(t('run.modelNotAllowed', { defaultValue: '这些模型你不能用:{{list}}(管理员在模型目录里上架的、或 .env 白名单里的才行)', list: [...new Set(disallowed)].join('、') }));
  if (costAsked > costHard) {
    blockers.push(isRoot
      ? t('run.overHardCost', { defaultValue: '费用上限 ${{v}} 超过硬上限 ${{cap}}', v: costAsked, cap: costHard })
      : t('run.overCostCap', { defaultValue: '费用上限 ${{v}} 超过管理员设的单次上限 ${{cap}} —— 调低,或请管理员改 .env 的 PRISM_SKILLWHET_MAX_COST_USD', v: costAsked, cap: costCap }));
  }
  if (minutesAsked > minutesHard) {
    blockers.push(t('run.overMinutesCap', { defaultValue: '时长上限 {{v}} 分钟超过允许的 {{cap}} 分钟', v: minutesAsked, cap: minutesHard }));
  }
  // 以下只提示不拦,但要说清楚:比如没有 tests/unit 的副本用 pytest runner 时任务都不计分,训练只会安静地 no_signal。
  const warnings: string[] = [];
  if (selected && (runner === 'pytest' || runner === 'mixed') && !selected.has_unit_tests) {
    warnings.push(runner === 'pytest'
      ? t('run.pytestNoTests', { defaultValue: '这个副本没有 tests/unit/ —— pytest runner 下任务都不计分,训练只会 no_signal。用 agent(或先把测试挪进 tests/unit/)' })
      : t('run.mixedNoTests', { defaultValue: '这个副本没有 tests/unit/ —— mixed 里的 pytest 那一半不起作用' }));
  }
  if (isRoot && costAsked > costCap && costAsked <= costHard) {
    warnings.push(t('run.rootOverCost', { defaultValue: '超过 .env 的单次上限 ${{cap}}:root 可以越过,按你填的 ${{v}} 跑,审计记一笔 cost_override', cap: costCap, v: costAsked }));
  }
  if (isRoot && minutesAsked > minutesCap && minutesAsked <= minutesHard) {
    warnings.push(t('run.rootOverMinutes', { defaultValue: '超过 .env 的时长上限 {{cap}} 分钟:root 可以越过,按 {{v}} 分钟跑', cap: minutesCap, v: minutesAsked }));
  }
  if (tasks && tasks.total > 0 && tasks.splits.val < 3) {
    warnings.push(t('run.fewVal', { defaultValue: 'val 只有 {{n}} 条:分数只能是那几档,"有没有改进"没有分辨力;建议至少 5 条', n: tasks.splits.val }));
  }

  const submit = async () => {
    if (blockers.length > 0 || !skill) return;
    setBusy(true);
    setError(null);
    try {
      const args: Record<string, unknown> = {
        rounds, runner, k, budget_p2: budgetP2, refine, workers, judge_samples: judgeSamples, no_accept_rounds: noAccept,
        fast_model: fastModel, slow_model: slowModel, eval_model: evalModel,
      };
      if (Number(maxCost) > 0) args.max_cost_usd = Number(maxCost);
      if (Number(maxMinutes) > 0) args.max_minutes = Number(maxMinutes);
      if (mock && isRoot) Object.assign(args, { fast_backend: 'mock', slow_backend: 'mock', eval_backend: 'mock' });
      const data = await unwrap<{ job: { id: string }; position: number; clamped?: string[] }>(await api.skillWhet.jobCreate(skill, args));
      if (data.clamped && data.clamped.length > 0) {
        toast({ message: t('run.clamped', { defaultValue: '有参数超过上限,已按上限跑:{{list}}', list: data.clamped.join(',') }), variant: 'error' });
      }
      toast({ message: data.position > 0 ? t('run.queued', { defaultValue: '已排队,前面还有 {{n}} 个', n: data.position }) : t('run.started', { defaultValue: '已开始训练' }), variant: 'success' });
      onCreated(data.job.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus:border-primary focus:outline-none';
  const label = 'text-[11px] text-muted-foreground';

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4" data-testid="run-new">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">{t('run.title', { defaultValue: '新建训练' })}</h2>
        <span className="flex-1" />
        {isRoot && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={t('run.mockHint', { defaultValue: '离线 mock 后端:零费用,只验流程' })}>
            <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} /> mock
          </label>
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className={label}>skill</span>
        <select value={skill} onChange={(e) => setSkill(e.target.value)} className={`${field} font-mono`} aria-label="skill">
          {mine.length === 0 && <option value="">{t('run.noneAvailable', { defaultValue: '(没有你能训练的 skill —— 上传一个,或让 root 来)' })}</option>}
          {mine.map((s) => <option key={s.name} value={s.name}>{s.name}{s.source === 'upload' ? ` · ${t('run.uploadedBy', { defaultValue: '上传 · {{u}}', u: s.uploaded_by ?? '' })}` : ` · ${t('run.fromLibrary', { defaultValue: '技能库' })}`}</option>)}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        <div className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${g1Pass ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted text-muted-foreground'}`}>
          {g1Pass ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <ShieldOff className="h-3.5 w-3.5" aria-hidden />}
          {gate ? t('run.g1Line', { defaultValue: 'G1 安全门 {{v}}', v: (g1?.verdict ?? 'skip').toUpperCase() }) : t('run.g1None', { defaultValue: 'G1 安全门 未体检' })}
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5" aria-hidden />
          {isRoot
            ? t('run.rootNoLimit', { defaultValue: 'root 不受每日额度限制' })
            : t('run.remaining', { defaultValue: '今日剩余额度' })}
          {!isRoot && budget && <span className="ml-auto font-mono text-foreground">${remaining?.toFixed(2)} / ${budget.userDailyMaxCostUsd.toFixed(2)}</span>}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className={label}>{t('run.tasks', { defaultValue: '任务集' })}</span>
        <span className="font-mono text-body">{tasks ? `${tasks.total} · ${tasks.splits.train} / ${tasks.splits.val} / ${tasks.splits.test}` : t('run.tasksNone', { defaultValue: '无' })}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        <label className="flex flex-col gap-1"><span className={label}>runner</span>
          <select value={runner} onChange={(e) => { setRunnerTouched(true); setRunner(e.target.value as typeof runner); }} className={field} aria-label="runner">
            <option value="pytest">pytest</option><option value="mixed">mixed · pytest + agent</option><option value="agent">agent</option><option value="simulate">simulate</option>
          </select></label>
        <label className="flex flex-col gap-1"><span className={label}>{t('run.rounds', { defaultValue: '轮数' })}</span>
          <NumberInput integer min={1} max={20} value={rounds} onChange={(v) => setRounds(v ?? 1)} className={field} aria-label="rounds" /></label>
        <label className="flex flex-col gap-1"><span className={label}>{t('run.maxCost', { defaultValue: '费用上限 $' })}</span>
          {/* 不设 max:超了由下面的提示 / 拦截说清楚,不在离开输入框时悄悄改掉你填的数 */}
          <NumberInput allowEmpty min={0} step={0.5} value={maxCost === '' ? null : Number(maxCost)} placeholder={String(costCap)} onChange={(v) => setMaxCost(v === null ? '' : String(v))} className={field} aria-label="max_cost_usd" />
          <span className="text-[10px] text-muted-foreground" data-testid="cost-cap-hint">{isRoot
            ? t('run.capRoot', { defaultValue: '.env 上限 {{v}}(留空即用它);root 可填到 {{hard}},超出记审计', v: `$${costCap}`, hard: `$${costHard}` })
            : t('run.cap', { defaultValue: '上限 {{v}},由管理员配置', v: `$${costCap}` })}</span></label>
        <label className="flex flex-col gap-1"><span className={label}>{t('run.maxMinutes', { defaultValue: '时长上限(分钟)' })}</span>
          <NumberInput allowEmpty integer min={0} step={10} value={maxMinutes === '' ? null : Number(maxMinutes)} placeholder={String(minutesCap)} onChange={(v) => setMaxMinutes(v === null ? '' : String(v))} className={field} aria-label="max_minutes" />
          <span className="text-[10px] text-muted-foreground">{isRoot
            ? t('run.capRoot', { defaultValue: '.env 上限 {{v}}(留空即用它);root 可填到 {{hard}},超出记审计', v: String(minutesCap), hard: String(minutesHard) })
            : t('run.cap', { defaultValue: '上限 {{v}},由管理员配置', v: String(minutesCap) })}</span></label>
      </div>

      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('run.models', { defaultValue: '模型 · 评估模型必须不同于提议模型' })}</div>
      <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
        {([['fast', fastModel, setFastModel], ['slow', slowModel, setSlowModel], ['eval', evalModel, setEvalModel]] as const).map(([role, value, set]) => (
          <div key={role} className="flex min-w-0 flex-col gap-1"><span className={label}>{t(`run.role_${role}`, { defaultValue: role })}</span>
            <SkillWhetModelSelect
              value={value}
              onChange={(next) => set(next.trim())}
              models={catalogModels}
              aliasModels={aliasModels}
              allowed={allowedModels}
              ariaLabel={`${role}_model`}
            />
            {/* 别名:写出它映射到的真实模型(评估 ≠ 提议按这个比) */}
            {realModels[value] && realModels[value] !== value && (
              <span className="truncate font-mono text-[10px] text-muted-foreground" title={realModels[value]}>{value} → {realModels[value]}</span>
            )}
          </div>
        ))}
      </div>

      <button type="button" onClick={() => setAdvanced((v) => !v)} className="self-start text-[11px] text-muted-foreground hover:text-foreground">
        {advanced ? '▾' : '▸'} {t('run.advanced', { defaultValue: '高级(每缺陷采样 {{k}} · 编辑预算 {{p2}} · 修补 {{r}} 次 · 并发 {{w}} · 判官 {{j}} 次 · 连续 {{n}} 轮无接受即停)', k, p2: budgetP2, r: refine, w: workers, j: judgeSamples, n: noAccept })}
      </button>
      {advanced && (
        <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-2">
          {([['k', k, setK, 1, 8], ['budget_p2', budgetP2, setBudgetP2, 1, 20], ['refine', refine, setRefine, 0, 3], ['workers', workers, setWorkers, 1, budget?.maxWorkers ?? 2], ['judge_samples', judgeSamples, setJudgeSamples, 1, 5], ['no_accept_rounds', noAccept, setNoAccept, 0, 20]] as const).map(([name, value, set, min, max]) => (
            <label key={name} className="flex flex-col gap-1"><span className={`${label} font-mono`}>{name}</span>
              <NumberInput integer min={min} max={max} value={value} onChange={(v) => set(v ?? min)} className={field} aria-label={name} /></label>
          ))}
        </div>
      )}

      {blockers.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {blockers.map((b) => <li key={b}>· {b}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-border bg-muted px-3 py-2 text-xs text-body" data-testid="run-warnings">
          {warnings.map((w) => <li key={w} className="flex gap-1.5"><Info className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" aria-hidden />{w}</li>)}
        </ul>
      )}
      {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}

      <div className="rounded-md bg-muted px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
        {t('run.notice', { defaultValue: '训练会在服务器上真的执行包里的代码与 tests/(沙箱:rlimit,机器支持 unshare 时再加网络隔离);产物只进 staging,不会碰技能库。' })}
      </div>
      <button type="button" onClick={() => void submit()} disabled={busy || blockers.length > 0} className="prism-action inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-[13px] disabled:opacity-50">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
        {t('run.submit', { defaultValue: '开始训练' })}
        {mock && <Badge tone="warn">mock</Badge>}
      </button>
    </section>
  );
}
