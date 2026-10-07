import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, test } from 'vitest';

/**
 * prism.sh 的日志轮转:启动前的 rotate_logs 与运行期的 rotate_log_by_size。
 *
 * PRISM_LOG_KEEP 是保留几代旧日志;0 = 不保留,每次启动截断,运行期超过阈值也直接截断。
 * 只把这几个函数从脚本里切出来,在临时目录里用 bash 跑,不起服务。
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const script = fs.readFileSync(path.join(repoRoot, 'prism.sh'), 'utf8');

const fnSource = (name: string): string => {
  const start = script.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `prism.sh 里找不到 ${name}()`);
  const end = script.indexOf('\n}\n', start);
  return script.slice(start + 1, end + 3);
};

const FUNCTIONS = ['sup_log', 'rotate_logs', 'shift_old_logs', 'rotate_log_by_size'].map(fnSource).join('\n');

let dir = '';
const logFile = () => path.join(dir, 'prism.log');
const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);
const readLog = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const exists = (name: string) => fs.existsSync(path.join(dir, name));

/** 按 do_start / 守护循环的调用方式跑一段。 */
const run = (action: string, vars: { keep: string; rotateMb?: string }) => {
  execFileSync('bash', ['-c', [
    'set -u',
    `LOG_FILE='${logFile()}'`,
    `LOG_KEEP='${vars.keep}'`,
    `LOG_ROTATE_MB='${vars.rotateMb ?? '50'}'`,
    FUNCTIONS,
    action,
  ].join('\n')], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
};
const START = 'rotate_logs\n: >> "$LOG_FILE"';
const OVER_ONE_MB = 'x'.repeat(1024 * 1024 + 10);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'prism-log-rotation-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PRISM_LOG_KEEP=0:不留旧日志', () => {
  test('启动时截断 prism.log,不生成 prism.log.1', () => {
    write('prism.log', 'last run\n');
    run(START, { keep: '0' });
    assert.equal(readLog('prism.log'), '');
    assert.equal(exists('prism.log.1'), false);
  });

  test('运行期超过阈值也截断,不会无限增长;不生成 prism.log.1', () => {
    write('prism.log', OVER_ONE_MB);
    run('rotate_log_by_size', { keep: '0', rotateMb: '1' });
    assert.ok(fs.statSync(logFile()).size < 1024, '超过阈值之后应当被截断');
    assert.match(readLog('prism.log'), /\[supervisor\] .*截断/);
    assert.equal(exists('prism.log.1'), false);
  });

  test('没到阈值、或 PRISM_LOG_ROTATE_MB=0 时不动', () => {
    write('prism.log', 'small\n');
    run('rotate_log_by_size', { keep: '0', rotateMb: '1' });
    assert.equal(readLog('prism.log'), 'small\n');
    write('prism.log', OVER_ONE_MB);
    run('rotate_log_by_size', { keep: '0', rotateMb: '0' });
    assert.equal(fs.statSync(logFile()).size, OVER_ONE_MB.length);
  });
});

describe('PRISM_LOG_KEEP=N:保留 N 代', () => {
  test('启动时轮转:旧的依次后移,超出 N 的丢掉,prism.log 重新开始', () => {
    write('prism.log', 'c');
    write('prism.log.1', 'b');
    write('prism.log.2', 'a');
    run(START, { keep: '2' });
    assert.equal(readLog('prism.log'), '');
    assert.equal(readLog('prism.log.1'), 'c');
    assert.equal(readLog('prism.log.2'), 'b');
    assert.equal(exists('prism.log.3'), false);
  });

  test('运行期超过阈值:拷到 prism.log.1 再截断', () => {
    write('prism.log', OVER_ONE_MB);
    write('prism.log.1', 'older');
    run('rotate_log_by_size', { keep: '2', rotateMb: '1' });
    assert.equal(fs.statSync(path.join(dir, 'prism.log.1')).size, OVER_ONE_MB.length);
    assert.equal(readLog('prism.log.2'), 'older');
    assert.ok(fs.statSync(logFile()).size < 1024);
    assert.match(readLog('prism.log'), /\[supervisor\] prism\.log 超过 1MB,已轮转到 prism\.log\.1/);
  });
});
