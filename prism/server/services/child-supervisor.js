/**
 * 受管子进程的公共监管逻辑:`ma-service.js`(营销诊断 Python 服务)与
 * `skillwhet-service.js`(`whet serve`)共用。
 *
 * 按行拆日志、退出分类、退避重启、healthz 轮询、TERM → KILL 收尾都在这里;两种子进程的差异
 * (怎么 spawn、就绪怎么判、端口上已有人时怎么处置、两条报错文案)做成钩子。
 *
 * 钩子(`spec`):
 *   tag            日志前缀,如 '[ma-service]'
 *   label          目标的可读名(host:port)
 *   host / port    healthz 探测地址
 *   spawnChild({ info, warn, fail })   起子进程,返回 ChildProcess。cwd / env / 参数都由调用方决定,
 *                  拉起前那行"拉起 …"也由它用传入的带前缀日志函数打
 *   onSpawnError(err) → string       'error' 事件的文案
 *   infantExitMessage                退出码 2 且活不过 infantMs 时的文案(配置问题,放弃自启)
 *   classifyExisting(probe) → { state: 'external' | 'failed', message } | null
 *                  start 前探到端口上已有人应答时怎么处置;null = 当没人
 *   isReady(probe) → boolean         轮询 healthz 时"就绪"的判据
 *   readyMessage(probe, pid) / timeoutMessage()   两条日志文案
 */

/** 起不来时最多重试几次。到顶就不再试了,免得在日志里刷屏。 */
export const MAX_RESTARTS = 5;
/** 重启退避:1s、2s、4s、8s、16s,封顶 30s。 */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** 起来不到这么久就退出,算"根本没起来",而不是"跑了一阵子崩了"。 */
export const INFANT_MS = 3_000;
/** 拉起后等 healthz 的总时长。real 模式导入 pandas 之类的确实要几秒。 */
export const HEALTH_WAIT_MS = 30_000;
export const HEALTH_POLL_MS = 500;
/** stop() 里从 SIGTERM 升级到 SIGKILL 的等待时间。 */
export const TERM_GRACE_MS = 4_000;

/**
 * @param {object} spec 见文件头
 * @param {object} [deps] 依赖(spawn / probe / 计时)都可注入,测试里不用真起子进程
 */
export function createChildSupervisor(spec, {
  logger = console,
  probe,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  maxRestarts = MAX_RESTARTS,
  healthWaitMs = HEALTH_WAIT_MS,
  healthPollMs = HEALTH_POLL_MS,
  infantMs = INFANT_MS,
  termGraceMs = TERM_GRACE_MS,
} = {}) {
  const { tag } = spec;
  let child = null;
  let stopping = false;
  let restarts = 0;
  let startedAt = 0;
  let state = 'idle';           // idle | external | starting | running | failed | stopped

  const info = (m) => logger.log?.(`${tag} ${m}`);
  const warn = (m) => (logger.warn ?? logger.log)?.call(logger, `${tag} ${m}`);
  const fail = (m) => (logger.error ?? logger.log)?.call(logger, `${tag} ${m}`);

  /** 把子进程的输出按行并进 Prism 的日志,带前缀。整块 chunk 直接打会把半行截断。 */
  function pipeLines(stream, level) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\s+$/, '');
        buf = buf.slice(idx + 1);
        if (line) (level === 'err' ? warn : info)(`| ${line}`);
      }
      if (buf.length > 8192) { (level === 'err' ? warn : info)(`| ${buf}`); buf = ''; }
    });
  }

  function spawnOnce() {
    // 带前缀的日志函数交给调用方,拉起前的那行"拉起 …"由它打,文案与之前逐字一致。
    const proc = spec.spawnChild({ info, warn, fail });
    startedAt = now();
    if (proc.stdout) pipeLines(proc.stdout, 'out');
    if (proc.stderr) pipeLines(proc.stderr, 'err');

    proc.on('error', (err) => {
      fail(spec.onSpawnError(err));
    });

    proc.on('exit', (code, signal) => {
      if (child === proc) child = null;
      const lived = now() - startedAt;
      if (stopping) { state = 'stopped'; info(`子进程已退出(code=${code} signal=${signal})`); return; }

      // 体检没过时服务自己会 exit 2。那是配置问题,重启一百次也一样,
      // 而且日志会被刷屏 —— 直接放弃,把原因留在上面那几行子进程日志里。
      if (code === 2 && lived < infantMs) {
        state = 'failed';
        fail(spec.infantExitMessage);
        return;
      }
      if (restarts >= maxRestarts) {
        state = 'failed';
        fail(`子进程已重启 ${restarts} 次仍然起不来,放弃。` +
             `(最后一次 code=${code} signal=${signal},活了 ${lived}ms)`);
        return;
      }
      restarts += 1;
      const wait = Math.min(BACKOFF_BASE_MS * 2 ** (restarts - 1), BACKOFF_CAP_MS);
      warn(`子进程退出(code=${code} signal=${signal},活了 ${lived}ms),` +
           `${wait}ms 后第 ${restarts}/${maxRestarts} 次重启`);
      setTimeout(() => { if (!stopping) { state = 'starting'; child = spawnOnce(); } }, wait).unref?.();
    });

    return proc;
  }

  return {
    get state() { return state; },
    get pid() { return child?.pid ?? null; },
    target: spec.label,

    /** 幂等:已经在跑(或已经有别人占着这个端口)就不重复拉。 */
    async start() {
      if (child || state === 'external') return state;
      stopping = false;

      // 先看端口上有没有人。三种情况都会命中:运维手动起过、上一次 Prism 被 SIGKILL
      // 掉了没收干净、tsx --watch 重启。不判这一下就是稳定的 EADDRINUSE 起崩循环。
      const pre = await probe(spec.host, spec.port);
      const existing = pre.alive ? spec.classifyExisting(pre) : null;
      if (existing) {
        state = existing.state;
        (existing.state === 'failed' ? fail : info)(existing.message);
        return state;
      }

      state = 'starting';
      child = spawnOnce();

      const deadline = now() + healthWaitMs;
      while (now() < deadline) {
        await sleep(healthPollMs);
        if (state === 'failed') return state;
        const r = await probe(spec.host, spec.port);
        if (spec.isReady(r)) {
          state = 'running';
          info(spec.readyMessage(r, child?.pid));
          return state;
        }
        if (!child && state !== 'starting') return state;
      }
      // 超时不等于失败:子进程可能只是启动慢(real 模式导 pandas)。反代照挂,
      // 起来之前调用方会拿到 502,起来之后自动就好了 —— 说清楚就行,不必杀掉。
      warn(spec.timeoutMessage());
      state = 'running';
      return state;
    },

    /** Prism 退出时调用。先 SIGTERM,给一点时间收尾,不走再 SIGKILL。 */
    async stop() {
      stopping = true;
      const proc = child;
      if (!proc) { state = 'stopped'; return; }
      info(`收掉子进程 pid=${proc.pid}`);
      try { proc.kill('SIGTERM'); } catch { /* 已经没了 */ }
      const deadline = now() + termGraceMs;
      while (child && now() < deadline) await sleep(100);
      if (child) {
        warn('SIGTERM 之后还在,升级到 SIGKILL');
        try { proc.kill('SIGKILL'); } catch { /* 已经没了 */ }
      }
      state = 'stopped';
    },
  };
}
