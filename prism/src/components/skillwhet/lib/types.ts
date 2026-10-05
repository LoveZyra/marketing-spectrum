/**
 * gy:`/api/skillwhet/*` 回来的形状(与 SkillWhet `managed.status()` / `PyramidResult.to_dict()` /
 * `TaskStore.summary()` 与 Prism `messageFeedbackDb.statsBySkill()` 逐字段对齐)。
 */
export type GateVerdict = 'pass' | 'fail' | 'skip';

export type GateFinding = { gate?: string; severity?: string; message?: string; file?: string; line?: number; [key: string]: unknown };

export type GateResult = {
  gate: string;
  verdict: GateVerdict;
  findings: GateFinding[];
  elapsed_ms?: number;
  detail?: Record<string, unknown>;
};

export type PyramidResult = {
  passed: boolean;
  stopped_at?: string;
  total_ms?: number;
  results: GateResult[];
  ran_at?: string;
  /** hl(动态 P2-19):没装、因此没查的工具(serve 0.5.2 起);有就不算通过 */
  missing_tools?: string[];
  warnings?: string[];
};

export type ManagedSkill = {
  name: string;
  source: 'live' | 'upload';
  imported_from?: string | null;
  imported_at?: string | null;
  uploaded_by?: string | null;
  file_count?: number;
  python_files?: number;
  has_unit_tests?: boolean;
  has_holdout_tests?: boolean;
  has_contract?: boolean;
  bootstrapped?: boolean;
  latest_staging?: string | null;
  staging_count?: number;
  adopted?: boolean;
  /** hd:副本当前内容来自哪份 staging(serve status.adopted_staging) */
  adopted_staging?: string | null;
  wiki_patterns?: number;
  provenance_records?: number;
  last_gate?: PyramidResult | null;
  live_exists?: boolean;
};

export type SkillsResponse = {
  skills: ManagedSkill[];
  liveOnly: string[];
  feedbackOnly: string[];
  liveRoot?: string;
};

export type FeedbackStats = {
  skill: string;
  shown: number;
  answered: number;
  votes: number;
  good: number;
  neutral: number;
  bad: number;
  projects: number;
  users: number;
  recentNotes: Array<{ note: string; verdict: number | null; user_id: number | null; project_id: number | null; updated_at: string }>;
  /** ha:按项目分组(看不见的项目 project_id / project_name 为 null) */
  byProject?: Array<{ project_id: string | null; project_name: string | null; answered: number; good: number; neutral: number; bad: number }>;
  /** ha:某项目连续差而全局好 —— 可考虑为它派生副本 */
  divergentProjects?: string[];
};

export type ContractResponse = {
  exists: boolean;
  contract: {
    version?: number;
    allowed_imports?: string[];
    entrypoints?: Array<{ id: string; module: string; signature?: string; stability?: string; side_effects?: string[]; [key: string]: unknown }>;
  };
};

/** he:经验的状态 —— 见 SkillWhet `wiki.py` 的说明。0.4.x 的 serve 不回 `index`。 */
export type WikiStatus = 'hypothesis' | 'supported' | 'disputed' | 'retired';
export type WikiPattern = {
  id: string; title: string; kind: string; observations: number; status: WikiStatus;
  scope: string[]; counterexamples: string[]; revision: number; workaround?: string;
};
export type WikiResponse = {
  patterns: Array<{ id: string; text: string }>;
  logs: string;
  impact?: unknown;
  index?: WikiPattern[];
};

/** he:夜训计划(`GET /api/skillwhet/nightly`)。 */
export type NightlyResult =
  | 'running' | 'improved' | 'unchanged' | 'no_candidate' | 'budget'
  | 'skipped_no_new_tasks' | 'skipped_busy' | 'deferred_budget'
  | 'interrupted' | 'cancelled' | 'error';
export type NightlyPlan = {
  skill_name: string;
  enrolled: boolean;
  window_start: string;
  window_end: string;
  max_cost_usd: number | null;
  rounds: number;
  config: Record<string, unknown>;
  min_new_tasks: number;
  last_night: string | null;
  last_run_at: string | null;
  last_job_id: string | null;
  last_result: NightlyResult | null;
  last_detail: string | null;
  consecutive_noop: number;
  auto_paused_at: string | null;
};
export type NightlyResponse = {
  plans: NightlyPlan[];
  nightlyMaxCostUsd: number;
  maxCostUsd: number;
  hardMaxCostUsd?: number;
  /** hi:夜训单次硬上限(100)与夜训轮数上限(20);老服务端不回 → 用 hardMaxCostUsd / 10 */
  nightlyHardMaxCostUsd?: number;
  nightlyMaxRounds?: number;
  autopauseAfter: number;
  serverTime: { iso: string; local: string; offsetMin: number; tz: string };
  defaults: { window_start: string; window_end: string; rounds: number; min_new_tasks: number };
};

export type CheckpointInfo = { exists: boolean; round?: number; saved_at?: string; job_rounds?: number; matches?: boolean };

export type TaskSummary = {
  skill: string;
  total: number;
  splits: { train: number; val: number; test: number };
  sources: Record<string, number>;
  batches: number;
  updated_at?: string | null;
};

export type TaskRowResult = {
  row: number;
  task_id: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  reference_kind: string;
  family: string;
};

