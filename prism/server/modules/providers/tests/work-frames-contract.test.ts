import { describe, expect, it } from 'vitest';

import { collectWorkFrames } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { extractSessionOutputs } from '../../../../src/components/chat/utils/sessionOutputs';
import { extractSessionChecklistWithTurn } from '../../../../src/components/chat/utils/taskChecklist';
import {
  changedFilesToMessages,
  turnMarkerMessage,
  workFramesToMessages,
  type SessionWorkFrame as ClientWorkFrame,
} from '../../../../src/components/chat/utils/workFrames';

/**
 * 服务端收窄过的帧与前端折叠之间的契约。
 *
 * 工作面板把「服务端基线 + 已加载窗口」拼起来折叠,窗口里是完整的消息。基线只带折叠会读的字段,
 * 所以同一段历史:只用基线折出来的清单 / 产出,必须和用完整消息(窗口那一路)折出来的一模一样。
 * 前端哪天开始读一个基线里没有的字段(比如 TaskCreate 的 description),这里会先红。
 */

const BIG = 'export const value = 42;\n'.repeat(4000);
const LONG_SUBJECT = `把导出改成按天分片并补上断点续传${'、再补一条回归用例'.repeat(30)}`;
const CAT_SNIPPET = `The file has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${'     1\tline\n'.repeat(400)}`;

let seq = 0;
const user = (content: string, extra: Record<string, unknown> = {}): NormalizedMessage =>
  ({ id: `u${seq += 1}`, kind: 'text', role: 'user', provider: 'claude', content, ...extra }) as NormalizedMessage;
const answer = (content: string): NormalizedMessage =>
  ({ id: `a${seq += 1}`, kind: 'text', role: 'assistant', provider: 'claude', content }) as NormalizedMessage;
const call = (toolName: string, toolInput: unknown, result?: { content: string; isError?: boolean }): NormalizedMessage[] => {
  const toolId = `t${seq += 1}`;
  const use = { id: toolId, kind: 'tool_use', provider: 'claude', toolName, toolId, toolInput } as NormalizedMessage;
  return result
    ? [use, { kind: 'tool_result', provider: 'claude', toolId, content: result.content, isError: result.isError ?? false } as NormalizedMessage]
    : [use];
};

/** 完整消息按聊天窗口里的样子转成前端消息(用户消息计回合,工具调用带配好的结果)。 */
function asWindow(history: NormalizedMessage[]): unknown[] {
  const results = new Map<string, NormalizedMessage>();
  for (const message of history) {
    if (message.kind === 'tool_result' && message.toolId) results.set(message.toolId, message);
  }
  const out: unknown[] = [];
  for (const message of history) {
    if (message.kind === 'text' && message.role === 'user') {
      out.push({ type: 'user', content: message.content, timestamp: 0, ...(message.interjection ? { interjection: true } : {}) });
    } else if (message.kind === 'tool_use') {
      const result = message.toolId ? results.get(message.toolId) : undefined;
      out.push({
        type: 'assistant',
        content: '',
        timestamp: 0,
        isToolUse: true,
        toolName: message.toolName,
        toolInput: message.toolInput,
        toolResult: result ? { content: result.content, isError: Boolean(result.isError) } : null,
      });
    } else if (message.kind === 'changed_files') {
      out.push(...changedFilesToMessages(message.cwd as string, message.files as unknown[]));
    }
  }
  return out;
}

function asBaseline(history: NormalizedMessage[]): unknown[] {
  const collected = collectWorkFrames(history);
  return [
    ...workFramesToMessages(collected.frames as unknown as ClientWorkFrame[]),
    ...turnMarkerMessage(collected.userTurns),
  ];
}

