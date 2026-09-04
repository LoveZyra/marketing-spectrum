import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isPrismInternalTranscript, PRISM_INTERNAL_CWD_MARKERS, shouldIgnoreWatchPath,
} from '@/modules/providers/services/sessions-watcher.service.js';
import { isPrismInternalProjectPath } from '@/shared/prism-internal-transcripts.js';

/**
 * Prism 自己跑 CLI 留下的 transcript **不能进项目列表**。
 *
 * 这个坑踩过:模型探测每次都往所有人的侧栏里广播一个幽灵项目,后果是
 * `getSupportedModels()` 至今被禁用。
 *
 * 所以这里钉三件事:
 *   1. 标记表登记了哪些入口;
 *   2. **watcher 与全量同步用的是同一条判据** —— 分成两份就会出现"运行时干净、
 *      重启后全冒出来"这种最难查的不一致;
 *   3. **用户的真实项目一个都不能误伤**。
 */
const encoded = (cwd: string) =>
  `/home/u/.claude/projects/${cwd.replace(/\//g, '-')}/session.jsonl`;

describe('Prism 自产 transcript 的忽略判据', () => {
  it('登记在案的入口', () => {
    expect([...PRISM_INTERNAL_CWD_MARKERS]).toEqual(['prism-model-probe']);
  });

  it('模型探测被认出来', () => {
    const filePath = encoded('/tmp/prism-model-probe-abc');
    expect(isPrismInternalTranscript(filePath)).toBe(true);
    expect(shouldIgnoreWatchPath(filePath)).toBe(true);
    expect(isPrismInternalProjectPath('/tmp/prism-model-probe-abc')).toBe(true);
  });

  it('下划线与连字符两种写法都认(磁盘路径 vs 编码目录名)', () => {
    expect(isPrismInternalProjectPath('/tmp/prism_model_probe_abc')).toBe(true);
    expect(isPrismInternalTranscript(encoded('/tmp/prism_model_probe_abc'))).toBe(true);
  });

  it('**用户的真实项目一个都不能误伤**', () => {
    for (const cwd of [
      '/home/u/work/marketing',
      '/srv/my.app',
      '/home/u/projects/probe-notes',
      '/home/u/prism/skills',
    ]) {
      const filePath = encoded(cwd);
      expect(isPrismInternalTranscript(filePath), cwd).toBe(false);
      expect(shouldIgnoreWatchPath(filePath), cwd).toBe(false);
      expect(isPrismInternalProjectPath(cwd), cwd).toBe(false);
    }
  });

  it('watcher 与全量同步同源 —— 不是各写一份', () => {
    const filePath = encoded('/tmp/prism-model-probe-x');
    expect(shouldIgnoreWatchPath(filePath)).toBe(isPrismInternalTranscript(filePath));
  });

  it('子代理 transcript 仍然照旧忽略(别把老规矩改坏)', () => {
    expect(shouldIgnoreWatchPath('/home/u/.claude/projects/p/sess/subagents/a.jsonl')).toBe(true);
  });

  it('非 .jsonl 文件仍然忽略,目录仍然放行', () => {
    expect(shouldIgnoreWatchPath('/home/u/.claude/projects/p/x.txt', { isDirectory: () => false })).toBe(true);
    expect(shouldIgnoreWatchPath('/home/u/.claude/projects/p', { isDirectory: () => true })).toBe(false);
  });

  /**
   * 判据必须住在**谁也不依赖**的叶子模块里。
   *
   * 第一版把它放在 watcher 里,provider 反向 import —— watcher → 同步服务 →
   * provider.registry → provider 本身,绕成一圈:provider 的类字段初始化时
   * `ClaudeSessionSynchronizer` 还是 undefined,`is not a constructor`,
   * **整个 provider 层起不来**。类型检查看不出来,只有跑起来才炸。
   */
  it('判据模块是叶子 —— 不许引任何项目内模块(否则又绕出一圈循环依赖)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../shared/prism-internal-transcripts.ts', import.meta.url)),
      'utf8',
    );
    const imports = [...source.matchAll(/^import .*?from '([^']+)';/gm)].map((match) => match[1]);
    expect(imports).toEqual(['node:path']);
  });
});
