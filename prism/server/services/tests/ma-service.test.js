/**
 * ma-service 的回归。重点不在"能不能起进程"(那是 spawn 的事),而在几条
 * **只在部署当天才会暴露、暴露时又看不出病因**的规则:
 *   · 子进程的监听地址必须从 PRISM_MA_API_TARGET 反推,不能被环境里残留的
 *     MA_API_PORT 带偏 —— 那会造成反代 502,而两边日志都显示"正常"。
 *   · 没有 MA_API_KEY 不许自启:自启意味着接口经 Prism 8080 对外。
 *   · MA_API_KEY 不许等于 API_KEY:后者是 Claude Code CLI 的模型密钥。
 *   · 体检不过(exit 2)不许重启:配置问题重启一万次也一样,只会刷屏。
 * 所以 spawn / probe / sleep 全部注入,测试里不碰真 Python。
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createMaServiceSupervisor, planAutostart } from '../ma-service.js';

const SCRIPT = '/srv/ma/ma_api_c.py';
const baseEnv = {
  PRISM_MA_API_AUTOSTART: SCRIPT,
  PRISM_MA_API_TARGET: '127.0.0.1:8092',
  MA_API_KEY: 'ma-key-abc',
};
const existsYes = () => true;

function plan(env, exists = existsYes) {
  return planAutostart(env, { exists });
}

// --------------------------------------------------------------------- planAutostart

describe('planAutostart', () => {
  it('不配 AUTOSTART 就是禁用,而且一个字都不打', () => {
    const r = plan({});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('disabled');
    expect(r.silent).toBe(true);
    expect(r.message).toBe('');
  });

  it('配了 AUTOSTART 却没配 TARGET → 拒绝(拉起来也没有入口)', () => {
    const r = plan({ ...baseEnv, PRISM_MA_API_TARGET: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_target');
    expect(r.silent).toBeUndefined();          // 这个必须吵
  });

  it('TARGET 不是回环 → 拒绝', () => {
    const r = plan({ ...baseEnv, PRISM_MA_API_TARGET: '10.195.43.111:8092' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('target_not_loopback');
  });

  it('相对路径 → 拒绝(cwd 会跟着启动方式变)', () => {
    const r = plan({ ...baseEnv, PRISM_MA_API_AUTOSTART: './ma_api_c.py' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_absolute');
  });

  it('文件不存在 → 拒绝,并把路径原样回显', () => {
    const r = plan(baseEnv, () => false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
    expect(r.message).toContain(SCRIPT);
  });

  it('没有 MA_API_KEY → 拒绝自启', () => {
    const r = plan({ ...baseEnv, MA_API_KEY: '' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_key');
  });

  it('显式 PRISM_MA_API_ALLOW_NO_KEY=1 才放行无口令', () => {
    const r = plan({ ...baseEnv, MA_API_KEY: '', PRISM_MA_API_ALLOW_NO_KEY: '1' });
    expect(r.ok).toBe(true);
  });

  it('MA_API_KEY 等于 API_KEY → 拒绝(那是模型密钥,子进程会继承)', () => {
    const r = plan({ ...baseEnv, API_KEY: 'ma-key-abc' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('key_reuse');
  });

  it('两个 key 不同则互不干扰', () => {
    const r = plan({ ...baseEnv, API_KEY: 'sk-llm-completely-different' });
    expect(r.ok).toBe(true);
  });

  it('正常配置:cwd 取脚本所在目录,host/port 来自 TARGET', () => {
    const r = plan({ ...baseEnv, PRISM_MA_API_TARGET: 'http://localhost:8093' });
    expect(r).toMatchObject({
      ok: true, script: SCRIPT, cwd: '/srv/ma', python: 'python3',
      host: 'localhost', port: 8093,
    });
  });

  it('PRISM_MA_API_PYTHON 可以换解释器', () => {
    const r = plan({ ...baseEnv, PRISM_MA_API_PYTHON: '/opt/py311/bin/python' });
    expect(r.python).toBe('/opt/py311/bin/python');
  });
});

// --------------------------------------------------------------------- supervisor

/** 一个够用的假子进程:有 stdout/stderr 两条流,exit 由测试自己触发。 */
function fakeChild(pid = 4242) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn((sig) => { proc.killedWith = sig; return true; });
  proc.die = (code, signal = null) => proc.emit('exit', code, signal);
  return proc;
}

/** 让出一轮事件循环。start() 是 async 的,spawn 发生在第一个 await 之后 ——
 *  不等这一下就 emit('exit'),事件会打在监听器挂上之前,测出来的是假绿/假红。 */
const tick = () => new Promise((r) => setTimeout(r, 15));

function quietLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** probe 先说"没人",被叫到第 aliveAfter 次开始说"活了"。 */
function stagedProbe(aliveAfter) {
  let n = 0;
  return vi.fn(async () => (++n >= aliveAfter ? { alive: true, status: 200 } : { alive: false }));
}

const OK_PLAN = { script: SCRIPT, cwd: '/srv/ma', python: 'python3', host: '127.0.0.1', port: 8092, label: '127.0.0.1:8092' };

function makeSup(overrides = {}) {
  const logger = overrides.logger || quietLogger();
  const child = overrides.child || fakeChild();
  const spawnFn = overrides.spawnFn || vi.fn(() => child);
  const sup = createMaServiceSupervisor(OK_PLAN, {
    logger,
    env: overrides.env || { PATH: '/usr/bin' },
    spawnFn,
    // 第 1 次是 start() 的预检,必须报「没人」,不然测试全走 external 分支;
    // 第 2 次(拉起之后的轮询)才报活。
    probe: overrides.probe || stagedProbe(2),
    sleep: overrides.sleep || ((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))),
    healthPollMs: 1,
    healthWaitMs: overrides.healthWaitMs ?? 200,
    maxRestarts: overrides.maxRestarts ?? 5,
    termGraceMs: overrides.termGraceMs ?? 50,
  });
  return { sup, spawnFn, child, logger };
}