describe('收窄过的基线与完整消息折出同一份清单和产出', () => {
  it('Task* 清单(含回合号)与 Write / changed_files 产出', () => {
    const history: NormalizedMessage[] = [
      ...call('TaskCreate', { subject: '会话开始前就有的任务', description: BIG }, { content: 'Task #1 created successfully: 会话开始前就有的任务' }),
      user('第一轮:生成模块'),
      ...call('TaskCreate', { subject: '生成模块', description: '说明'.repeat(3000), activeForm: '正在生成模块' }, { content: 'Task #2 created successfully: 生成模块' }),
      ...call('TaskCreate', { subject: '写测试', description: '说明', activeForm: '正在写测试' }, { content: 'Task #3 created successfully: 写测试' }),
      ...call('TaskUpdate', { taskId: '2', status: 'in_progress', activeForm: '正在生成', owner: 'agent', metadata: { a: 1 } }, { content: 'Updated task #2 status' }),
      ...call('Write', { file_path: '/p/src/a.ts', content: BIG }, { content: 'File created successfully at: /p/src/a.ts' }),
      ...call('Write', { file_path: '/p/src/b.ts', content: BIG }, { content: CAT_SNIPPET }),
      ...call('Write', { file_path: '/p/src/拒.ts', content: BIG }, { content: 'EACCES', isError: true }),
      ...call('Write', JSON.stringify({ file_path: '/p/src/串.ts', content: BIG }), { content: 'ok' }),
      ...call('Write', { file_path: '/p/src/在途.ts', content: BIG }),
      ...call('TaskUpdate', { taskId: '2', status: 'completed', subject: '生成全部模块', description: '改过的说明' }, { content: 'Updated task #2 subject, status' }),
      user('插一句:顺便加注释', { interjection: true }),
      { id: 'cf1', kind: 'changed_files', provider: 'claude', cwd: '/p', files: [{ path: 'out/report.csv', status: 'added' }, { path: 'src/a.ts', status: 'modified' }] } as unknown as NormalizedMessage,
      answer('第一轮做完了'),
      user('第二轮:收尾'),
      ...call('TaskUpdate', { taskId: '3', status: 'in_progress' }, { content: 'Updated task #3 status' }),
      ...call('TaskUpdate', { taskId: '1', status: 'deleted' }, { content: 'Updated task #1 deleted' }),
      // 任务名比结果预览的上限长:清单上的名字取自结果,结果被截的话这里就对不上
      ...call('TaskCreate', { subject: LONG_SUBJECT }, { content: `Task #4 created successfully: ${LONG_SUBJECT}` }),
      ...call('TaskCreate', { subject: '还在路上的任务', description: BIG }),
    ];

    const baseline = asBaseline(history);
    const window = asWindow(history);
    expect(JSON.stringify(baseline).includes('export const value')).toBe(false);

    const fromBaseline = extractSessionChecklistWithTurn(baseline as never);
    const fromWindow = extractSessionChecklistWithTurn(window as never);
    expect(fromBaseline).toEqual(fromWindow);
    expect(fromBaseline.items?.map((item) => [item.content, item.status, item.turn])).toEqual([
      ['生成全部模块', 'completed', 1],
      ['写测试', 'in_progress', 2],
      [LONG_SUBJECT, 'pending', 2],
      ['还在路上的任务', 'pending', 2],
    ]);
    expect(fromBaseline.currentTurn).toBe(2);

    const outputsFromBaseline = extractSessionOutputs(baseline as never);
    expect(outputsFromBaseline).toEqual(extractSessionOutputs(window as never));
    expect(outputsFromBaseline.map((file) => file.path)).toEqual(['/p/src/a.ts', '/p/src/b.ts', '/p/src/串.ts', '/p/out/report.csv']);
  });

  it('TodoWrite 清单(没有 Task* 时取最后一份)', () => {
    const history: NormalizedMessage[] = [
      user('排个计划'),
      ...call('TodoWrite', { todos: [{ content: '甲', status: 'in_progress', activeForm: '做甲' }, { content: '乙', status: 'pending', activeForm: '做乙' }] }, { content: 'Todos have been modified successfully.' }),
      ...call('Write', { file_path: '/p/plan.md', content: BIG }, { content: 'ok' }),
      ...call('TodoWrite', { todos: [{ content: '甲', status: 'completed', activeForm: '做甲' }, { content: '乙', status: 'in_progress', activeForm: '做乙' }] }, { content: 'Todos have been modified successfully.' }),
      ...call('TodoWrite', { todos: [] }, { content: 'Todos have been modified successfully.' }),
      answer('好了'),
    ];
    const baseline = asBaseline(history);
    const window = asWindow(history);
    const fromBaseline = extractSessionChecklistWithTurn(baseline as never);
    expect(fromBaseline).toEqual(extractSessionChecklistWithTurn(window as never));
    expect(fromBaseline.items).toEqual([
      { content: '甲', status: 'completed', activeForm: '做甲' },
      { content: '乙', status: 'in_progress', activeForm: '做乙' },
    ]);
    expect(extractSessionOutputs(baseline as never)).toEqual(extractSessionOutputs(window as never));
  });
});
