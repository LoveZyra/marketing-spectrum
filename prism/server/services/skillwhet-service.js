/**
 * gy:SkillWhet(技能优化)服务的进程托管 —— 让「起 Prism」顺带把 `whet serve` 也起起来。
 *
 * 与 `ma-service.js` 同一个形状(默认关闭、监听地址从反代目标反推、healthz 轮询、退避重启、
 * Prism 退出一起收、日志并进 prism.log),只是子进程换成
 * `<python> -m skillwhet serve --host … --port … --home …`,口令换成 SKILLWHET_TOKEN。
 * 监管逻辑(退避重启、healthz 轮询、TERM → KILL)在 child-supervisor.js 与 ma-service 共用(hl)。
 *
 * 环境变量(全部可选,不配 = 原行为):
 *   PRISM_SKILLWHET_ENABLE=1        不配:整层不挂载(路由与轨位都没有)
 *   PRISM_SKILLWHET_AUTOSTART=1     由 Prism 拉起 `whet serve`;不配:假定已有人起好,只转发
 *   PRISM_SKILLWHET_TARGET          回环目标,默认 http://127.0.0.1:8093;同时决定子进程监听端口
 *   PRISM_SKILLWHET_HOME            工作根,默认 ~/.prism/skillwhet
 *   PRISM_SKILLWHET_PYTHON          解释器,默认 python3(线上 Python < 3.11 时指到单独环境)
 *   PRISM_SKILLWHET_TOKEN           Prism ↔ serve 共享口令;不配则起服时生成一个(重启就换)
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { parseUpstream } from '../routes/proxy-kit.js';
import { withBundledClaudeOnPath } from '../shared/claude-cli-path.js';

import { HEALTH_WAIT_MS, createChildSupervisor } from './child-supervisor.js';

export const DEFAULT_TARGET = 'http://127.0.0.1:8093';

/** 是否挂载整层(路由 + 轨位)。 */
export function skillWhetEnabled(env = process.env) {
  return String(env.PRISM_SKILLWHET_ENABLE ?? '').trim() === '1';
}

export function defaultHome(env = process.env) {
  const raw = String(env.PRISM_SKILLWHET_HOME ?? '').trim();
  if (!raw) return path.join(os.homedir(), '.prism', 'skillwhet');
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

/**
 * 解析整层的配置。`token` 不配就生成 —— 它只在 Prism 与本机子进程之间用,重启换一个也无妨;
 * 但 AUTOSTART 没配(serve 是别人起的)时必须显式给,否则两边对不上,起服时直说。
 */
export function resolveSkillWhetConfig(env = process.env, logger = console) {
  if (!skillWhetEnabled(env)) return { enabled: false };
  const upstream = parseUpstream(String(env.PRISM_SKILLWHET_TARGET ?? '').trim() || DEFAULT_TARGET);
  if (!upstream.ok) {
    (logger.error ?? logger.log)?.call(logger,
      `[skillwhet] PRISM_SKILLWHET_TARGET 不可用(${upstream.reason}),技能优化不挂载。目标必须是回环地址,例如 http://127.0.0.1:8093。`);
    return { enabled: false, reason: `target_${upstream.reason}` };
  }
  const autostart = String(env.PRISM_SKILLWHET_AUTOSTART ?? '').trim() === '1';
  let token = String(env.PRISM_SKILLWHET_TOKEN ?? '').trim();
  let generatedToken = false;
  if (!token) {
    if (!autostart) {
      (logger.error ?? logger.log)?.call(logger,
        '[skillwhet] PRISM_SKILLWHET_TOKEN 没配,而 PRISM_SKILLWHET_AUTOSTART 也没配 —— 外部起的 serve 用的是哪个口令 Prism 无从得知,技能优化不挂载。');
      return { enabled: false, reason: 'no_token' };
    }
    token = crypto.randomBytes(24).toString('hex');
    generatedToken = true;
  }
  return {
    enabled: true,
    autostart,
    host: upstream.host,
    port: upstream.port,
    label: upstream.label,
    baseUrl: `http://${upstream.host}:${upstream.port}`,
    token,
    generatedToken,
    home: defaultHome(env),
    python: String(env.PRISM_SKILLWHET_PYTHON ?? '').trim() || 'python3',
  };
}

/** /healthz 的应答像不像 skillwhet。像 → { skillwhet: true, version };不像 → { skillwhet: false }。 */
export function identify(body) {
  try {
    const parsed = JSON.parse(body);
    // hl:serve 的所有应答(含 /healthz)都包在 { ok: true, data: {...} } 信封里,原来只认平铺形状 ——
    // 每次启动都判成"还没就绪"白等 30 秒并打一条误导的超时告警;Prism 崩溃后遗留的 serve 还会被
    // 判成"端口被别的服务占着"。两种形状都认。
    const data = parsed && parsed.ok === true && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    if (data && data.ok === true && typeof data.version === 'string' && typeof data.home === 'string') {
      return { skillwhet: true, version: data.version };
    }
  } catch { /* 不是 JSON */ }
  return { skillwhet: false };
}

const CHILD_ENV_EXACT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYTHONPATH', 'PYTHONHASHSEED', 'PYTHONIOENCODING',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE']);
const CHILD_ENV_PREFIX = ['LC_', 'XDG_', 'ANTHROPIC_', 'CLAUDE_', 'SKILLWHET_'];

