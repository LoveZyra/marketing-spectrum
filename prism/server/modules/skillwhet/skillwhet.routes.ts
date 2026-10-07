import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express, { type Request, type RequestHandler, type Router } from 'express';

import {
  auditLogDb, messageFeedbackDb, NIGHTLY_AUTOPAUSE_AFTER, projectsDb, sessionMessagesDb, sessionsDb, skillWhetNightlyDb,
  type NightlyPlanRow, type SkillFeedbackStats,
} from '@/modules/database/index.js';
import { nativeUuidFromMessageId } from '@/shared/fork-anchor.js';
import { isRootUser } from '@/shared/root-users.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { readBudget } from './services/budget.js';
import { SKILLWHET_MODEL_KEYS, allowedSkillWhetModels, isSkillWhetModelAllowed, proposerEvaluatorConflict } from './services/model-policy.js';
import { g1Problem, type GateCache } from './services/g1.js';
import { copyIdOf, isHhMm, parsePlanConfig } from './services/nightly-scheduler.service.js';
import { redactSecrets } from './services/redact.js';
import { listRollbacks, publishManagedCopy, rollbackPublished } from './services/skill-publish.service.js';
import { SkillWhetClient } from './services/skillwhet-client.js';

/**
 * `/api/skillwhet/*`:技能优化(SkillWhet)的平台侧接口 —— 体检、技能资产、任务集、训练作业、夜训、
 * staging / 采纳 / 发布 / 回滚、反馈收件箱、从会话挖任务。
 *
 * 权限线:
 *   · 列表与状态(status / skills / tasks 列表 / validate / jobs):登录即可;
 *     副本内部(体检结果 / 事实 / 契约 / wiki / 出处 / 台账 / drift / staging 详情):技能库来源登录即可,上传来源只给上传者本人或 root;
 *   · 动副本(移除 / bootstrap / 任务入库 / 起训练 / 采纳):技能库来源只有 root,上传来源是上传者本人或 root;
 *   · 上传自己的 skill:登录即可;从技能库导入副本、发布 / 回滚、夜训计划、反馈收件箱、从会话挖任务:root。
 * serve 那边不认识用户,所以这里就是全部的权限判断;转发时不透传任何用户凭证。
 *
 * 整层只有在 `PRISM_SKILLWHET_ENABLE=1` 时才会被 index.js 挂上;没挂就是 404,前端据此藏轨位。
 */
export type SkillWhetRouterDeps = {
  authenticateToken: RequestHandler;
  client: SkillWhetClient;
  config: { home: string; label: string; generatedToken: boolean; autostart: boolean };
  /** `~/.claude/skills` —— 技能库的全局作用域目录。测试里可替换。 */
  liveSkillsRoot?: string;
  env?: NodeJS.ProcessEnv;
};

type RequestUser = { id: number; username: string; isRoot?: boolean };

const readUser = (req: Request): RequestUser | null => ((req as Request & { user?: RequestUser }).user) ?? null;

const isRoot = (user: RequestUser | null): boolean =>
  Boolean(user && (user.isRoot === true || isRootUser(user.username)));

const requireRoot = (req: Request, what: string): RequestUser => {
  const user = readUser(req);
  if (!user) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED', statusCode: 401 });
  if (!isRoot(user)) {
    throw new AppError(`${what}只有 root 能做`, { code: 'SKILLWHET_ROOT_ONLY', statusCode: 403 });
  }
  return user;
};

const requireUser = (req: Request): RequestUser => {
  const user = readUser(req);
  if (!user) throw new AppError('Not authenticated', { code: 'UNAUTHENTICATED', statusCode: 401 });
  return user;
};

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const parseSkillName = (value: unknown): string => {
  const name = String(value ?? '').trim();
  if (!SKILL_NAME.test(name) || name === '.' || name === '..') {
    throw new AppError('技能名不合法', { code: 'SKILLWHET_BAD_NAME', statusCode: 400 });
  }
  return name;
};

type JobRow = {
  id: string; kind: string; skill: string; args: Record<string, unknown>; tags: string[]; state: string;
  created_at: string; started_at?: string | null; finished_at?: string | null; cost_usd?: number | null;
  stop_reason?: string | null; improved?: boolean | null; staging?: string | null; error?: string | null;
  position?: number | null; origin?: string;
};

const jobOwnerId = (job: JobRow): number | null => {
  const tag = (job.tags ?? []).find((t) => t.startsWith('user:'));
  const id = tag ? Number.parseInt(tag.slice(5), 10) : NaN;
  return Number.isFinite(id) ? id : null;
};

type ManagedStatus = {
  name: string;
  source: 'live' | 'upload';
  uploaded_by?: string;
  [key: string]: unknown;
};

const audit = (req: Request, event: Parameters<typeof auditLogDb.record>[0]['event'], detail: string, outcome: 'success' | 'failure' = 'success') => {
  const user = readUser(req);
  auditLogDb.record({ userId: user?.id ?? null, username: user?.username ?? null, event, detail, outcome });
};

/**
 * 反馈统计按看的人裁剪 —— 看不见的项目:名字 / id 不给,合成一行「其他项目」;
 * 最近待优化点只留看得见的项目里的(root 全给);"偏差项目"只列有名字的。
 */
type ProjectRow = { project_id: string | null; project_name: string | null; answered: number; good: number; neutral: number; bad: number };

function scopedFeedbackStats(stats: SkillFeedbackStats, visible: Map<string, string>, root: boolean) {
  const seen = (id: string | null) => root || (id !== null && visible.has(id));
  const named: ProjectRow[] = stats.byProject.filter((row) => seen(row.project_id)).map((row) => ({
    ...row, project_name: row.project_id ? visible.get(row.project_id) ?? null : null,
  }));
  const hidden = stats.byProject.filter((row) => !seen(row.project_id));
  const byProject = hidden.length === 0 ? named : [...named, hidden.reduce<ProjectRow>((acc, row) => ({
    ...acc, answered: acc.answered + row.answered, good: acc.good + row.good, neutral: acc.neutral + row.neutral, bad: acc.bad + row.bad,
  }), { project_id: null as string | null, project_name: null as string | null, answered: 0, good: 0, neutral: 0, bad: 0 })];
  const share = (bad: number, n: number) => (n > 0 ? bad / n : 0);
  const globalGood = share(stats.good, stats.good + stats.neutral + stats.bad);
  const divergentProjects = named
    .filter((row) => row.project_name && row.answered >= 3 && share(row.bad, row.answered) >= 0.5 && globalGood >= 0.5)
    .map((row) => row.project_name as string);
  const recentNotes = stats.recentNotes
    .filter((row) => seen(row.project_id))
    .map((row) => (root ? row : { ...row, user_id: null as unknown as number, project_id: null }));
  return { ...stats, recentNotes, byProject, divergentProjects };
}

/**
 * 上传来源的 skill 是私人的 —— 非上传者本人(且非 root)只看得到每道门通过 / 未通过的结论;
 * 体检结果里的 findings / detail(G4 崩溃时带着 ≤300 字的测试输出)不给。技能库来源全给。
 */
const mayReadInternals = (user: RequestUser | null, status: { source?: unknown; uploaded_by?: unknown }): boolean =>
  Boolean(user) && (isRoot(user) || status.source !== 'upload' || status.uploaded_by === user?.username);

type GateLike = { passed?: unknown; stopped_at?: unknown; ran_at?: unknown; cached?: unknown; missing_tools?: unknown; results?: Array<{ gate?: unknown; verdict?: unknown }> };
const gateVerdictsOnly = (gate: GateLike | null | undefined) => (gate && typeof gate === 'object' ? {
  ...(gate.cached !== undefined ? { cached: gate.cached } : {}),
  passed: gate.passed, stopped_at: gate.stopped_at, ran_at: gate.ran_at, missing_tools: gate.missing_tools,
  results: (gate.results ?? []).map((r) => ({ gate: r.gate, verdict: r.verdict, findings: [] })),
} : gate);

const scopeSkillFor = <T extends { source?: unknown; uploaded_by?: unknown; last_gate?: GateLike | null }>(user: RequestUser | null, skill: T): T =>
  (mayReadInternals(user, skill) ? skill : { ...skill, last_gate: gateVerdictsOnly(skill.last_gate) as T['last_gate'] });

