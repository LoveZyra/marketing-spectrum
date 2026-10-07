import { describe, expect, it } from 'vitest';

import { collectWorkFrames, MAX_FRAME_RESULT_CHARS } from '@/modules/providers/services/sessions.service.js';
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

  it('files_reverted 撤销此前的产出帧并进 revertedPaths;回滚后重写则恢复', () => {
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

describe('工作帧带用户回合号(进度时间轴分辨当前轮)', () => {
  it('每帧记下自己落在第几个用户回合;插话不算新回合;第一条用户消息之前的帧不带', () => {
    const user = (content: string, extra: Record<string, unknown> = {}) =>
      ({ kind: 'text', role: 'user', provider: 'claude', content, timestamp: 't', ...extra }) as NormalizedMessage;
    const { frames } = collectWorkFrames([
      toolUse('TaskCreate', { subject: '早' }, { toolId: 'x0' }),
      user('第一轮'),
      toolUse('TaskCreate', { subject: '甲' }, { toolId: 'a1' }),
      user('插话', { interjection: true }),
      toolUse('TaskUpdate', { taskId: '1', status: 'in_progress' }, { toolId: 'a2' }),
      user('第二轮'),
      toolUse('TaskCreate', { subject: '乙' }, { toolId: 'b1' }),
    ]);
    expect(frames.map((frame) => frame.turn)).toEqual([undefined, 1, 1, 2]);
  });
});

/**
 * 下发的帧只带前端折叠会读的字段(taskChecklist / sessionOutputs,见 src/components/chat/utils/workFrames.ts):
 * Write 的正文、Task* 的 description 之类一概不读,却是载荷的大头。读得到的字段一个都不能少。
 */
describe('帧的字段收窄', () => {
  const bigContent = 'export const value = 42;\n'.repeat(4000);

  it('Write 只留 file_path,不带正文;结果只留一段预览并标记截过', () => {
    const longResult = `The file /p/a.ts has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${'     1\tline\n'.repeat(200)}`;
    const { frames } = collectWorkFrames([
      toolUse('Write', { file_path: '/p/a.ts', content: bigContent }, { toolId: 'w1', toolResult: { content: longResult, isError: false } }),
    ]);
    expect(frames[0].toolInput).toEqual({ file_path: '/p/a.ts' });
    expect(frames[0].inputTrimmed).toBe(true);
    expect(frames[0].resultContent).toBe(longResult.slice(0, MAX_FRAME_RESULT_CHARS));
    expect(frames[0].resultTrimmed).toBe(true);
    expect(frames[0].resultIsError).toBe(false);
    expect(JSON.stringify(frames).includes('export const value')).toBe(false);
  });

  it('失败的 Write 照样带 isError,结果在不在的判据不变', () => {
    const { frames } = collectWorkFrames([
      toolUse('Write', { file_path: '/p/拒.md', content: bigContent }, { toolId: 'w2' }),
      { kind: 'tool_result', provider: 'claude', toolId: 'w2', content: 'EACCES', isError: true } as NormalizedMessage,
      toolUse('Write', { file_path: '/p/在途.md', content: bigContent }, { toolId: 'w3' }),
    ]);
    expect(frames[0]).toMatchObject({ toolInput: { file_path: '/p/拒.md' }, resultContent: 'EACCES', resultIsError: true });
    expect(frames[1]).toMatchObject({ toolInput: { file_path: '/p/在途.md' }, resultContent: null, resultIsError: false });
  });

  it('TaskCreate 只留 subject;结果(任务号与主题)整句保留', () => {
    const subject = '把订单导出改成按天分片';
    const { frames } = collectWorkFrames([
      toolUse('TaskCreate', { subject, description: '详细说明'.repeat(2000), activeForm: '正在改导出' }, {
        toolId: 'tc1',
        toolResult: { content: `Task #12 created successfully: ${subject}`, isError: false },
      }),
    ]);
    expect(frames[0].toolInput).toEqual({ subject });
    expect(frames[0].inputTrimmed).toBe(true);
    expect(frames[0].resultContent).toBe(`Task #12 created successfully: ${subject}`);
    expect(frames[0].resultTrimmed).toBeUndefined();
  });

  it('TaskCreate 的结果再长也不截:任务名在结果里,截了清单上的名字就变了', () => {
    const subject = `超长的任务名${'很长'.repeat(1500)}`;
    const { frames } = collectWorkFrames([
      toolUse('TaskCreate', { subject }, { toolId: 'tc2', toolResult: { content: `Task #3 created successfully: ${subject}`, isError: false } }),
    ]);
    expect(frames[0].resultContent).toBe(`Task #3 created successfully: ${subject}`);
    expect(frames[0].resultTrimmed).toBeUndefined();
  });

  it('TaskUpdate 只留 taskId / status / subject', () => {
    const { frames } = collectWorkFrames([
      toolUse('TaskUpdate', {
        taskId: '12', status: 'completed', subject: '改名后的主题', description: '长说明', activeForm: '正在做', owner: 'agent', metadata: { k: 'v' },
      }, { toolId: 'tu1', toolResult: { content: 'Updated task #12 status', isError: false } }),
      toolUse('TaskUpdate', { taskId: 3, status: 'in_progress' }, { toolId: 'tu2' }),
    ]);
    expect(frames[0].toolInput).toEqual({ taskId: '12', status: 'completed', subject: '改名后的主题' });
    expect(frames[0].inputTrimmed).toBe(true);
    expect(frames[1].toolInput).toEqual({ taskId: 3, status: 'in_progress' });
    expect(frames[1].inputTrimmed).toBeUndefined();
  });

  it('TodoWrite 原样下发(清单折叠要读整份 todos)', () => {
    const input = { todos: [{ content: '甲', status: 'completed', activeForm: '做甲' }, { content: '乙', status: 'pending', activeForm: '做乙' }] };
    const { frames } = collectWorkFrames([toolUse('TodoWrite', input, { toolId: 'td1' })]);
    expect(frames[0].toolInput).toEqual(input);
    expect(frames[0].inputTrimmed).toBeUndefined();
  });

  it('toolInput 是 JSON 串时按对象收窄;解析不了的置 null(前端同样读不出来)', () => {
    const { frames } = collectWorkFrames([
      toolUse('Write', JSON.stringify({ file_path: '/p/串.md', content: bigContent }), { toolId: 'ws1' }),
      toolUse('TaskCreate', '{not json', { toolId: 'ws2' }),
    ]);
    expect(frames[0].toolInput).toEqual({ file_path: '/p/串.md' });
    expect(frames[0].inputTrimmed).toBe(true);
    expect(frames[1].toolInput).toBeNull();
    expect(frames[1].inputTrimmed).toBe(true);
  });

  it('changed_file 帧本来就只有路径,不带标记', () => {
    const { frames } = collectWorkFrames([
      { kind: 'changed_files', provider: 'claude', cwd: '/p', files: [{ path: 'out.csv', status: 'added' }] } as unknown as NormalizedMessage,
    ]);
    expect(frames[0]).toEqual({ kind: 'changed_file', toolName: 'Write', toolInput: { file_path: '/p/out.csv' }, resultContent: 'checkpoint', resultIsError: false });
  });

  it('截断不把代理对劈成两半', () => {
    const result = `${'a'.repeat(MAX_FRAME_RESULT_CHARS - 1)}😀tail`;
    const { frames } = collectWorkFrames([
      toolUse('Write', { file_path: '/p/e.md' }, { toolId: 'we', toolResult: { content: result, isError: false } }),
    ]);
    expect(frames[0].resultContent).toBe('a'.repeat(MAX_FRAME_RESULT_CHARS - 1));
    expect(frames[0].resultTrimmed).toBe(true);
  });
});
