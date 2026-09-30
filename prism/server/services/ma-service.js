/**
 * 营销诊断服务的进程托管 —— 让「起 Prism」顺带把诊断服务也起起来。
 *
 * 背景:诊断服务(ma_api_c.py / ma_api_b.py)是个独立的 Python 进程,只听回环。
 * 对外靠 routes/ma-proxy.js 把 Prism 8080 的 /api/ma/* 转过去 —— 因为公司网关
 * 只转发 8080,而 8080 是 Prism 的。
 *
 * 在这个模块出现之前,部署要分两步:先在某个 shell 里 export 一堆 MA_* 再
 * nohup 起 Python,然后另起一个 shell export PRISM_MA_API_TARGET 再起 Prism。
 * 两步之间有三种常见的踩法,而且都不会立刻报错:
 *   · 端口写岔了(反代指 8092,服务听 8091)—— 症状是 502,但看日志两边都"正常"
 *   · Python 那个 shell 关了,服务跟着没了 —— Prism 还活着,接口静默变 502
 *   · 机器重启,只有 Prism 有开机自启 —— 同上
 * 所以这里把它收成一件事:进程由 Prism 拉起、日志并到 Prism 的日志、Prism 退出
 * 时一起收掉;监听地址**从 PRISM_MA_API_TARGET 反推**,反代和服务不可能再对不上。
 *
 * 仍然是**默认关闭**的:PRISM_MA_API_AUTOSTART 不配就什么都不做,Prism 的行为
 * 和以前逐字节一致。这一点和反代本身的口径保持一致(PRISM_MA_API_TARGET 不配
 * 就整个不挂载),原因也一样 —— 绝大多数装 Prism 的人根本不跑这个诊断服务。
 *
 * 环境变量:
 *   PRISM_MA_API_AUTOSTART   诊断服务入口的**绝对路径**(…/ma_api_c.py)。不配=不启动
 *   PRISM_MA_API_TARGET      反代目标,同时决定子进程的 MA_API_HOST/MA_API_PORT
 *   PRISM_MA_API_PYTHON      解释器,默认 python3
 *   PRISM_MA_API_ALLOW_NO_KEY=1  允许在没有 MA_API_KEY 的情况下自启(默认拒绝)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { parseUpstream } from '../routes/ma-proxy.js';

import { HEALTH_WAIT_MS, createChildSupervisor } from './child-supervisor.js';

/**
 * 探一下回环上的 /healthz。
 * 只关心"有没有人应答",不关心状态码 —— 服务在体检失败时也可能回非 200,
 * 但那说明端口已经被它占了,照样不该重复拉起。
 */
export function probeHealth(host, port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: '/healthz', method: 'GET', timeout: timeoutMs, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ alive: true, status: res.statusCode }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ alive: false, reason: err?.code || 'error' }));
    req.end();
  });
}

/**
 * 把环境变量翻成一份启动方案,或者说明白为什么不启动。
 * 单独抽出来是为了能不碰进程地测 —— 这里每一条拒绝都是一个真实的部署事故。
 *
 * @returns {{ok: true, script, cwd, python, host, port, label}
 *          |{ok: false, reason: string, message: string, silent?: boolean}}
 */