describe('createMaServiceSupervisor', () => {
  it('端口上已经有人应答 → 不重复拉起', async () => {
    const { sup, spawnFn, logger } = makeSup({ probe: async () => ({ alive: true, status: 200 }) });
    expect(await sup.start()).toBe('external');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(logger.log.mock.calls.flat().join('\n')).toContain('不重复拉起');
  });

  it('正常拉起 → running,pid 可见', async () => {
    const { sup, spawnFn } = makeSup({ probe: stagedProbe(2) });
    expect(await sup.start()).toBe('running');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(sup.pid).toBe(4242);
  });

  it('子进程的 MA_API_HOST/PORT 来自 TARGET,压过环境里残留的值', async () => {
    // 这是这个模块存在的首要理由:环境里躺着一个上一轮部署留下的 MA_API_PORT=8091,
    // 反代却指着 8092。不覆盖的话服务会乖乖听在 8091,然后反代一路 502。
    const { sup, spawnFn } = makeSup({
      env: { MA_API_PORT: '8091', MA_API_HOST: '0.0.0.0', MA_API_KEY: 'k' },
    });
    await sup.start();
    const passedEnv = spawnFn.mock.calls[0][2].env;
    expect(passedEnv.MA_API_PORT).toBe('8092');
    expect(passedEnv.MA_API_HOST).toBe('127.0.0.1');
    expect(passedEnv.MA_API_KEY).toBe('k');       // 其余环境原样继承
  });

  it('cwd 是脚本所在目录', async () => {
    const { sup, spawnFn } = makeSup();
    await sup.start();
    expect(spawnFn.mock.calls[0][2].cwd).toBe('/srv/ma');
    expect(spawnFn.mock.calls[0][1]).toEqual([SCRIPT]);
  });

  it('体检不过(立刻 exit 2)→ failed,而且不重启', async () => {
    const child = fakeChild();
    const { sup, spawnFn, logger } = makeSup({ child, probe: async () => ({ alive: false }), healthWaitMs: 500 });
    const p = sup.start();
    await tick();                                  // 先让 start() 走到 spawn 之后再让它死
    child.die(2);
    await p;
    expect(sup.state).toBe('failed');
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls.flat().join('\n')).toContain('环境体检没过');
  });

  it('普通崩溃且重启次数已用尽 → failed', async () => {
    const child = fakeChild();
    const { sup, logger } = makeSup({
      child, probe: async () => ({ alive: false }), healthWaitMs: 500, maxRestarts: 0,
    });
    const p = sup.start();
    await tick();
    child.die(1);
    await p;
    expect(sup.state).toBe('failed');
    expect(logger.error.mock.calls.flat().join('\n')).toContain('放弃');
  });

  it('崩溃后会按退避重启', async () => {
    const first = fakeChild(1);
    const second = fakeChild(2);
    let n = 0;
    const spawnFn = vi.fn(() => (++n === 1 ? first : second));
    const { sup } = makeSup({
      spawnFn, probe: async () => ({ alive: false }), healthWaitMs: 300, maxRestarts: 2,
    });
    const p = sup.start();
    await tick();
    first.die(1);                                  // 非 2,算偶发崩溃
    await p;
    await new Promise((r) => setTimeout(r, 1400));  // 第一次退避是 1000ms
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('stop() 先 SIGTERM;进程不退再 SIGKILL', async () => {
    const child = fakeChild();
    const { sup } = makeSup({ child, termGraceMs: 60 });
    await sup.start();
    await sup.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(sup.state).toBe('stopped');
  });

  it('stop() 时进程已经退了就不升级到 SIGKILL', async () => {
    const child = fakeChild();
    const { sup } = makeSup({ child, termGraceMs: 300 });
    await sup.start();
    child.kill = vi.fn(() => { setTimeout(() => child.die(null, 'SIGTERM'), 5); return true; });
    await sup.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop() 之后子进程退出不会触发重启', async () => {
    const child = fakeChild();
    const { sup, spawnFn } = makeSup({ child, termGraceMs: 20 });
    await sup.start();
    await sup.stop();
    child.die(1);
    await new Promise((r) => setTimeout(r, 1300));
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('子进程输出按行并进 Prism 日志,不截断半行', async () => {
    const child = fakeChild();
    const { sup, logger } = makeSup({ child });
    await sup.start();
    child.stdout.write('方案 C 服务启动,监听 http://127.0.0.1');
    child.stdout.write(':8092\n第二行\n');
    await new Promise((r) => setTimeout(r, 20));
    const lines = logger.log.mock.calls.flat().join('\n');
    expect(lines).toContain('| 方案 C 服务启动,监听 http://127.0.0.1:8092');
    expect(lines).toContain('| 第二行');
  });

  it('start() 幂等:重复调用不会拉起第二个进程', async () => {
    const { sup, spawnFn } = makeSup();
    await sup.start();
    await sup.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('healthz 一直不应答也不杀进程,只降级成告警(启动慢是常态)', async () => {
    const { sup, logger } = makeSup({ probe: async () => ({ alive: false }), healthWaitMs: 30 });
    expect(await sup.start()).toBe('running');
    expect(logger.warn.mock.calls.flat().join('\n')).toContain('502');
  });
});