/** serve 子进程的环境:白名单,不把 Prism 的密钥 / DB 路径 / JWT 配置带给训练子进程。 */
export function pickChildEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== 'string') continue;
    if (CHILD_ENV_EXACT.has(key) || CHILD_ENV_PREFIX.some((prefix) => key.startsWith(prefix))) out[key] = value;
  }
  return out;
}

export function probeHealth(host, port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/healthz', method: 'GET', timeout: timeoutMs },
      (res) => {
        // gz:不只看"有没有 200",还认一下身份 —— 任何 HTTP 服务在这个口上都会应答,
        // 只有 skillwhet 的 /healthz 回 { ok, version, home }。
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (body.length < 8192) body += chunk; });
        res.on('end', () => resolve({ alive: true, status: res.statusCode, ...identify(body) }));
        res.on('error', () => resolve({ alive: true, status: res.statusCode, skillwhet: false }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ alive: false, reason: err?.code || 'error' }));
    req.end();
  });
}

export function createSkillWhetSupervisor(config, {
  logger = console,
  env = process.env,
  spawnFn = spawn,
  probe = probeHealth,
  ...rest
} = {}) {
  return createChildSupervisor({
    tag: '[skillwhet]',
    label: config.label,
    host: config.host,
    port: config.port,
    spawnChild({ info, warn }) {
      const tmp = path.join(config.home, 'tmp', 'prism-skillwhet');
      // TMPDIR 指进工作根:serve 自己也会设,这里再给一遍是为了 python 启动阶段就生效。
      // 只给 serve(以及它拉起的训练子进程、claude CLI)用得着的环境:PATH / HOME / 语言 / 代理 /
      // Anthropic 与 Claude CLI 的配置 / Python 相关;Prism 自己的 DB 路径、JWT 密钥等不带过去(gz 审计 #15)
      // hm(A2 / Q11):SDK 随包 claude 所在目录放 PATH 最前 —— SkillWhet 的 `claude -p` 与对话同一个版本
      // (`CLAUDE_CLI_PATH` 显式配了就不动,见 withBundledClaudeOnPath);不让它自己去装新版本。
      const childEnv = {
        ...withBundledClaudeOnPath(pickChildEnv(env), { configuredPath: env.CLAUDE_CLI_PATH }),
        DISABLE_AUTOUPDATER: '1',
        SKILLWHET_TOKEN: config.token, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
      };
      const args = ['-m', 'skillwhet', 'serve', '--host', config.host, '--port', String(config.port), '--home', config.home];
      // cwd 不存在时 spawn 只报 'error' 不一定报 'exit',重启逻辑接不到 —— 先把工作根建出来。
      try { fs.mkdirSync(tmp, { recursive: true }); } catch (err) { warn(`建不了工作根 ${config.home}:${err?.message || err}`); }
      info(`拉起 ${config.python} ${args.join(' ')}`);
      return spawnFn(config.python, args, {
        cwd: config.home,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    },
    onSpawnError: (err) =>
      `拉不起来:${err?.message || err}(解释器是不是不叫 ${config.python}?PRISM_SKILLWHET_PYTHON 可以改)`,
    infantExitMessage:
      '子进程以退出码 2 立刻退出 —— 通常是 skillwhet 没装(pip install -e ~/prism/skillwhet)或 Python 版本 < 3.11。' +
      '重启解决不了,看上面 | 开头的几行。已放弃自启;Prism 其余功能不受影响。',
    classifyExisting: (pre) => {
      if (pre.skillwhet === false) {
        // gz:口上是别的 HTTP 服务(gy 现场:8093 被 ma-diagnose-api 占着)。拉起也只会 bind 失败,直说。
        return {
          state: 'failed',
          message: `${config.label} 上在应答的不是 skillwhet(/healthz 回的不是 { ok, version, home });端口被别的服务占着。` +
                   '把 PRISM_SKILLWHET_TARGET 改成一个空闲的回环端口(例如 http://127.0.0.1:8094)再重启。技能优化本次不可用。',
        };
      }
      return {
        state: 'external',
        message: `${config.label} 上已经有 skillwhet${pre.version ? ` ${pre.version}` : ''} 在应答,不重复拉起;它不由 Prism 托管。` +
                 (config.generatedToken ? ' 注意:PRISM_SKILLWHET_TOKEN 没配而口令是本次生成的,外部那个 serve 多半对不上。' : ''),
      };
    },
    isReady: (r) => r.alive && r.skillwhet !== false,
    readyMessage: (r, pid) =>
      `serve 就绪 ${config.label}(HTTP ${r.status}${r.version ? `,skillwhet ${r.version}` : ''},pid=${pid})`,
    timeoutMessage: () =>
      `等了 ${rest.healthWaitMs ?? HEALTH_WAIT_MS}ms 还没等到 ${config.label}/healthz;进程还在,就绪之前 /api/skillwhet/* 会返回 503。`,
  }, { logger, probe, ...rest });
}

/** index.js 用:配了 ENABLE + AUTOSTART 才返回 supervisor,其余 null。 */
export function createSkillWhetServiceFromConfig(config, logger = console, env = process.env) {
  if (!config?.enabled || !config.autostart) return null;
  return createSkillWhetSupervisor(config, { logger, env });
}

/* ── jobs/ 保留策略(hl,静态 P3「SkillWhet home 在 Prism 一侧无保留策略」) ──────────── */

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JOBS_RETENTION_DAYS = 90;

/** PRISM_SKILLWHET_JOBS_RETENTION_DAYS:默认 90;0 = 永不清理;认不出的值按默认。 */
export function jobsRetentionDaysFromEnv(env = process.env) {
  const raw = String(env.PRISM_SKILLWHET_JOBS_RETENTION_DAYS ?? '').trim();
  if (!raw) return DEFAULT_JOBS_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_JOBS_RETENTION_DAYS;
  return parsed;
}

/**
 * 一个作业目录"多老":优先 state.json 的 finished_at,其次 created_at,都没有用目录 mtime。
 * 排队中 / 运行中的作业**永远不删**(serve 重启后它们会被标成 interrupted,那时才进入计时)。
 * @returns {{ live: boolean, ageMs: number }}
 */
function inspectJobDir(dir, nowMs) {
  let live = false;
  let stampMs = NaN;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    live = state?.state === 'queued' || state?.state === 'running';
    const stamp = state?.finished_at || state?.created_at;
    if (stamp) stampMs = Date.parse(stamp);
  } catch { /* 没有 / 坏的 state.json:按目录时间 */ }
  if (!Number.isFinite(stampMs)) {
    try { stampMs = fs.statSync(dir).mtimeMs; } catch { stampMs = nowMs; }
  }
  return { live, ageMs: nowMs - stampMs };
}

/**
 * 清 `<home>/jobs/` 下超过保留天数的作业目录(训练产物、日志、进度文件)。
 * 只碰 jobs/,不碰 work/(受管副本)与 tasks/(任务集)—— 那两个是"资产",作业目录是"记录"。
 * 目录名不合作业 id 的形状(有 / 或 ..)不动;删不掉的记一条 warn 继续。
 *
 * @returns {{ removed: string[], kept: number }}
 */
export function pruneSkillWhetJobs(home, { retentionDays = DEFAULT_JOBS_RETENTION_DAYS, now = () => Date.now(), logger = console } = {}) {
  const removed = [];
  let kept = 0;
  if (!(retentionDays > 0)) return { removed, kept };
  const jobsDir = path.join(home, 'jobs');
  let entries;
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return { removed, kept };
  }
  const nowMs = now();
  const limitMs = retentionDays * DAY_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
    const dir = path.join(jobsDir, entry.name);
    const { live, ageMs } = inspectJobDir(dir, nowMs);
    if (live || ageMs <= limitMs) { kept += 1; continue; }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (err) {
      (logger.warn ?? logger.log)?.call(logger, `[skillwhet] 清不掉旧作业目录 ${dir}:${err?.message || err}`);
      kept += 1;
    }
  }
  if (removed.length > 0) {
    logger.log?.(`[skillwhet] 已清理 ${removed.length} 个超过 ${retentionDays} 天的作业目录(jobs/),保留 ${kept} 个`);
  }
  return { removed, kept };
}

/**
 * 定时清理:启动后 5 分钟跑第一次(别和起服抢 IO),之后每天一次。定时器 unref,不拖住退出。
 * ENABLE 没开 / 保留天数为 0 时返回 null。index.js 在 shutdown 里调 stop()。
 */
export function startSkillWhetJobsPruner(config, { env = process.env, logger = console, initialDelayMs = 5 * 60_000, intervalMs = DAY_MS } = {}) {
  if (!config?.enabled) return null;
  const retentionDays = jobsRetentionDaysFromEnv(env);
  if (!(retentionDays > 0)) return null;
  const run = () => {
    try { pruneSkillWhetJobs(config.home, { retentionDays, logger }); } catch (err) {
      (logger.error ?? logger.log)?.call(logger, `[skillwhet] 作业目录清理失败:${err?.message || err}`);
    }
  };
  let first = setTimeout(() => { first = null; run(); }, initialDelayMs);
  first.unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return {
    retentionDays,
    stop() {
      if (first) { clearTimeout(first); first = null; }
      clearInterval(timer);
    },
  };
}
