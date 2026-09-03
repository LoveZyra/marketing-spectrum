import { describe, expect, it } from 'vitest';

import { collectSessionWritePaths } from '../session-outputs.routes.js';

/**
 * ei:会话产出读取通道的**放行判据**。
 *
 * 这条路由不接受任意路径 —— 只有"这段会话自己成功写出来过"的文件才放行。
 * 判据必须与前端产出列表同源(Write + 结果帧存在且非错),否则会出现
 * "列表里有、点开 403" 或者反过来"能读到没列出来的东西"。
 */
describe('collectSessionWritePaths', () => {
  const use = (toolId: string, filePath: string) => ({
    kind: 'tool_use', toolName: 'Write', toolId, toolInput: { file_path: filePath },
  });
  const result = (toolId: string, isError = false) => ({ kind: 'tool_result', toolId, isError });

  it('只收成功的 Write;失败与没有结果帧的都不放行', () => {
    const allowed = collectSessionWritePaths([
      use('t1', '/home/u/proj/a.md'), result('t1'),
      use('t2', '/home/u/.claude/plans/plan.md'), result('t2'),
      use('t3', '/home/u/proj/failed.md'), result('t3', true),
      use('t4', '/home/u/proj/still-running.md'), // 没有结果帧
    ]);
    expect([...allowed].sort()).toEqual(['/home/u/.claude/plans/plan.md', '/home/u/proj/a.md']);
  });

  it('路径按 resolve 归一 —— `..` / 多余分隔符不能绕过比对', () => {
    const allowed = collectSessionWritePaths([use('t1', '/home/u/proj/./sub/../a.md'), result('t1')]);
    expect(allowed.has('/home/u/proj/a.md')).toBe(true);
    expect(allowed.has('/home/u/proj/./sub/../a.md')).toBe(false);
  });

  it('非 Write 工具不进集合(读过 ≠ 写过,读过的文件不由这条通道放行)', () => {
    const allowed = collectSessionWritePaths([
      { kind: 'tool_use', toolName: 'Read', toolId: 't1', toolInput: { file_path: '/etc/passwd' } },
      result('t1'),
      { kind: 'tool_use', toolName: 'Bash', toolId: 't2', toolInput: { command: 'cat /etc/shadow' } },
      result('t2'),
    ]);
    expect(allowed.size).toBe(0);
  });

  it('子代理里的 Write 同样是本会话的产出', () => {
    const allowed = collectSessionWritePaths([
      {
        kind: 'tool_use', toolName: 'Task', toolId: 'p1', toolInput: {},
        subagentTools: [
          { toolName: 'Write', toolId: 'c1', toolInput: { file_path: '/home/u/proj/sub.md' }, toolResult: { isError: false } },
          { toolName: 'Write', toolId: 'c2', toolInput: { file_path: '/home/u/proj/bad.md' }, toolResult: { isError: true } },
        ],
      },
    ]);
    expect([...allowed]).toEqual(['/home/u/proj/sub.md']);
  });

  it('toolInput 是 JSON 字符串时照样解析(历史帧里两种形态都有)', () => {
    const allowed = collectSessionWritePaths([
      { kind: 'tool_use', toolName: 'Write', toolId: 't1', toolInput: JSON.stringify({ file_path: '/home/u/proj/s.md' }) },
      result('t1'),
    ]);
    expect(allowed.has('/home/u/proj/s.md')).toBe(true);
  });

  it('脏数据不抛:空路径 / 缺字段 / 非对象一律跳过', () => {
    expect(collectSessionWritePaths([
      null, 'nope', 42,
      { kind: 'tool_use', toolName: 'Write', toolId: 't1', toolInput: { file_path: '   ' } },
      result('t1'),
    ]).size).toBe(0);
  });
});