export type TaskValidateResponse = {
  report: { format: string; passed: number; failed: number; rows: TaskRowResult[] };
  added?: number;
  total?: number;
};

/** 统一拆 `{ success, data }` 信封;非 2xx 抛 Error(带服务端 message)。 */
export async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as { data?: T; error?: string; message?: string; code?: string } | null;
  if (!response.ok) {
    throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  }
  return (body?.data ?? body) as T;
}

// ── gz ─────────────────────────────────────────────────────────────────
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export type JobKind = 'train' | 'harvest' | 'release_eval';

export type Job = {
  id: string;
  kind: JobKind;
  skill: string;
  args: Record<string, unknown>;
  tags: string[];
  state: JobState;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  pid?: number | null;
  rc?: number | null;
  stop_reason?: string | null;
  improved?: boolean | null;
  cost_usd?: number | null;
  staging?: string | null;
  error?: string | null;
  origin?: string;
  position?: number | null;
  last_seq?: number;
  rounds?: ProgressEvent[];
  val_baseline?: number | null;
  val_candidate?: number | null;
  rounds_done?: number;
};

export type ProgressEvent = {
  seq: number;
  ts: string;
  kind: 'job_start' | 'tasks_split' | 'baseline' | 'round_start' | 'attribution' | 'fast_loop' | 'slow_loop'
  | 'governance' | 'gate' | 'round_end' | 'done' | 'error' | string;
  round?: number;
  [key: string]: unknown;
};

export type Budget = {
  maxCostUsd: number;
  maxHours: number;
  /** hf2:root 可越过 .env 上限到这里(serve 老版本 / 老 Prism 不回 → 视同 .env 上限) */
  hardMaxCostUsd?: number;
  hardMaxHours?: number;
  maxWorkers: number;
  userDailyMaxCostUsd: number;
  spentToday: number;
  isRoot: boolean;
  /** hn(B7):非 root 能选的模型(别名 + 目录上架条目,或 .env 白名单);root 为 null = 不限。老 Prism 不回。 */
  allowedModels?: string[] | null;
};

export type StagingSummary = {
  id: string;
  created_at: string | null;
  accepted: boolean;
  adopted: boolean;
  files: number;
  baseline_score: number | null;
  candidate_score: number | null;
  improved: boolean | null;
  stop_reason: string | null;
  total_cost_usd: number | null;
  rounds: number;
  test_score_baseline: number | null;
  test_score_best: number | null;
  /** ha release-once:这份 staging 唯一一次留出集评估的结果;null = 还没评 */
  release?: ReleaseResult | null;
  contract?: { base_bundle_hash?: string; candidate_bundle_hash?: string; protocol_hash?: string };
  /** hd:这份 staging 被发布到技能库的时刻(可能多次) */
  published?: string[];
};

/** hd:发布 / 回滚记录(serve 记在自己的 home 里) */
export type PublishEvent = { at: string; event: 'publish' | 'rollback'; by: string | null; staging: string | null; to: string | null; mode: string | null };

export type ReleaseResult = {
  at: string;
  test_tasks: number;
  baseline: number | null;
  candidate: number | null;
  baseline_passed?: number;
  candidate_passed?: number;
  delta: number;
  runner?: string;
  cost_usd?: number;
};

export type HarvestProject = { path: string; name: string; sessions: number; latest: string };

export type HarvestSession = {
  session_id: string; project: string; started_at: string; ended_at: string; turns: number;
  tools: string[]; skills: string[]; first_prompt: string; votes: number; guessed_feedback: number;
};

export type HarvestTask = {
  id: string; intent: string; context_excerpt: string; outcome: string; reference_kind: string; reference: string;
  split: string; family_id: string; source_sessions: string[]; tags: string[];
};

export type HarvestResult = {
  kind: 'harvest';
  skill: string;
  result: { sessions: HarvestSession[]; tasks: HarvestTask[]; stats: Record<string, number>; dry_run: boolean; skipped_other_skill?: number };
  imported: { added: number; total: number; task_ids: string[] } | null;
};

export type StagingDiff = { rel: string; binary: boolean; changed?: boolean; added?: number; removed?: number; diff?: string; new?: boolean };

export type StagingDetail = StagingSummary & {
  manifest: Record<string, unknown>;
  /** hd:diff 的底 —— base = 训练开始时的副本;backup = 采纳前的副本(老 staging);copy = 副本当前内容 */
  diff_base?: 'base' | 'backup' | 'copy';
  report: {
    rounds?: Array<Record<string, unknown>>;
    edits?: Array<Record<string, unknown>>;
    model_snapshot?: Record<string, unknown>;
    config?: Record<string, unknown>;
    violations?: unknown[];
    bloat_ratio?: number;
    llm_calls?: number;
    elapsed_s?: number;
    [key: string]: unknown;
  };
  report_md: string;
  diffs: StagingDiff[];
  adopted_info: Record<string, unknown> | null;
};

export type InboxRow = {
  id: number;
  sessionId: string;
  projectId: string | null;
  messageId: string;
  userId: number;
  source: 'vote' | 'survey';
  verdict: number | null;
  category: string | null;
  note: string | null;
  expectedOutput: string | null;
  skill: string;
  updatedAt: string;
  intent: string;
  referenceKind: 'exact' | 'rubric';
};

export type RollbackEntry = { ts: string; dir: string; files: number };
