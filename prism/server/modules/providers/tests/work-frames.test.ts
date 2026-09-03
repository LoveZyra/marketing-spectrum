import { describe, expect, it } from 'vitest';

import { collectWorkFrames } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

const toolUse = (toolName: string, toolInput: unknown, extra: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    id: `${toolName}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'tool_use',
    provider: 'claude',
    timestamp: '2026-08-31T10:00:00.000Z',
    toolName,
    toolInput,
    ...extra,
  }) as NormalizedMessage;

describe('collectWorkFrames', () => {
  it('滤出四种工作工具帧,tool_result 按 toolId 配对(含子代理 child 行)', () => {
    const messages: NormalizedMessage[] = [
      { kind: 'text', provider: 'claude', content: '开工', timestamp: 't' } as NormalizedMessage,
      toolUse('TaskCreate', { subject: '甲' }, { toolId: 'tc1' }),
      { kind: 'tool_result', provider: 'claude', toolId: 'tc1', content: 'Task #1 created successfully: 甲' } as NormalizedMessage,
      toolUse('Bash', { command: 'ls' }, { toolId: 'b1' }),
      // 子代理内部的 Write(带 parentToolUseId)一样收
      toolUse('Write', { file_path: '/p/子代理产物.md', content: 'x' }, { toolId: 'w1', parentToolUseId: 'container1' } as Partial<NormalizedMessage>),
      { kind: 'tool_result', provider: 'claude', toolId: 'w1', content: 'ok', parentToolUseId: 'container1' } as NormalizedMessage,
    ];
    const { frames } = collectWorkFrames(messages);
    expect(frames.map((frame) => frame.toolName)).toEqual(['TaskCreate', 'Write']);
    expect(frames[0].resultContent).toBe('Task #1 created successfully: 甲');
    expect(frames[1].resultContent).toBe('ok');
    expect(frames[1].resultIsError).toBe(false);
  });

  it('优先用消息自带的 toolResult(transcript 回放路径);无结果 → resultContent null', () => {
    const { frames } = collectWorkFrames([
      toolUse('Write', { file_path: '/p/a.md' }, {
        toolId: 'w2',
        toolResult: { content: 'attached-result', isError: false },
      }),
      toolUse('Write', { file_path: '/p/待批.md' }, { toolId: 'w3' }),
    ]);
    expect(frames[0].resultContent).toBe('attached-result');
    expect(frames[1].resultContent).toBeNull();
    expect(frames[1].resultIsError).toBe(false);
  });

  it('isError 结果如实带出', () => {
    const { frames } = collectWorkFrames([
      toolUse('Write', { file_path: '/p/拒.md' }, { toolId: 'w4' }),
      { kind: 'tool_result', provider: 'claude', toolId: 'w4', content: 'denied', isError: true } as NormalizedMessage,
    ]);
    expect(frames[0].resultIsError).toBe(true);
  });

  it('changed_files 行展开为逐文件 changed_file 帧:相对路径拼 cwd,只算新增', () => {
    const { frames } = collectWorkFrames([
      {
        id: 'cf1',
        kind: 'changed_files',
        provider: 'claude',
        timestamp: 't',
        cwd: '/home/ubuntu/demo/',
        files: [
          { path: 'attachments/random_content.md', status: 'added', untracked: true },
          { path: 'users.csv', untracked: true },
          { path: '旧文件.md', status: 'modified' },
          { path: '', status: 'added' },
        ],
      } as unknown as NormalizedMessage,
    ]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      kind: 'changed_file',
      toolName: 'Write',
      toolInput: { file_path: '/home/ubuntu/demo/attachments/random_content.md' },
      resultContent: 'checkpoint',
      resultIsError: false,
    });
    expect((frames[1].toolInput as { file_path: string }).file_path).toBe('/home/ubuntu/demo/users.csv');
    expect(frames[1].id).toBe('cf1::users.csv');
  });

  it('changed_files 无 cwd 时保留相对路径(下载仍可用)', () => {
    const { frames } = collectWorkFrames([
      { kind: 'changed_files', provider: 'claude', files: [{ path: 'a.md', status: 'added' }] } as unknown as NormalizedMessage,
    ]);
    expect((frames[0].toolInput as { file_path: string }).file_path).toBe('a.md');
  });

  it('dt:files_reverted 撤销此前的产出帧并进 revertedPaths;回滚后重写则恢复', () => {
    const changedFrame = (id: string, rel: string): NormalizedMessage => ({
      id, kind: 'changed_files', provider: 'claude', timestamp: 't',
      cwd: '/p', files: [{ path: rel, status: 'added', untracked: true }],
    } as unknown as NormalizedMessage);
    const revertFrame = (rel: string): NormalizedMessage => ({
      id: `rv-${rel}`, kind: 'files_reverted', provider: 'claude', timestamp: 't',
      cwd: '/p', paths: [rel],
    } as unknown as NormalizedMessage);

    // 写 → 回滚:帧被删,path 进 revertedPaths
    const rolledBack = collectWorkFrames([changedFrame('c1', 'a.md'), revertFrame('a.md')]);
    expect(rolledBack.frames).toHaveLength(0);
    expect(rolledBack.revertedPaths).toEqual(['/p/a.md']);

    // 写 → 回滚 → 重写(changed_files 路):恢复,集合清空
    const rewrittenViaCheckpoint = collectWorkFrames([
      changedFrame('c1', 'a.md'), revertFrame('a.md'), changedFrame('c2', 'a.md'),
    ]);
    expect(rewrittenViaCheckpoint.frames).toHaveLength(1);
    expect(rewrittenViaCheckpoint.revertedPaths).toEqual([]);

    // 写 → 回滚 → 重写(Write 工具路,成功结果):同样恢复
    const rewrittenViaWrite = collectWorkFrames([
      changedFrame('c1', 'a.md'), revertFrame('a.md'),
      toolUse('Write', { file_path: '/p/a.md' }, { toolId: 'wx', toolResult: { content: 'ok', isError: false } }),
    ]);
    expect(rewrittenViaWrite.revertedPaths).toEqual([]);

    // 未收录过的 path 的回滚是空操作,但仍进集合(窗口里的旧 Write 帧要靠它减掉)
    const unknownPath = collectWorkFrames([revertFrame('never_seen.md')]);
    expect(unknownPath.frames).toHaveLength(0);
    expect(unknownPath.revertedPaths).toEqual(['/p/never_seen.md']);
  });
});
