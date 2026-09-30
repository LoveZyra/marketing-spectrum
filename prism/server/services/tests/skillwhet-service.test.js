import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { describe, test } from 'vitest';

import { createSkillWhetSupervisor, identify, resolveSkillWhetConfig, skillWhetEnabled } from '../skillwhet-service.js';

/**
 * gy:技能优化的进程托管。与 ma-service 同一形状,钉三条:不配就什么都不做;
 * 配置解析拒绝非回环目标与"外部 serve 却没口令";子进程退出走退避重启、stop 收干净。
 */
const quiet = { log() {}, warn() {}, error() {} };

describe('resolveSkillWhetConfig', () => {
  test('不配 ENABLE:整层关闭', () => {
    assert.equal(skillWhetEnabled({}), false);
    assert.deepEqual(resolveSkillWhetConfig({}, quiet), { enabled: false });
  });

  test('默认目标 127.0.0.1:8093;AUTOSTART 时口令可生成', () => {
    const cfg = resolveSkillWhetConfig({ PRISM_SKILLWHET_ENABLE: '1', PRISM_SKILLWHET_AUTOSTART: '1', HOME: '/home/x' }, quiet);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.port, 8093);
    assert.equal(cfg.baseUrl, 'http://127.0.0.1:8093');
    assert.equal(cfg.generatedToken, true);
    assert.ok(cfg.token.length >= 32);
    assert.equal(cfg.python, 'python3');
  });

  test('非回环目标拒绝;外部 serve 没口令拒绝;配了口令就用它', () => {
    const errors = [];
    const logger = { ...quiet, error: (m) => errors.push(m) };
    assert.equal(resolveSkillWhetConfig({ PRISM_SKILLWHET_ENABLE: '1', PRISM_SKILLWHET_TARGET: 'http://10.0.0.5:8093', PRISM_SKILLWHET_TOKEN: 't' }, logger).enabled, false);
    assert.match(errors[0], /回环/);
    assert.equal(resolveSkillWhetConfig({ PRISM_SKILLWHET_ENABLE: '1' }, logger).enabled, false);
    assert.match(errors[1], /PRISM_SKILLWHET_TOKEN/);
    const cfg = resolveSkillWhetConfig({ PRISM_SKILLWHET_ENABLE: '1', PRISM_SKILLWHET_TOKEN: 'abc', PRISM_SKILLWHET_TARGET: '127.0.0.1:9001', PRISM_SKILLWHET_PYTHON: '/opt/py311/bin/python', PRISM_SKILLWHET_HOME: '/data/sw' }, logger);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.autostart, false);
    assert.equal(cfg.token, 'abc');
    assert.equal(cfg.generatedToken, false);
    assert.equal(cfg.port, 9001);
    assert.equal(cfg.python, '/opt/py311/bin/python');
    assert.equal(cfg.home, '/data/sw');
  });
});

const fakeProc = () => {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.stdout = null;
  proc.stderr = null;
  proc.kill = () => { proc.emit('exit', null, 'SIGTERM'); };
  return proc;
};

describe('createSkillWhetSupervisor', () => {
  const config = { host: '127.0.0.1', port: 8093, label: '127.0.0.1:8093', home: '/tmp/swhome', python: 'python3', token: 't', generatedToken: false };

  test('端口上已有人应答 → external,不拉起', async () => {
    let spawned = 0;
    const sup = createSkillWhetSupervisor(config, {
      logger: quiet, spawnFn: () => { spawned += 1; return fakeProc(); },
      probe: async () => ({ alive: true, status: 200 }), sleep: async () => {},
    });
    assert.equal(await sup.start(), 'external');
    assert.equal(spawned, 0);
  });

  test('gz · 端口上应答的不是 skillwhet(别的 HTTP 服务)→ failed,不拉起,日志指路改 TARGET', async () => {
    let spawned = 0;
    const errors = [];
    const sup = createSkillWhetSupervisor(config, {
      logger: { ...quiet, error: (m) => errors.push(m) }, spawnFn: () => { spawned += 1; return fakeProc(); },
      probe: async () => ({ alive: true, status: 200, skillwhet: false }), sleep: async () => {},
    });
    assert.equal(await sup.start(), 'failed');
    assert.equal(spawned, 0);
    assert.match(errors.join('\n'), /不是 skillwhet/);
    assert.match(errors.join('\n'), /PRISM_SKILLWHET_TARGET/);
  });

  test('gz · identify:只认 { ok:true, version, home } 的 JSON', () => {
    assert.deepEqual(identify(JSON.stringify({ ok: true, version: '0.3.0', home: '/x', python: '3.12' })), { skillwhet: true, version: '0.3.0' });
    assert.deepEqual(identify(JSON.stringify({ status: 'ok' })), { skillwhet: false });
    // hl:serve 真实的 /healthz 带 { ok, data } 信封
    assert.deepEqual(identify(JSON.stringify({ ok: true, data: { ok: true, version: '0.5.2', home: '/x' } })), { skillwhet: true, version: '0.5.2' });
    assert.deepEqual(identify(JSON.stringify({ ok: true, data: { status: 'ok' } })), { skillwhet: false });
    assert.deepEqual(identify('<html>ok</html>'), { skillwhet: false });
    assert.deepEqual(identify(''), { skillwhet: false });
  });

  test('拉起后 healthz 应答 → running;子进程参数带 serve / host / port / home,环境带口令与 TMPDIR', async () => {
    let seen = null;
    let probes = 0;
    const sup = createSkillWhetSupervisor(config, {
      logger: quiet,
      spawnFn: (cmd, args, opts) => { seen = { cmd, args, opts }; return fakeProc(); },
      env: { PATH: '/usr/bin', HOME: '/home/x', JWT_SECRET: 'nope', DATABASE_PATH: '/nope.db', ANTHROPIC_AUTH_TOKEN: 'ok' },
      probe: async () => ({ alive: probes++ > 0, status: 200 }),
      sleep: async () => {},
    });
    assert.equal(await sup.start(), 'running');
    assert.equal(seen.cmd, 'python3');
    assert.deepEqual(seen.args, ['-m', 'skillwhet', 'serve', '--host', '127.0.0.1', '--port', '8093', '--home', '/tmp/swhome']);
    assert.equal(seen.opts.env.SKILLWHET_TOKEN, 't');
    assert.match(seen.opts.env.TMPDIR, /prism-skillwhet$/);
    // gz 审计 #15:Prism 的密钥 / DB 路径不进子进程环境
    assert.equal(seen.opts.env.JWT_SECRET, undefined);
    assert.equal(seen.opts.env.DATABASE_PATH, undefined);
    assert.equal(seen.opts.env.ANTHROPIC_AUTH_TOKEN, 'ok');
    assert.equal(seen.opts.env.HOME, '/home/x');
    assert.equal(sup.pid, 4242);
    await sup.stop();
    assert.equal(sup.state, 'stopped');
  });

  test('退出码 2 立刻退出 → failed,不重启', async () => {
    let spawned = 0;
    let t = 0;
    const sup = createSkillWhetSupervisor(config, {
      logger: quiet,
      spawnFn: () => { spawned += 1; const p = fakeProc(); setTimeout(() => p.emit('exit', 2, null), 0); return p; },
      probe: async () => ({ alive: false }), sleep: async () => { await new Promise((r) => setTimeout(r, 1)); }, now: () => (t += 10),
      healthWaitMs: 100, healthPollMs: 1,
    });
    assert.equal(await sup.start(), 'failed');
    assert.equal(spawned, 1);
  });
});
