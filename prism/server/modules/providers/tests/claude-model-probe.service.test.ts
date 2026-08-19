import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import {
  PROBE_DIR_MARKER,
  computeMappingsStale,
  extractActualModel,
  readModelMappings,
  resolveProbeOutcome,
} from '@/modules/providers/list/claude/claude-model-probe.service.js';
import { shouldIgnoreWatchPath } from '@/modules/providers/services/sessions-watcher.service.js';

/**
 * 别名 → 真实模型探测的可单测部分。
 *
 * 探测本体要拉起真实的 claude CLI,单测环境没有;这里钉的是它的三块地基:
 * 从流消息里读真实模型名的解析、缓存文件的读容错、以及 watcher 忽略规则与
 * PROBE_DIR_MARKER 的一致性 —— 最后这条最重要,两边一旦漂移,探测就会往所有人
 * 的侧栏里广播幽灵项目。
 */

describe('extractActualModel', () => {
  test('assistant 消息里的 model 字段是首选', () => {
    assert.equal(
      extractActualModel({ type: 'assistant', message: { model: 'deepseek-v4-flash' } }),
      'deepseek-v4-flash',
    );
  });

  test('result 消息的 modelUsage 键作为兜底', () => {
    assert.equal(
      extractActualModel({ type: 'result', modelUsage: { 'deepseek-v4-flash': { costUSD: 0.05 } } }),
      'deepseek-v4-flash',
    );
  });

  test('与模型无关的消息一律返回 null', () => {
    assert.equal(extractActualModel({ type: 'system', subtype: 'init' }), null);
    assert.equal(extractActualModel({ type: 'assistant', message: {} }), null);
    assert.equal(extractActualModel({ type: 'assistant', message: { model: '' } }), null);
    assert.equal(extractActualModel({ type: 'result', modelUsage: {} }), null);
    assert.equal(extractActualModel(null), null);
    assert.equal(extractActualModel('x'), null);
  });
});

describe('resolveProbeOutcome —— 探测三态归一', () => {
  const checkedAt = '2026-08-17T00:00:00.000Z';
  const base = { timedOut: false, streamError: null, checkedAt, timeoutMs: 60_000 };

  test('读到模型名即成功', () => {
    assert.deepEqual(
      resolveProbeOutcome({ ...base, actualModel: 'glm-5.2' }),
      { actualModel: 'glm-5.2', error: null, checkedAt },
    );
  });

  test('★核心修复:先读到模型名、这一轮随后才抛 max turns —— 仍算成功', () => {
    // 'default' 别名第一轮就发起工具调用,SDK 抛 "Reached maximum number of turns (1)",
    // 但真实模型名此前已从 assistant 消息读到。它不该被这个错误盖成失败。
    assert.deepEqual(
      resolveProbeOutcome({
        ...base,
        actualModel: 'claude-sonnet-5',
        streamError: new Error('Claude Code returned an error result: Reached maximum number of turns (1)'),
      }),
      { actualModel: 'claude-sonnet-5', error: null, checkedAt },
    );
  });

  test('没读到模型名又超时:报超时', () => {
    assert.deepEqual(
      resolveProbeOutcome({ ...base, actualModel: null, timedOut: true }),
      { actualModel: null, error: '超时(60s)', checkedAt },
    );
  });

  test('没读到模型名且流出错(如鉴权失败):报该错误', () => {
    assert.deepEqual(
      resolveProbeOutcome({ ...base, actualModel: null, streamError: new Error('Not logged in') }),
      { actualModel: null, error: 'Not logged in', checkedAt },
    );
  });

  test('既没模型名也没错误:报"响应里没有模型名"', () => {
    const outcome = resolveProbeOutcome({ ...base, actualModel: null });
    assert.equal(outcome.actualModel, null);
    assert.match(outcome.error ?? '', /没有模型名/);
  });
});

describe('computeMappingsStale —— 实测缓存的配置指纹', () => {
  test('旧缓存没有指纹:不判过期(静默,下次实测补上)', () => {
    assert.equal(computeMappingsStale(undefined, 123), false);
  });

  test('指纹与当前 settings mtime 一致:新鲜', () => {
    assert.equal(computeMappingsStale(123, 123), false);
  });

  test('settings.json 改过(mtime 不一致):过期 —— 提示重测、chip 停显真名', () => {
    assert.equal(computeMappingsStale(123, 456), true);
  });
});

describe('缓存读取', () => {
  const previousDataDir = process.env.PRISM_DATA_DIR;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = previousDataDir;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('没有缓存文件时返回空映射,而不是抛错', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'probe-cache-'));
    process.env.PRISM_DATA_DIR = tempDir;

    assert.deepEqual(await readModelMappings(), {});
  });

  test('缓存坏了当作没测过 —— 一个写坏的 JSON 不该把 /models 弹窗打挂', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'probe-cache-'));
    process.env.PRISM_DATA_DIR = tempDir;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(tempDir, 'claude-model-mappings.json'), '{ not json', 'utf8');

    assert.deepEqual(await readModelMappings(), {});
    // 顺带确认测试没把别人的数据目录写坏
    const raw = await readFile(path.join(tempDir, 'claude-model-mappings.json'), 'utf8');
    assert.equal(raw, '{ not json');
  });
});

describe('watcher 忽略规则与探测目录的一致性', () => {
  /**
   * 这条是防漂移的:探测服务用 PROBE_DIR_MARKER 命名 cwd,watcher 的忽略规则
   * 里写的是字面量。任何一边改了名字而另一边没跟上,这条会红。
   */
  test('探测 cwd 的编码目录会被 watcher 忽略', () => {
    const encoded = `-root--prism-${PROBE_DIR_MARKER}`;
    const fileStats = { isDirectory: () => false };

    assert.equal(shouldIgnoreWatchPath(path.join('projects', encoded), { isDirectory: () => true }), true);
    assert.equal(shouldIgnoreWatchPath(path.join('projects', encoded, 's.jsonl'), fileStats), true);
  });
});