export function planAutostart(env = process.env, { exists = fs.existsSync } = {}) {
  const raw = String(env.PRISM_MA_API_AUTOSTART ?? '').trim();
  if (!raw) {
    // 没配就是没配,不是错。默认路径,一个字都不该打。
    return { ok: false, reason: 'disabled', message: '', silent: true };
  }

  if (!env.PRISM_MA_API_TARGET) {
    return {
      ok: false,
      reason: 'no_target',
      message:
        'PRISM_MA_API_AUTOSTART 配了,但 PRISM_MA_API_TARGET 没配 —— 不启动。' +
        '诊断服务只听回环,没有反代就没有任何入口,拉起来也只是白占一个端口。' +
        '两个一起配:export PRISM_MA_API_TARGET=127.0.0.1:8092',
    };
  }

  const upstream = parseUpstream(env.PRISM_MA_API_TARGET);
  if (!upstream.ok) {
    return {
      ok: false,
      reason: `target_${upstream.reason}`,
      message: `PRISM_MA_API_TARGET 不可用(${upstream.reason}),不启动子进程。` +
        '目标必须是回环地址,例如 127.0.0.1:8092。',
    };
  }

  if (!path.isAbsolute(raw)) {
    return {
      ok: false,
      reason: 'not_absolute',
      message:
        `PRISM_MA_API_AUTOSTART 得是绝对路径,给的是「${raw}」。` +
        '相对路径会跟着 Prism 的启动目录变 —— 今天在项目根目录起能跑,' +
        '明天用 systemd 起(cwd=/)就找不着了,而且报错发生在部署之后。',
    };
  }
  if (!exists(raw)) {
    return {
      ok: false,
      reason: 'not_found',
      message: `PRISM_MA_API_AUTOSTART 指的文件不存在:${raw}`,
    };
  }

  // 口令这一关放在最后,因为前面几条是"配错了",这条是"配对了但不安全"。
  const key = String(env.MA_API_KEY ?? '').trim();
  const allowNoKey = String(env.PRISM_MA_API_ALLOW_NO_KEY ?? '').trim() === '1';
  if (!key && !allowNoKey) {
    return {
      ok: false,
      reason: 'no_key',
      message:
        '没设 MA_API_KEY,拒绝自启。自启的意思就是这个接口会挂在 Prism 8080 的 ' +
        '/api/ma/* 下面,而 8080 是公司网关唯一转发的端口 —— 它是对外的。' +
        '没有口令 = 谁都能下单跑诊断、谁都能读走人群规则。' +
        '本机自己玩、确实不要口令:PRISM_MA_API_ALLOW_NO_KEY=1。',
    };
  }
  // Claude Code CLI 的凭证就存在一个叫 API_KEY 的环境变量里,而且会被子进程继承。
  // 两个值相等 = 把模型密钥当成了本服务的门禁口令,调过一次接口的人就拿到了它。
  // 这不是理论风险,是"图省事直接复用"最容易犯的错,所以在这儿硬拦。
  const llmKey = String(env.API_KEY ?? '').trim();
  if (key && llmKey && key === llmKey) {
    return {
      ok: false,
      reason: 'key_reuse',
      message:
        'MA_API_KEY 和环境里的 API_KEY 是同一个值,拒绝自启。' +
        'API_KEY 是 Claude Code CLI 的模型密钥,子进程会继承它;' +
        '拿它当接口口令,等于把模型密钥发给每一个调用方。换一个独立的值。',
    };
  }

  return {
    ok: true,
    script: raw,
    cwd: path.dirname(raw),
    python: String(env.PRISM_MA_API_PYTHON ?? '').trim() || 'python3',
    host: upstream.host,
    port: upstream.port,
    label: upstream.label,
  };
}

/**
 * 进程托管本体。返回一个有 start/stop/status 的对象。
 * 依赖(spawn / probe / 计时)都可注入,测试里不用真起 Python。
 * 监管逻辑在 child-supervisor.js(与 skillwhet-service 共用),这里只描述"怎么起、怎么算就绪"。
 */
export function createMaServiceSupervisor(plan, {
  logger = console,
  env = process.env,
  spawnFn = spawn,
  probe = probeHealth,
  ...rest
} = {}) {
  return createChildSupervisor({
    tag: '[ma-service]',
    label: plan.label,
    host: plan.host,
    port: plan.port,
    spawnChild({ info }) {
      // 监听地址从反代目标反推,不给子进程自己发挥的余地 —— 这正是要根除的那类事故:
      // 反代指着 8092,服务因为环境里残留的 MA_API_PORT 听在 8091,两边日志都"正常"。
      const childEnv = { ...env, MA_API_HOST: plan.host, MA_API_PORT: String(plan.port) };
      info(`拉起 ${plan.python} ${plan.script}(cwd=${plan.cwd},监听 ${plan.label})`);
      return spawnFn(plan.python, [plan.script], {
        cwd: plan.cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 不 detached:留在 Prism 的进程组里,终端里 Ctrl-C 能一并收掉。
        detached: false,
      });
    },
    onSpawnError: (err) => `拉不起来:${err?.message || err}(解释器是不是不叫 ${plan.python}?)`,
    infantExitMessage:
      '子进程以退出码 2 立刻退出 —— 这是它自己的环境体检没过,' +
      '不是偶发崩溃。重启解决不了,看上面 | 开头的几行。已放弃自启;' +
      'Prism 其余功能不受影响。',
    classifyExisting: (pre) => ({
      state: 'external',
      message: `${plan.label} 上已经有服务在应答(HTTP ${pre.status}),不重复拉起。` +
               '它不由 Prism 托管,Prism 退出时也不会收掉它。',
    }),
    isReady: (r) => r.alive,
    readyMessage: (r, pid) => `已就绪:${plan.label}/healthz 应答 HTTP ${r.status},pid=${pid}`,
    timeoutMessage: () =>
      `等了 ${rest.healthWaitMs ?? HEALTH_WAIT_MS}ms 还没等到 ${plan.label}/healthz。` +
      '进程还在,可能只是启动慢;在它就绪之前 /api/ma/* 会返回 502。',
  }, { logger, probe, ...rest });
}

/**
 * index.js 用的入口:配了就返回一个 supervisor,没配返回 null。
 * 所有"配错了"的情况都只打日志、返回 null —— 诊断服务起不来不该让 Prism 起不来。
 */
export function createMaServiceFromEnv(env = process.env, logger = console) {
  const plan = planAutostart(env);
  if (!plan.ok) {
    if (!plan.silent) {
      (logger.error ?? logger.log)?.call(logger, `[ma-service] 未自启:${plan.message}`);
    }
    return null;
  }
  return createMaServiceSupervisor(plan, { logger, env });
}