const isWritable = (dir: string): boolean => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export function createSkillWhetRouter(deps: SkillWhetRouterDeps): Router {
  const router = express.Router();
  const { client, config } = deps;
  const liveRoot = deps.liveSkillsRoot ?? path.join(os.homedir(), '.claude', 'skills');
  const env = deps.env ?? process.env;

  router.use(deps.authenticateToken);
  // 30 MiB 上限的上传 base64 后约 40 MiB,再加 JSON 外壳 —— 与 serve 侧 MAX_BODY(48 MiB)同口径。
  // 只给上传那一条路;其余路由用 1mb 的小 body 上限。
  router.use('/skills/upload', express.json({ limit: '48mb' }));
  router.use(express.json({ limit: '1mb' }));

  /** 谁能动这个受管副本:技能库来源 → root;上传来源 → 上传者本人或 root。 */
  const assertMayMutate = async (req: Request, name: string, what: string): Promise<{ user: RequestUser; status: ManagedStatus }> => {
    const user = requireUser(req);
    const status = await client.request<ManagedStatus>('GET', `/skills/${encodeURIComponent(name)}/status`);
    if (isRoot(user)) return { user, status };
    if (status.source === 'upload' && status.uploaded_by === user.username) return { user, status };
    throw new AppError(
      status.source === 'upload' ? `${what}只有上传者本人或 root 能做` : `技能库来源的 skill,${what}只有 root 能做`,
      { code: 'SKILLWHET_FORBIDDEN', statusCode: 403 },
    );
  };

  // ── 体检 ──────────────────────────────────────────────────────────
  router.get('/status', asyncHandler(async (req, res) => {
    const health = await client.health();
    const tools = (health?.tools ?? {}) as Record<string, boolean>;
    // 路径类信息(监听地址 / 工作根)只给 root:普通用户看灯就够了,不必知道机器上的目录。
    const user = readUser(req);
    const root = user ? isRoot(user) : false;
    res.json(createApiSuccessResponse({
      enabled: true,
      autostart: config.autostart,
      target: root ? config.label : undefined,
      home: root ? config.home : undefined,
      checks: {
        serveReachable: health !== null,
        tokenSet: !config.generatedToken || config.autostart,
        homeWritable: isWritable(config.home),
        pythonOk: typeof health?.python === 'string',
        claudeCli: tools.claude_cli === true,
        ruff: tools.ruff === true,
        bandit: tools.bandit === true,
        pyright: tools.pyright === true,
        unshare: tools.unshare === true,
      },
      serve: health,
      survey: {
        rate: Number.parseFloat(String(env.PRISM_SKILL_SURVEY_RATE ?? '0.5')),
        cooldownMin: Number.parseInt(String(env.PRISM_SKILL_SURVEY_COOLDOWN_MIN ?? '60'), 10),
      },
    }));
  }));

  // ── 技能资产 ───────────────────────────────────────────────────────
  router.get('/skills', asyncHandler(async (req, res) => {
    const data = await client.request<{ skills: ManagedStatus[] }>('GET', '/skills');
    // 技能库里有、但还没导入副本的,也列出来(卡片上显示"未导入"),让 root 一眼看到能导什么。
    let live: string[] = [];
    try {
      live = fs.readdirSync(liveRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .filter((name) => fs.existsSync(path.join(liveRoot, name, 'SKILL.md')));
    } catch {
      live = [];
    }
    const managed = new Set(data.skills.map((skill) => skill.name));
    const feedbackSkills = messageFeedbackDb.skillsWithFeedback();
    res.json(createApiSuccessResponse({
      skills: data.skills.map((skill) => ({ ...scopeSkillFor(readUser(req), skill as ManagedStatus & { last_gate?: GateLike | null }), live_exists: live.includes(skill.name) })),
      liveOnly: live.filter((name) => !managed.has(name)),
      feedbackOnly: feedbackSkills.filter((name) => !managed.has(name) && !live.includes(name)),
      liveRoot: (() => { const user = readUser(req); return user && isRoot(user) ? liveRoot : undefined; })(),
    }));
  }));

  router.post('/skills/upload', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const body = (req.body ?? {}) as { name?: unknown; files?: unknown };
    const name = parseSkillName(body.name);
    if (!Array.isArray(body.files)) {
      throw new AppError('files 必须是数组', { code: 'SKILLWHET_BAD_UPLOAD', statusCode: 400 });
    }
    try {
      const data = await client.request('POST', '/skills/upload', { name, files: body.files, uploaded_by: user.username }, 120_000);
      audit(req, 'skillwhet_upload', `${name} files=${body.files.length}`);
      res.json(createApiSuccessResponse(data));
    } catch (error) {
      audit(req, 'skillwhet_upload', `${name} ${error instanceof Error ? error.message : String(error)}`, 'failure');
      throw error;
    }
  }));

  router.get('/skills/:name', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const name = parseSkillName(req.params.name);
    const data = await client.request<ManagedStatus>('GET', `/skills/${encodeURIComponent(name)}/status`);
    const visible = new Map(projectsDb.getProjectPaths(isRoot(user) ? null : user.id)
      .map((row) => [row.project_id, row.custom_project_name || path.basename(row.project_path)]));
    res.json(createApiSuccessResponse({ ...scopeSkillFor(user, data as ManagedStatus & { last_gate?: GateLike | null }), feedback: scopedFeedbackStats(messageFeedbackDb.statsBySkill(name), visible, isRoot(user)) }));
  }));

  /**
   * 谁能读这份副本的内部(体检结果 / 事实 / 契约 / 经验 Wiki / 出处 / 台账 / drift)。
   * 技能库来源 → 登录即可(与列表口径一致,技能库本来全员可用);上传来源 → 上传者本人或 root
   * (上传的 skill 是私人的,而且副本里的测试能往 wiki 写任意内容)。
   */
  const assertMayRead = async (req: Request, name: string): Promise<{ user: RequestUser; status: ManagedStatus }> => {
    const user = requireUser(req);
    const status = await client.request<ManagedStatus>('GET', `/skills/${encodeURIComponent(name)}/status`);
    if (isRoot(user) || status.source !== 'upload' || status.uploaded_by === user.username) return { user, status };
    throw new AppError('上传来源的 skill,副本内部只有上传者本人或 root 能看', { code: 'SKILLWHET_FORBIDDEN', statusCode: 403 });
  };

  for (const sub of ['gate', 'facts', 'contract', 'wiki', 'provenance', 'ledger', 'drift'] as const) {
    router.get(`/skills/:name/${sub}`, asyncHandler(async (req, res) => {
      const name = parseSkillName(req.params.name);
      await assertMayRead(req, name);
      const data = await client.request('GET', `/skills/${encodeURIComponent(name)}/${sub}`, undefined, sub === 'gate' ? 120_000 : undefined);
      res.json(createApiSuccessResponse(data));
    }));
  }

  router.post('/skills/:name/gate', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    // 体检会真的跑副本里的 tests/(G4 / G5):谁能动这份副本谁才能点
    await assertMayMutate(req, name, '重跑体检');
    const data = await client.request('POST', `/skills/${encodeURIComponent(name)}/gate`, {}, 120_000);
    res.json(createApiSuccessResponse(data));
  }));

  router.get('/skills/:name/feedback-stats', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const name = parseSkillName(req.params.name);
    const stats = messageFeedbackDb.statsBySkill(name);
    // 按项目分组。项目名只给看得见那个项目的人,别人看到的是"其他项目"
    const visible = new Map(projectsDb.getProjectPaths(isRoot(user) ? null : user.id)
      .map((row) => [row.project_id, row.custom_project_name || path.basename(row.project_path)]));
    res.json(createApiSuccessResponse(scopedFeedbackStats(stats, visible, isRoot(user))));
  }));

  router.post('/skills/:name/import', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    requireRoot(req, '从技能库导入副本');
    const liveDir = path.join(liveRoot, name);
    if (!fs.existsSync(path.join(liveDir, 'SKILL.md'))) {
      throw new AppError(`技能库里没有「${name}」(${liveRoot})`, { code: 'SKILLWHET_LIVE_MISSING', statusCode: 404 });
    }
    const replace = Boolean((req.body as { replace?: unknown } | undefined)?.replace);
    try {
      const data = await client.request('POST', `/skills/${encodeURIComponent(name)}/import`, { live_dir: liveDir, replace }, 60_000);
      audit(req, 'skillwhet_import', `${name} from ${liveDir}${replace ? ' (replace)' : ''}`);
      res.json(createApiSuccessResponse(data));
    } catch (error) {
      audit(req, 'skillwhet_import', `${name} ${error instanceof Error ? error.message : String(error)}`, 'failure');
      throw error;
    }
  }));

  router.post('/skills/:name/bootstrap', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    await assertMayMutate(req, name, 'bootstrap');
    const allow = (req.body as { allow?: unknown } | undefined)?.allow;
    const data = await client.request('POST', `/skills/${encodeURIComponent(name)}/bootstrap`,
      { allow: Array.isArray(allow) ? allow.map(String) : [] }, 120_000);
    audit(req, 'skillwhet_bootstrap', name);
    res.json(createApiSuccessResponse(data));
  }));

  router.delete('/skills/:name', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    await assertMayMutate(req, name, '移除副本');
    const data = await client.request('DELETE', `/skills/${encodeURIComponent(name)}`);
    audit(req, 'skillwhet_remove', name);
    // 夜训批准的是这份副本;副本没了,计划跟着移出(换一份同名的进来要 root 重新纳入)
    if (skillWhetNightlyDb.unenroll(name, null, '副本已移除,自动移出夜训')) audit(req, 'skillwhet_nightly_unenroll', `${name} 副本已移除`);
    res.json(createApiSuccessResponse(data));
  }));

  // ── 任务集 ────────────────────────────────────────────────────────
  router.post('/tasks/validate', asyncHandler(async (req, res) => {
    requireUser(req);
    const body = (req.body ?? {}) as { skill?: unknown; format?: unknown; content?: unknown };
    const skill = parseSkillName(body.skill);
    const data = await client.request('POST', '/tasks/validate',
      { skill, format: body.format ?? 'json', content: body.content }, 60_000);
    res.json(createApiSuccessResponse(data));
  }));

  router.post('/tasks', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { skill?: unknown; format?: unknown; content?: unknown; records?: unknown; keep_passing?: unknown };
    const skill = parseSkillName(body.skill);
    const { user, status } = await assertMayMutate(req, skill, '任务入库');
    const tags = [`user:${user.id}`, `uploader:${user.username}`, `skill_source:${status.source}`];
    const data = await client.request<{ added: number; total?: number }>('POST', '/tasks', {
      skill,
      format: body.format ?? 'json',
      content: body.content,
      records: body.records,
      keep_passing: Boolean(body.keep_passing),
      tags,
      source: 'upload',
    }, 60_000);
    audit(req, 'skillwhet_tasks_add', `${skill} +${data.added}`);
    res.json(createApiSuccessResponse(data));
  }));

  router.get('/tasks', asyncHandler(async (req, res) => {
    const skill = typeof req.query.skill === 'string' && req.query.skill ? parseSkillName(req.query.skill) : null;
    const full = req.query.full === '1' || req.query.full === 'true';
    if (full) {
      // 任务全文里有用户原话(反馈 / 从会话挖出来的):只给能动这份副本的人
      if (!skill) throw new AppError('full=1 要带 skill', { code: 'SKILLWHET_BAD_QUERY', statusCode: 400 });
      await assertMayMutate(req, skill, '看任务全文');
    }
    const query = skill ? `?skill=${encodeURIComponent(skill)}${full ? '&full=1' : ''}` : '';
    const data = await client.request('GET', `/tasks${query}`);
    res.json(createApiSuccessResponse(data));
  }));

  // ── 训练作业 ────────────────────────────────────────────────────────
  /**
   * 起训练。谁能起:上传来源 → 上传者本人或 root;技能库来源 → root(assertMayMutate)。
   * 非 root 还要过两道硬门:该副本最近一次体检 G1 安全门 PASS(训练会真的执行副本里的代码),
   * 以及每人每天费用上限(已完成作业的实际费用 + 在途作业的预算)。root 越过 G1 时审计带 g1_override。
   * 预算三项(费用 / 时长 / 并发)先钳到上限再转发(费用 / 时长:非 root 用 `.env` 上限,root 用硬上限);
   * 后端选择(mock)只有 root 能传。
   */
  // 同一个人并发提交两个作业时,预算检查是先查后建:按人排成一串
  const jobChains = new Map<number, Promise<unknown>>();
  const serializePerUser = async <T>(userId: number, fn: () => Promise<T>): Promise<T> => {
    const prev = jobChains.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    jobChains.set(userId, next);
    try {
      return await next;
    } finally {
      if (jobChains.get(userId) === next) jobChains.delete(userId);
    }
  };

  /**
   * 起一次训练(新建训练表单与「从中断处续跑」共用):权限、G1、每日额度、参数钳制、审计。
   * `extraDetail` 只进审计。
   */
  const startTrain = async (req: Request, skill: string, rawArgs: unknown, extraDetail = '', extraTags: string[] = []) => {
    const { user, status } = await assertMayMutate(req, skill, '起训练');
    return serializePerUser(user.id, async () => {
    const root = isRoot(user);
    const budget = readBudget(env);
    const args: Record<string, unknown> = { ...(rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {}) };
    for (const key of ['fast_backend', 'slow_backend', 'eval_backend']) {
      if (key in args && !root) delete args[key];
    }
    // 非 root 的四个模型都要在允许列表里,含 target_model(runner=agent 时 rollout 用它);
    // 列表没配置时 = 三个别名 + 模型目录里上架的条目(见 model-policy.ts)。root 不受限,但名字要过字符集。
    for (const key of SKILLWHET_MODEL_KEYS) {
      if (!(key in args) || args[key] === undefined || args[key] === null || args[key] === '') continue;
      const value = String(args[key]);
      if (!isSkillWhetModelAllowed(value, budget, root)) {
        const allowed = allowedSkillWhetModels(budget, root);
        throw new AppError(
          allowed
            ? `${key}=${value} 不在允许的模型里(${allowed.join(' / ')});要用别的模型请找 root`
            : `${key}=${value} 不是合法的模型名`,
          { code: 'SKILLWHET_MODEL_NOT_ALLOWED', statusCode: 400 },
        );
      }
    }
    // 评估 ≠ 提议按真名比(别名换成它映射到的网关模型再比)。mock 后端不调模型,不查。
    const usesMock = ['fast_backend', 'slow_backend', 'eval_backend'].some((key) => args[key] === 'mock');
    if (!usesMock) {
      const conflict = await proposerEvaluatorConflict(args);
      if (conflict) throw new AppError(conflict, { code: 'SKILLWHET_BAD_MODELS', statusCode: 400 });
    }
    const clamped: string[] = [];
    const clampNum = (key: string, cap: number, fallback: number) => {
      const raw = Number(args[key]);
      if (Number.isFinite(raw) && raw > cap) clamped.push(`${key} ${raw}→${cap}`);
      args[key] = Number.isFinite(raw) && raw > 0 ? Math.min(raw, cap) : fallback;
    };
    // root 可以越过 .env 的单次上限(到硬上限为止,审计记 cost_override);非 root 钳到 .env
    clampNum('max_cost_usd', root ? budget.hardMaxCostUsd : budget.maxCostUsd, budget.maxCostUsd);
    clampNum('max_minutes', (root ? budget.hardMaxHours : budget.maxHours) * 60, budget.maxHours * 60);
    clampNum('workers', budget.maxWorkers, Math.min(2, budget.maxWorkers));
    const costOverride = root && (Number(args.max_cost_usd) > budget.maxCostUsd || Number(args.max_minutes) > budget.maxHours * 60);
    args.workers = Math.round(Number(args.workers));

    let g1Override = false;
    if (!root) {
      const gate = await client.request<GateCache>('GET', `/skills/${encodeURIComponent(skill)}/gate`);
      const problem = g1Problem(gate, '起训练');
      if (problem) throw new AppError(problem, { code: 'SKILLWHET_G1_REQUIRED', statusCode: 403 });
      const spent = await spentToday(user.id);
      const reserve = Number(args.max_cost_usd) || 0;
      if (spent + reserve > budget.userDailyMaxCostUsd) {
        throw new AppError(
          `今天的训练额度不够:已用 / 在途 $${spent.toFixed(2)},这次预算 $${reserve.toFixed(2)},上限 $${budget.userDailyMaxCostUsd.toFixed(2)};明天恢复,或调低这次的费用上限`,
          { code: 'SKILLWHET_DAILY_BUDGET', statusCode: 429, details: { spent, reserve, limit: budget.userDailyMaxCostUsd } });
      }
    } else {
      const gate = await client.request<{ cached?: boolean; results?: Array<{ gate: string; verdict: string }> }>(
        'GET', `/skills/${encodeURIComponent(skill)}/gate`).catch(() => ({ cached: false, results: [] }));
      const g1 = (gate.results ?? []).find((r) => r.gate === 'G1.security');
      g1Override = !gate.cached || !g1 || g1.verdict !== 'pass';
    }
    const tags = [`user:${user.id}`, `uploader:${user.username}`, `skill_source:${status.source}`, ...extraTags];
    try {
      const data = await client.request<{ job: JobRow; position: number }>('POST', '/jobs',
        { kind: 'train', skill, args, tags, origin: 'manual' }, 30_000);   // 这条路只起训练;挖任务 / 留出集各有各的门
      audit(req, 'skillwhet_job_start', `${skill} ${data.job.id}${extraDetail} args=${JSON.stringify(args).slice(0, 300)}${g1Override ? ' g1_override' : ''}${costOverride ? ` cost_override(env $${budget.maxCostUsd} / ${budget.maxHours}h)` : ''}`);
      // 被钳过的参数如实告诉页面,不悄悄按上限跑
      return { ...data, clamped };
    } catch (error) {
      audit(req, 'skillwhet_job_start', `${skill}${extraDetail} ${error instanceof Error ? error.message : String(error)}`, 'failure');
      throw error;
    }
    });
  };

  router.post('/jobs', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { skill?: unknown; kind?: unknown; args?: Record<string, unknown> };
    const skill = parseSkillName(body.skill);
    res.json(createApiSuccessResponse(await startTrain(req, skill, body.args)));
  }));

  /** 当天(UTC)这个人的已用 + 在途费用。 */
  const spentToday = async (userId: number): Promise<number> => {
    const today = new Date().toISOString().slice(0, 10);
    // serve 的列表最多回 1000 条,并按 since 过滤(倒序走到更早的就停),一天之内 1000 条以内都算得全
    const data = await client.request<{ jobs: JobRow[] }>('GET', `/jobs?limit=1000&since=${encodeURIComponent(`${today}T00:00:00Z`)}`);
    let total = 0;
    for (const job of data.jobs) {
      if (jobOwnerId(job) !== userId || !String(job.created_at ?? '').startsWith(today)) continue;
      // 留出集作业没有费用上限参数:非 pytest runner 的按单次上限预留
      const reserve = Number(job.args?.max_cost_usd)
        || (job.kind === 'release_eval' && String(job.args?.runner ?? 'pytest') !== 'pytest' ? readBudget(env).maxCostUsd : 0);
      if (job.state === 'queued' || job.state === 'running') total += reserve;
      // 排队中就取消的(从未 started)一分钱没花,不占额度
      else if (job.state === 'cancelled' && !job.started_at) total += 0;
      // 取消 / 失败 / 中断而没算出费用的,按预算上限保守计
      else total += typeof job.cost_usd === 'number' ? job.cost_usd : reserve;
    }
    return total;
  };

  router.get('/jobs/budget', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const budget = readBudget(env);
    const spent = isRoot(user) ? 0 : await spentToday(user.id);
    // 非 root 能选的模型(root 为 null = 不限),训练 / 夜训表单的下拉按它过滤。
    res.json(createApiSuccessResponse({ ...budget, spentToday: spent, isRoot: isRoot(user), allowedModels: allowedSkillWhetModels(budget, isRoot(user)) }));
  }));

  router.get('/jobs', asyncHandler(async (req, res) => {
    requireUser(req);
    const skill = typeof req.query.skill === 'string' && req.query.skill ? parseSkillName(req.query.skill) : null;
    // 总览的 14 天趋势要多拉一些(serve 默认只回 100 个)
    const limit = Math.min(1000, Math.max(1, Number.parseInt(String(req.query.limit ?? ''), 10) || 100));
    const query = [skill ? `skill=${encodeURIComponent(skill)}` : '', `limit=${limit}`].filter(Boolean).join('&');
    const data = await client.request('GET', `/jobs?${query}`);
    res.json(createApiSuccessResponse(data));
  }));

  const parseJobId = (value: unknown): string => {
    const id = String(value ?? '');
    if (!/^job_[0-9]{8}-[0-9]{6}_[0-9a-f]{4}$/.test(id)) throw new AppError('作业 id 不合法', { code: 'SKILLWHET_BAD_JOB', statusCode: 400 });
    return id;
  };

  router.get('/jobs/:id', asyncHandler(async (req, res) => {
    requireUser(req);
    res.json(createApiSuccessResponse(await client.request('GET', `/jobs/${parseJobId(req.params.id)}`)));
  }));
  router.get('/jobs/:id/progress', asyncHandler(async (req, res) => {
    requireUser(req);
    const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0);
    res.json(createApiSuccessResponse(await client.request('GET', `/jobs/${parseJobId(req.params.id)}/progress?after=${after}`)));
  }));
  router.get('/jobs/:id/log', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    if (!isRoot(user)) {
      // 挖任务作业的输出里有服务器路径与会话摘要:只给 root
      const { job } = await client.request<{ job: JobRow }>('GET', `/jobs/${parseJobId(req.params.id)}`);
      if ((job.kind ?? 'train') === 'harvest') throw new AppError('挖任务作业的日志只有 root 能看', { code: 'SKILLWHET_ROOT_ONLY', statusCode: 403 });
      // 训练日志里有副本的测试输出 —— 上传来源的只给上传者本人
      await assertMayRead(req, job.skill);
    }
    const tail = Math.min(2000, Math.max(1, Number.parseInt(String(req.query.tail ?? '200'), 10) || 200));
    res.json(createApiSuccessResponse(await client.request('GET', `/jobs/${parseJobId(req.params.id)}/log?tail=${tail}`)));
  }));
  router.post('/jobs/:id/cancel', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const id = parseJobId(req.params.id);
    const { job } = await client.request<{ job: JobRow }>('GET', `/jobs/${id}`);
    if (!isRoot(user) && jobOwnerId(job) !== user.id) {
      throw new AppError('只有发起人或 root 能取消', { code: 'SKILLWHET_FORBIDDEN', statusCode: 403 });
    }
    const data = await client.request('POST', `/jobs/${id}/cancel`, {});
    audit(req, 'skillwhet_job_cancel', `${job.skill} ${id}`);
    res.json(createApiSuccessResponse(data));
  }));

  // ── 从中断处续跑 ──────────────────────────────────────────────────
  // 训练中重启了 Prism / serve,作业会被标成 interrupted;SkillWhet 每轮结束存一个 checkpoint,
  // 这里用原作业的参数加 resume 再起一次(权限、G1、额度与新建训练同一套)。夜训作业(没有发起人)只 root 能续。
  router.get('/skills/:name/checkpoint', asyncHandler(async (req, res) => {
    requireUser(req);
    const name = parseSkillName(req.params.name);
    res.json(createApiSuccessResponse(await client.request('GET', `/skills/${encodeURIComponent(name)}/checkpoint`)));
  }));
  router.post('/jobs/:id/resume', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const id = parseJobId(req.params.id);
    const { job } = await client.request<{ job: JobRow }>('GET', `/jobs/${id}`);
    if ((job.kind ?? 'train') !== 'train' || !['interrupted', 'failed', 'cancelled'].includes(job.state)) {
      throw new AppError('只有中断 / 失败 / 取消的训练作业能续跑', { code: 'SKILLWHET_NOT_RESUMABLE', statusCode: 409 });
    }
    if (!isRoot(user) && jobOwnerId(job) !== user.id) {
      throw new AppError('只有发起人或 root 能续跑', { code: 'SKILLWHET_FORBIDDEN', statusCode: 403 });
    }
    const ck = await client.request<{ exists: boolean; matches?: boolean; round?: number; saved_at?: string }>(
      'GET', `/skills/${encodeURIComponent(job.skill)}/checkpoint`);
    // checkpoint 按 skill 存一份:只认这次作业跑的时间里存下的,别的作业留下的不许借这个作业的名义续
    const savedAt = ck.saved_at ? Date.parse(ck.saved_at) : NaN;
    const from = Date.parse(String(job.started_at ?? job.created_at));
    const to = job.finished_at ? Date.parse(job.finished_at) : Date.now();
    if (ck.exists && ck.matches && !(Number.isFinite(savedAt) && savedAt >= from - 1000 && savedAt <= to + 1000)) {
      throw new AppError('现有的 checkpoint 不是这次作业留下的(是另一次训练的)—— 请到那次作业上续跑,或新建训练', { code: 'SKILLWHET_NO_CHECKPOINT', statusCode: 409 });
    }
    if (!ck.exists || !ck.matches) {
      // 这次作业可能已被续跑过(checkpoint 归了那个续跑作业、跑完即删):要如实说明,不能报成"一轮都没跑完"
      const later = (await client.request<{ jobs: JobRow[] }>('GET', `/jobs?skill=${encodeURIComponent(job.skill)}&limit=200`).catch(() => ({ jobs: [] as JobRow[] })))
        .jobs.find((j) => (j.tags ?? []).includes(`resume_of:${id}`));
      if (later) {
        throw new AppError(`这次作业的 checkpoint 已被续跑作业 ${later.id} 使用(${later.state});要再续请到那个作业上操作`,
          { code: 'SKILLWHET_CHECKPOINT_CONSUMED', statusCode: 409, details: { resumed_by: later.id } });
      }
      throw new AppError(
        ck.exists ? '有 checkpoint,但任务集或副本在那之后变了 —— 续不上,请新建一次训练' : '这次训练一轮都没跑完,没有可续的 checkpoint —— 请新建一次训练',
        { code: 'SKILLWHET_NO_CHECKPOINT', statusCode: 409 });
    }
    const data = await startTrain(req, job.skill, { ...(job.args ?? {}), resume: true }, ` resume_of=${id} from_round=${ck.round ?? '?'}`, [`resume_of:${id}`]);
    res.json(createApiSuccessResponse(data));
  }));

  // ── 夜训计划 ──────────────────────────────────────────────────────
  const NIGHTLY_CONFIG_KEYS = new Set([
    'runner', 'fast_model', 'slow_model', 'eval_model', 'target_model', 'fast_iters', 'k', 'workers',
    'no_accept_rounds', 'gate_metric', 'no_slow_loop', 'judge_samples', 'test_dir',
    'fast_backend', 'slow_backend', 'eval_backend',
  ]);
  const planView = (row: NightlyPlanRow, root: boolean) => ({
    ...row,
    enrolled: row.enrolled === 1,
    config: parsePlanConfig(row),
    config_json: undefined,
    updated_by: root ? row.updated_by : null,
  });
  router.get('/nightly', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const budget = readBudget(env);
    const now = new Date();
    res.json(createApiSuccessResponse({
      plans: skillWhetNightlyDb.list().map((row) => planView(row, isRoot(user))),
      nightlyMaxCostUsd: budget.nightlyMaxCostUsd,
      maxCostUsd: budget.maxCostUsd,
      hardMaxCostUsd: budget.hardMaxCostUsd,
      nightlyHardMaxCostUsd: budget.nightlyHardMaxCostUsd,
      nightlyMaxRounds: budget.nightlyMaxRounds,
      autopauseAfter: NIGHTLY_AUTOPAUSE_AFTER,
      // 时窗按服务器本地时间;页面把这个摆出来,免得人按自己的时区填
      serverTime: { iso: now.toISOString(), local: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, offsetMin: -now.getTimezoneOffset(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      defaults: { window_start: '02:00', window_end: '06:00', rounds: 2, min_new_tasks: 5 },
    }));
  }));
  router.put('/nightly/:name', asyncHandler(async (req, res) => {
    const user = requireRoot(req, '纳入 / 移出夜训');
    const name = parseSkillName(req.params.name);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const budget = readBudget(env);
    const bad = (message: string) => new AppError(message, { code: 'SKILLWHET_BAD_NIGHTLY', statusCode: 400 });
    const before = skillWhetNightlyDb.get(name);
    const enrolled = body.enrolled === undefined ? before?.enrolled === 1 : body.enrolled === true;
    const windowStart = String(body.window_start ?? before?.window_start ?? '02:00');
    const windowEnd = String(body.window_end ?? before?.window_end ?? '06:00');
    if (!isHhMm(windowStart) || !isHhMm(windowEnd)) throw bad('时窗要写成 HH:MM(服务器本地时间)');
    if (windowStart === windowEnd) throw bad('时窗开始和结束不能相同');
    const rounds = Number(body.rounds ?? before?.rounds ?? 2);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > budget.nightlyMaxRounds) throw bad(`轮数 1–${budget.nightlyMaxRounds}`);
    const minNew = Number(body.min_new_tasks ?? before?.min_new_tasks ?? 5);
    if (!Number.isInteger(minNew) || minNew < 0 || minNew > 1000) throw bad('新任务门槛 0–1000');
    const rawCost = body.max_cost_usd === undefined ? before?.max_cost_usd ?? null : body.max_cost_usd;
    const maxCost = rawCost === null || rawCost === '' ? null : Number(rawCost);
    // 夜训只 root 能设,单次上限可越过 .env 到夜训硬上限;但不能超过一晚合计(否则每晚都排不上)
    const nightCap = Math.min(budget.nightlyHardMaxCostUsd, budget.nightlyMaxCostUsd);
    if (maxCost !== null && (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > nightCap)) {
      throw bad(`单次费用上限 0–${nightCap}(不能超过一晚合计 PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD=$${budget.nightlyMaxCostUsd},也不能超过夜训硬上限 $${budget.nightlyHardMaxCostUsd});留空 = 用 .env 的单次上限 $${budget.maxCostUsd}`);
    }
    const rawConfig = body.config === undefined ? (before ? parsePlanConfig(before) : {}) : body.config;
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) throw bad('config 必须是对象');
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawConfig as Record<string, unknown>)) {
      if (!NIGHTLY_CONFIG_KEYS.has(key)) throw bad(`夜训参数不支持 ${key}`);
      if (value === null || value === '' || value === undefined) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw bad(`${key} 的值类型不对`);
      // 夜训只有 root 能设,模型只查名字合不合法。
      if ((SKILLWHET_MODEL_KEYS as readonly string[]).includes(key) && !isSkillWhetModelAllowed(String(value), budget, true)) {
        throw bad(`${key}=${String(value)} 不是合法的模型名`);
      }
      config[key] = value;
    }
    let copyId: string | null = null;
    if (enrolled) {
      // 纳入前先确认它能训:有副本、已 bootstrap(任务集够不够由每晚的门槛管);记下这份副本的身份
      const status = await client.request<ManagedStatus & { bootstrapped?: boolean; imported_at?: string }>('GET', `/skills/${encodeURIComponent(name)}/status`);
      copyId = copyIdOf(status);
      if (!status.bootstrapped) {
        throw new AppError('这个副本还没 bootstrap(冻结 S₀),夜训起不来 —— 先在技能资产里点 bootstrap', { code: 'SKILLWHET_NOT_BOOTSTRAPPED', statusCode: 409 });
      }
      // 评估 ≠ 提议:按真名比(别名换成它映射到的网关模型),没填的角色按 SkillWhet 默认补上
      const usesMock = ['fast_backend', 'slow_backend', 'eval_backend'].some((key) => config[key] === 'mock');
      const conflict = usesMock ? null : await proposerEvaluatorConflict(config);
      if (conflict) throw bad(conflict);
    }
    const row = skillWhetNightlyDb.upsert(name, {
      enrolled, windowStart, windowEnd, maxCostUsd: maxCost, rounds, config, minNewTasks: minNew, copyId,
    }, user.id);
    const summary = `${name} ${windowStart}-${windowEnd} rounds=${rounds} min_new=${minNew} max=$${maxCost ?? budget.maxCostUsd} config=${JSON.stringify(config).slice(0, 200)}`;
    if (enrolled !== (before?.enrolled === 1)) audit(req, enrolled ? 'skillwhet_nightly_enroll' : 'skillwhet_nightly_unenroll', summary);
    else if (enrolled) audit(req, 'skillwhet_nightly_enroll', `${summary} (改设置)`);
    res.json(createApiSuccessResponse({ plan: planView(row, true) }));
  }));

  // ── staging / 采纳 / 导出 ────────────────────────────────────────────
  const parseStagingId = (value: unknown): string => {
    const id = String(value ?? '');
    if (!/^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(id)) throw new AppError('staging id 不合法', { code: 'SKILLWHET_BAD_STAGING', statusCode: 400 });
    return id;
  };
  router.get('/skills/:name/staging', asyncHandler(async (req, res) => {
    requireUser(req);
    const name = parseSkillName(req.params.name);
    res.json(createApiSuccessResponse(await client.request('GET', `/skills/${encodeURIComponent(name)}/staging`)));
  }));
  router.get('/skills/:name/staging/:sid', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    await assertMayRead(req, name);            // diff 与报告是副本内容,上传来源只给本人 / root
    res.json(createApiSuccessResponse(await client.request('GET', `/skills/${encodeURIComponent(name)}/staging/${parseStagingId(req.params.sid)}`, undefined, 30_000)));
  }));
  router.post('/skills/:name/staging/:sid/adopt', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    const sid = parseStagingId(req.params.sid);
    await assertMayMutate(req, name, '采纳到副本');
    const body = (req.body ?? {}) as { force?: unknown; skip_release?: unknown };
    // force(未被接受 / 副本被改过)与 skip_release(没做留出集评估)是两个开关,互不连带
    const data = await client.request('POST', `/skills/${encodeURIComponent(name)}/staging/${sid}/adopt`,
      { force: body.force === true, skip_release: body.skip_release === true }, 60_000);
    audit(req, 'skillwhet_adopt', `${name} ${sid}${body.force === true ? ' force' : ''}${body.skip_release === true ? ' skip_release' : ''}`);
    res.json(createApiSuccessResponse(data));
  }));
  /** 训练后的包(staging/proposed/,不含 .evo),原样转发 serve 的 tar.gz。 */
  router.get('/skills/:name/staging/:sid/export', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    await assertMayRead(req, name);            // 训练后的整包,上传来源只给本人 / root
    const sid = parseStagingId(req.params.sid);
    const { data, filename } = await client.requestRaw(`/skills/${encodeURIComponent(name)}/staging/${sid}/export`, 60_000);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || `${name}-${sid}.tar.gz`}"`);
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
  }));

  // ── 发布 / 回滚(root)─────────────────────────────────────────────────
  const rollbackRoot = path.join(config.home, 'rollback');
  const publish = async (req: Request, mode: 'replace' | 'new') => {
    const name = parseSkillName(req.params.name);
    const publisher = requireRoot(req, mode === 'new' ? '发布为新技能' : '发布到技能库');
    const status = await client.request<ManagedStatus & { adopted?: boolean; adopted_staging?: string | null; latest_staging?: string | null; imported_from?: string | null }>('GET', `/skills/${encodeURIComponent(name)}/status`);
    // 被发布的是"副本当前内容来自的那份 staging",不一定是最新一份
    const publishedStaging = status.adopted_staging ?? status.latest_staging ?? null;
    if (!status.adopted) {
      throw new AppError('最近一次 staging 还没采纳到副本;先在版本页「采纳」', { code: 'SKILLWHET_NOT_ADOPTED', statusCode: 409 });
    }
    const liveDirForSkill = path.join(liveRoot, name);
    if (mode === 'replace') {
      // 没有导入记录(纯上传、或从没 rebase 过)就没有 drift 可比 —— 替换会盖掉技能库里一个不相干的同名 skill
      const from = String(status.imported_from ?? '');
      if (!from || path.resolve(from) !== path.resolve(liveDirForSkill)) {
        throw new AppError(
          from
            ? `副本的导入记录指向 ${from},不是技能库里的 ${liveDirForSkill};先「从技能库更新副本」再发布`
            : '这份副本不是从技能库导入的(没有导入记录),不能整目录替换技能库里的同名 skill;上传来源请用「发布为新技能」(同名时先在技能库里改名)',
          { code: 'SKILLWHET_NO_IMPORT_RECORD', statusCode: 409 });
      }
    }
    const drift = mode === 'replace'
      ? (await client.request<{ drift: string[] }>('GET', `/skills/${encodeURIComponent(name)}/drift`)).drift
      : [];
    const result = publishManagedCopy({
      skill: name, workDir: path.join(config.home, 'work', name), liveRoot, rollbackRoot, drift, mode,
    });
    // 副本现在就是技能库那份:让 serve 重新钉 sha(上传来源顺带记下它的 live 位置)。失败不回滚发布,但要说出来
    let rebased = true;
    let rebaseError: string | null = null;
    // event=publish → serve 记一条发布记录(哪份 staging、谁、什么时候),版本页据此标「已发布」
    await client.request('POST', `/skills/${encodeURIComponent(name)}/rebase`, { live_dir: result.liveDir, event: 'publish', by: publisher.username, mode }).catch((error: unknown) => {
      rebased = false;
      rebaseError = error instanceof Error ? error.message : String(error);
    });
    audit(req, 'skillwhet_publish', `${name} ${mode} staging=${publishedStaging ?? '?'} files=${result.files.length}${result.rollback ? ` rollback=${path.basename(result.rollback)}` : ''}${rebased ? '' : ` rebase_failed=${rebaseError}`}`);
    return { ...result, stagingId: publishedStaging, rebased, rebaseError, note: rebased ? '技能库已更新;常驻会话要重开才读到新版' : `技能库已更新,但副本没能重新钉 sha(${rebaseError});下次发布前先「从技能库更新副本」` };
  };
  router.post('/skills/:name/publish', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(await publish(req, 'replace')));
  }));
  router.post('/skills/:name/publish-as-new', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(await publish(req, 'new')));
  }));
  router.get('/skills/:name/rollbacks', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    const user = requireUser(req);
    const rollbacks = listRollbacks(rollbackRoot, name).map((entry) => (isRoot(user) ? entry : { ts: entry.ts, files: entry.files }));
    res.json(createApiSuccessResponse({ rollbacks, liveExists: fs.existsSync(path.join(liveRoot, name, 'SKILL.md')) }));
  }));
  // 发布 / 回滚记录(serve 记在自己的 home 里);登录即可看,发起人只给 root
  router.get('/skills/:name/publishes', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    const user = requireUser(req);
    const data = await client.request<{ history: Array<Record<string, unknown>> }>('GET', `/skills/${encodeURIComponent(name)}/publishes`);
    const history = (Array.isArray(data.history) ? data.history : []).map((row) => (isRoot(user) ? row : { ...row, by: null }));
    res.json(createApiSuccessResponse({ history }));
  }));
  router.post('/skills/:name/rollback', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    const user = requireRoot(req, '回滚');
    const body = (req.body ?? {}) as { to?: unknown };
    const result = rollbackPublished({ skill: name, liveRoot, rollbackRoot, to: String(body.to ?? '') });
    await client.request('POST', `/skills/${encodeURIComponent(name)}/rebase`, { live_dir: result.liveDir, event: 'rollback', by: user.username, to: String(body.to ?? '') }).catch(() => undefined);
    audit(req, 'skillwhet_rollback', `${name} to=${String(body.to)}`);
    res.json(createApiSuccessResponse(result));
  }));

  // ── 任务集:从测试派生 / 来自反馈 ───────────────────────────────────────
  router.post('/tasks/derive', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { skill?: unknown; test_dir?: unknown; val_fraction?: unknown; test_fraction?: unknown };
    const skill = parseSkillName(body.skill);
    const { user, status } = await assertMayMutate(req, skill, '从测试派生任务集');
    if (!isRoot(user)) {
      // 派生会 import 副本里的测试模块(pytest --collect-only):非 root 同样要 G1 PASS
      const gate = await client.request<GateCache>('GET', `/skills/${encodeURIComponent(skill)}/gate`);
      const problem = g1Problem(gate, '派生任务');
      if (problem) throw new AppError(problem, { code: 'SKILLWHET_G1_REQUIRED', statusCode: 403 });
    }
    const data = await client.request<{ derived: number }>('POST', '/tasks/derive', {
      skill, test_dir: body.test_dir ?? 'tests/unit', val_fraction: body.val_fraction ?? 0.25, test_fraction: body.test_fraction ?? 0.25,
      tags: [`user:${user.id}`, `uploader:${user.username}`, `skill_source:${status.source}`],
    }, 60_000);
    audit(req, 'skillwhet_tasks_derive', `${skill} +${data.derived}`);
    res.json(createApiSuccessResponse(data));
  }));

  /** 一条反馈对应的用户原话:显示日志里那条回答之前最近的一条用户消息。 */
  const intentFor = (sessionId: string, messageId: string): string => {
    try {
      const messages = sessionMessagesDb.listForSession(sessionId);
      let intent = '';
      let found = false;
      for (const message of messages) {
        if (message.kind === 'text' && message.role === 'user' && typeof message.content === 'string') intent = message.content;
        if (message.id === messageId) { found = true; break; }
      }
      // 那条回答已不在显示日志里(会话被清理 / 老数据):不能把日志末尾的用户话当成它的原话
      return found ? intent.trim().slice(0, 4000) : '';
    } catch {
      return '';
    }
  };

  router.get('/feedback/inbox', asyncHandler(async (req, res) => {
    requireRoot(req, '看反馈收件箱');
    const skill = typeof req.query.skill === 'string' && req.query.skill ? parseSkillName(req.query.skill) : null;
    const rows = messageFeedbackDb.inbox(skill).map((row) => ({
      id: row.id, sessionId: row.session_id, projectId: row.project_id, messageId: row.message_id, userId: row.user_id,
      source: row.source, verdict: row.verdict, category: row.category, note: row.note, expectedOutput: row.expected_output,
      skill: row.skill_hint, updatedAt: row.updated_at, intent: intentFor(row.session_id, row.message_id),
      referenceKind: row.expected_output ? 'exact' : 'rubric',
    }));
    res.json(createApiSuccessResponse({ inbox: rows }));
  }));

  /**
   * 反馈 → 任务:期望结果 → `expected_output`(exact),只有待优化点 → `rubric`;
   * 好 / 一般 / 差 → outcome success / mixed / fail;打上 project / user 标签;入库后回填 task_id。
   */
  router.post('/feedback/inbox/accept', asyncHandler(async (req, res) => {
    const user = requireRoot(req, '把反馈转成任务');
    const body = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0).slice(0, 200) : [];
    if (ids.length === 0) throw new AppError('ids 不能为空', { code: 'SKILLWHET_BAD_INBOX', statusCode: 400 });
    // 只收"收件箱里真会出现"的行:answered、没转过、有待优化点或期望结果;skill_hint 是用户自由文本,
    // 必须过技能名校验(否则 `../x` 会变成 serve 侧的目录名)
    const skipped: Array<{ id: number; reason: string }> = [];
    const rows = messageFeedbackDb.getByIds(ids).filter((row) => {
      if (row.task_id) { skipped.push({ id: row.id, reason: 'already_task' }); return false; }
      if (row.status !== 'answered' || row.verdict === null || row.verdict > 0 || !(row.note || row.expected_output)) { skipped.push({ id: row.id, reason: 'not_inbox' }); return false; }
      if (!row.skill_hint || !SKILL_NAME.test(row.skill_hint) || row.skill_hint === '.' || row.skill_hint === '..') { skipped.push({ id: row.id, reason: 'bad_skill' }); return false; }
      return true;
    });
    const bySkill = new Map<string, typeof rows>();
    for (const row of rows) bySkill.set(row.skill_hint as string, [...(bySkill.get(row.skill_hint as string) ?? []), row]);
    const accepted: Array<{ id: number; taskId: string; skill: string }> = [];
    for (const [skill, group] of bySkill) {
      const records = group.map((row) => {
        const intent = intentFor(row.session_id, row.message_id);
        const rubric = row.note && row.note.trim().length >= 8 ? row.note.trim() : (row.note ? `${row.note.trim()}(来自用户反馈)` : '');
        return {
          task_id: `fb_${row.id}`,
          input: intent || `(会话 ${row.session_id} 的一次调用)`,
          ...(row.expected_output ? { expected_output: row.expected_output } : { rubric }),
          outcome: row.verdict === 1 ? 'success' : row.verdict === 0 ? 'mixed' : 'fail',
          tags: [`project:${row.project_id ?? ''}`, `user:${row.user_id}`, 'source:feedback'],
          context: row.category ?? undefined,
        };
      });
      const data = await client.request<{ added: number; report?: { rows?: Array<{ row: number; task_id: string; ok: boolean; errors: string[] }> } }>(
        'POST', '/tasks', { skill, format: 'records', records, keep_passing: true, source: 'feedback', tags: [`accepted_by:${user.username}`] }, 60_000);
      // 以 serve 的逐行报告为准;serve 没回报告时才按 added 数兜底。没被接受的行留在收件箱
      const report = Array.isArray(data.report?.rows) ? data.report!.rows! : null;
      const okRows = new Set((report ?? []).filter((r) => r.ok).map((r) => r.task_id));
      for (const row of group) {
        const taskId = `fb_${row.id}`;
        const ok = report ? okRows.has(taskId) : (data.added ?? 0) >= group.length;
        if (ok) {
          messageFeedbackDb.markTask(row.id, taskId);
          accepted.push({ id: row.id, taskId, skill });
        } else {
          skipped.push({ id: row.id, reason: (report ?? []).find((r) => r.task_id === taskId)?.errors?.[0] ?? 'rejected' });
        }
      }
    }
    audit(req, 'skillwhet_feedback_accept', `${accepted.length} 条 → ${[...bySkill.keys()].join(',')}${skipped.length ? ` 跳过 ${skipped.length}` : ''}`);
    res.json(createApiSuccessResponse({ accepted, skipped }));
  }));

  // ── 从会话里学:反馈叠加层 / 会话白名单 / harvest 作业 / release-eval ───────────

  /** 与 sessions.service 的 visibilityScopeOf 同一判据(root = 全部,其余按项目可见性)。 */
  const scopeOf = (user: RequestUser) => (isRoot(user) ? { kind: 'all' as const } : { kind: 'user' as const, userId: user.id });

  /** SQLite 的 "YYYY-MM-DD HH:MM:SS" 是 UTC 但不带 Z;ISO 的原样解析。 */
  const toMs = (value: unknown) => {
    const raw = String(value ?? '').trim();
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
  };

  /** transcript 文件名(= provider 会话 id):优先 jsonl_path 的文件名,其次 provider_session_id;都没有就不是可挖的会话。 */
  const transcriptIdOf = (row: { jsonl_path?: string | null; provider_session_id?: string | null }): string | null => {
    const fromPath = row.jsonl_path ? path.basename(String(row.jsonl_path), '.jsonl') : '';
    const id = fromPath || String(row.provider_session_id ?? '');
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : null;
  };

  /**
   * 这个人看得见的 Claude 会话(可按项目路径与时间筛),附 transcript id。root 的可见范围 = 全部
   * (与 sessions.service 的 visibilityScopeOf 同一判据)。分页取全,不在过滤前截断。
   */
  const visibleClaudeSessions = (user: RequestUser, projects: string[] | null, sinceMs: number | null) => {
    const out: Array<{ session_id: string; project_path: string; transcriptId: string; at: number }> = [];
    const page = 5_000;
    for (let offset = 0; offset < 200_000; offset += page) {
      const { rows } = sessionsDb.getVisibleSessionsPage(scopeOf(user), page, offset, { archived: 'include' });
      for (const row of rows) {
        if ((row.provider ?? 'claude') !== 'claude') continue;
        const projectPath = String(row.project_path ?? '');
        if (projects && !projects.includes(projectPath)) continue;
        const at = toMs(row.updated_at ?? row.created_at);
        if (sinceMs !== null && !(at >= sinceMs)) continue;
        const transcriptId = transcriptIdOf(row);
        if (!transcriptId) continue;
        out.push({ session_id: row.session_id, project_path: projectPath, transcriptId, at });
      }
      if (rows.length < page) break;
    }
    return out;
  };

  /** 解析成一个时刻(毫秒);坏值 400,不静默当成"不限"。 */
  const parseSince = (value: unknown): { ms: number; iso: string } | null => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : toMs(raw);
    if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/.test(raw) || !Number.isFinite(ms)) {
      throw new AppError('since 必须是 ISO 日期 / 时间(如 2026-09-01 或 2026-09-01T00:00:00Z)', { code: 'SKILLWHET_BAD_SINCE', statusCode: 400 });
    }
    return { ms, iso: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  };

  const OVERLAY_NOTE_MAX = 600;
  const OVERLAY_EXPECTED_MAX = 2_000;
  const OVERLAY_BUDGET_BYTES = 8 * 1024 * 1024;

  /**
   * 反馈叠加层:某 skill 的投票 / 调查答复,按 provider 会话 id(= transcript 文件名)组织成
   * `{ <sid>: [{ message_uuid, verdict, category, note, expected_output }] }`;原文先脱敏。
   * 只收 `sessions` 里那些会话的(调用方传的是白名单);对不上原生 uuid 的行(网关写的气泡)丢掉。
   */
  const buildOverlay = (skill: string, allowed: Map<string, string>) => {
    // 不按 since 筛反馈:白名单已经框定了会话,窗口里的会话上"早一点投的票"照样是这次对话的证据
    const overlay: Record<string, Array<Record<string, unknown>>> = {};
    let rows = 0;
    let bytes = 0;
    let truncated = 0;
    for (const row of messageFeedbackDb.overlayRows(skill, null, 200_000)) {
      const providerSid = allowed.get(row.session_id);
      const uuid = nativeUuidFromMessageId(row.message_id) ?? row.message_uuid;
      if (!providerSid || !uuid) continue;
      const item = {
        message_uuid: uuid, verdict: row.verdict, category: row.category,
        note: redactSecrets(row.note).slice(0, OVERLAY_NOTE_MAX),
        expected_output: redactSecrets(row.expected_output).slice(0, OVERLAY_EXPECTED_MAX),
      };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > OVERLAY_BUDGET_BYTES) { truncated += 1; continue; }
      bytes += size;
      (overlay[providerSid] ??= []).push(item);
      rows += 1;
    }
    return { overlay, rows, truncated };
  };

  router.get('/feedback/overlay', asyncHandler(async (req, res) => {
    const user = requireRoot(req, '导出反馈叠加层');
    const skill = parseSkillName(req.query.skill);
    const allowed = new Map(visibleClaudeSessions(user, null, null).map((row) => [row.session_id, row.transcriptId]));
    const data = buildOverlay(skill, allowed);
    audit(req, 'skillwhet_feedback_overlay', `${skill} rows=${data.rows}${data.truncated ? ` truncated=${data.truncated}` : ''}`);
    res.json(createApiSuccessResponse(data));
  }));

  /** 向导第一步:看得见的项目(只列有 Claude 会话的)与各自的会话数。 */
  router.get('/harvest/projects', asyncHandler(async (req, res) => {
    const user = requireRoot(req, '从会话挖任务');
    const byPath = new Map<string, { path: string; name: string; sessions: number; latest: string }>();
    for (const row of visibleClaudeSessions(user, null, null)) {
      const key = row.project_path;
      if (!key) continue;
      const entry = byPath.get(key) ?? { path: key, name: projectsDb.getCustomProjectName(key) || path.basename(key), sessions: 0, latest: '' };
      entry.sessions += 1;
      const at = Number.isFinite(row.at) ? new Date(row.at).toISOString() : '';
      if (at > entry.latest) entry.latest = at;
      byPath.set(key, entry);
    }
    res.json(createApiSuccessResponse({ projects: [...byPath.values()].sort((a, b) => b.latest.localeCompare(a.latest)) }));
  }));

  /**
   * 起一个 harvest 作业(root)。会话白名单 = 当前用户可见、且在显式选定的项目 / 时间窗里的 Claude
   * 会话的 transcript id(root 可见全部,所以项目不能省);叠加层只带这些会话里、这个 skill 的反馈。
   * `dry_run` 只列会话、零模型调用;真挖用 sonnet(root 可选 mock)。挖出来的东西先预览,入库另点。
   */
  router.post('/harvest', asyncHandler(async (req, res) => {
    const user = requireRoot(req, '从会话挖任务');
    const body = (req.body ?? {}) as { skill?: unknown; projects?: unknown; since?: unknown; dry_run?: unknown; backend?: unknown; model?: unknown; max_tasks?: unknown; limit?: unknown };
    const skill = parseSkillName(body.skill);
    await client.request('GET', `/skills/${encodeURIComponent(skill)}/status`);   // 404 = 没有副本
    // 项目必须显式选(不选 ≠ 全部):root 的可见范围是整台服务器
    const projects = Array.isArray(body.projects) ? body.projects.map((v) => String(v)).filter(Boolean) : [];
    if (projects.length === 0 || projects.length > 500) {
      throw new AppError('选 1–500 个项目', { code: 'SKILLWHET_NO_PROJECTS', statusCode: 400 });
    }
    const since = parseSince(body.since);
    const sessions = visibleClaudeSessions(user, projects, since?.ms ?? null);
    if (sessions.length === 0) {
      throw new AppError('所选项目 / 时间窗里没有你看得见的 Claude 会话', { code: 'SKILLWHET_NO_SESSIONS', statusCode: 409 });
    }
    const allowed = new Map(sessions.map((row) => [row.session_id, row.transcriptId]));
    const { overlay, rows, truncated } = buildOverlay(skill, allowed);
    const args: Record<string, unknown> = {
      sessions: [...new Set(allowed.values())],
      feedback_overlay: overlay,
      dry_run: body.dry_run === true,
      max_tasks: Math.min(200, Math.max(1, Number(body.max_tasks) || 40)),
      limit: Math.min(5000, Math.max(1, Number(body.limit) || 200)),
    };
    if (since) args.since = since.iso;
    if (body.backend === 'mock') args.backend = 'mock';
    if (typeof body.model === 'string' && body.model) {
      // harvest 只有 root 能起,模型只查名字合不合法。
      if (!isSkillWhetModelAllowed(body.model, readBudget(env), true)) {
        throw new AppError(`model=${body.model} 不是合法的模型名`, { code: 'SKILLWHET_MODEL_NOT_ALLOWED', statusCode: 400 });
      }
      args.model = body.model;
    }
    const data = await client.request<{ job: JobRow; position: number }>('POST', '/jobs', {
      kind: 'harvest', skill, args, origin: 'manual',
      tags: [`user:${user.id}`, `uploader:${user.username}`, 'kind:harvest'],
    }, 60_000);
    audit(req, 'skillwhet_harvest', `${skill} ${data.job.id} projects=${projects.length} since=${since?.iso ?? '-'} sessions=${(args.sessions as string[]).length} feedback=${rows}${truncated ? ` truncated=${truncated}` : ''}${args.dry_run ? ' dry_run' : ''}`);
    res.json(createApiSuccessResponse({ ...data, sessions: (args.sessions as string[]).length, feedbackRows: rows, feedbackTruncated: truncated }));
  }));

  /** harvest 结果(会话摘要里有脱敏后的用户原话)只给 root;release-eval 结果登录即可。 */
  router.get('/jobs/:id/result', asyncHandler(async (req, res) => {
    const user = requireUser(req);
    const id = parseJobId(req.params.id);
    const data = await client.request<{ kind: string }>('GET', `/jobs/${id}/result`);
    if (data.kind === 'harvest' && !isRoot(user)) {
      throw new AppError('挖任务的结果只有 root 能看', { code: 'SKILLWHET_ROOT_ONLY', statusCode: 403 });
    }
    res.json(createApiSuccessResponse(data));
  }));

  router.post('/jobs/:id/import', asyncHandler(async (req, res) => {
    const user = requireRoot(req, '把挖出来的任务入库');
    const id = parseJobId(req.params.id);
    const body = (req.body ?? {}) as { task_ids?: unknown };
    const taskIds = Array.isArray(body.task_ids) ? body.task_ids.map((v) => String(v)).slice(0, 1000) : undefined;
    const data = await client.request<{ added: number; total: number }>('POST', `/jobs/${id}/import`,
      { ...(taskIds ? { task_ids: taskIds } : {}), tags: [`accepted_by:${user.username}`] }, 60_000);
    audit(req, 'skillwhet_harvest_import', `${id} +${data.added}`);
    res.json(createApiSuccessResponse(data));
  }));

  /**
   * release-once:对一份 staging 做唯一一次留出集评估。权限同采纳(assertMayMutate);
   * 非 root 同训练:G1 PASS + 当日额度(非 pytest runner 按单次上限预留)。runner / 模型沿用产出这份
   * staging 的那次训练(从作业表里找;找不到就按 staging 报告里的 runner)。
   */
  router.post('/skills/:name/staging/:sid/release-eval', asyncHandler(async (req, res) => {
    const name = parseSkillName(req.params.name);
    const sid = parseStagingId(req.params.sid);
    const { user } = await assertMayMutate(req, name, '留出集评估');
    const jobs = (await client.request<{ jobs: JobRow[] }>('GET', `/jobs?skill=${encodeURIComponent(name)}&limit=1000`)).jobs;
    const origin = jobs.find((job) => (job.kind ?? 'train') === 'train' && job.staging === sid);
    const keys = ['runner', 'test_dir', 'judge_samples', 'workers', 'gate_metric', 'fast_backend', 'slow_backend', 'eval_backend', 'fast_model', 'slow_model', 'eval_model', 'target_model'];
    const args: Record<string, unknown> = { staging: sid };
    for (const key of keys) if (origin?.args && key in origin.args) args[key] = origin.args[key];
    if (!origin) {
      const detail = await client.request<{ report?: { model_snapshot?: { runner?: string } } }>('GET', `/skills/${encodeURIComponent(name)}/staging/${sid}`, undefined, 30_000);
      const runner = detail.report?.model_snapshot?.runner;
      if (runner && ['pytest', 'agent', 'simulate', 'mixed'].includes(runner)) args.runner = runner;
    }
    // mock 后端评出来的 test 分数没有意义,却会用掉这份 staging 唯一的一次:一律去掉,走真后端
    for (const key of ['fast_backend', 'slow_backend', 'eval_backend']) delete args[key];
    args.max_minutes = readBudget(env).maxHours * 60;
    if (!isRoot(user)) {
      const gate = await client.request<GateCache>('GET', `/skills/${encodeURIComponent(name)}/gate`);
      const problem = g1Problem(gate, '做留出集评估');
      if (problem) throw new AppError(problem, { code: 'SKILLWHET_G1_REQUIRED', statusCode: 403 });
    }
    await serializePerUser(user.id, async () => {
      if (!isRoot(user)) {
        const budget = readBudget(env);
        const reserve = (args.runner ?? 'pytest') === 'pytest' ? 0 : budget.maxCostUsd;
        const spent = await spentToday(user.id);
        if (spent + reserve > budget.userDailyMaxCostUsd) {
          throw new AppError(`今天的训练额度不够(已用 / 在途 $${spent.toFixed(2)},这次预留 $${reserve.toFixed(2)})`, { code: 'SKILLWHET_DAILY_BUDGET', statusCode: 429 });
        }
      }
      const data = await client.request<{ job: JobRow; position: number }>('POST', '/jobs', {
        kind: 'release_eval', skill: name, args, origin: 'manual',
        tags: [`user:${user.id}`, `uploader:${user.username}`, 'kind:release_eval'],
      }, 30_000);
      audit(req, 'skillwhet_release_eval', `${name} staging=${sid} ${data.job.id}`);
      res.json(createApiSuccessResponse(data));
    });
  }));

  return router;
}

export { SkillWhetClient };
