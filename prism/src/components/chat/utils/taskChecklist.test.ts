import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { extractLatestTodoList, extractSessionChecklist, todoProgress } from './taskChecklist';

const todoWriteMessage = (todos: unknown, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    type: 'assistant',
    content: '',
    timestamp: new Date(),
    isToolUse: true,
    toolName: 'TodoWrite',
    toolInput: JSON.stringify({ todos }),
    ...overrides,
  }) as ChatMessage;

describe('extractLatestTodoList', () => {
  it('取最新一次 TodoWrite(从尾部往前找),旧列表被覆盖', () => {
    const messages: ChatMessage[] = [
      todoWriteMessage([{ content: '旧任务', status: 'pending' }]),
      { type: 'assistant', content: '中间正文', timestamp: new Date() } as ChatMessage,
      todoWriteMessage([
        { content: '新任务一', status: 'completed' },
        { content: '新任务二', status: 'in_progress', activeForm: '正在做任务二' },
      ]),
    ];
    const todos = extractLatestTodoList(messages);
    expect(todos).toHaveLength(2);
    expect(todos![0].content).toBe('新任务一');
    expect(todos![1].activeForm).toBe('正在做任务二');
  });

  it('toolInput 已是对象(未字符串化)同样可读', () => {
    const message = todoWriteMessage(null, {
      toolInput: { todos: [{ content: '对象输入', status: 'pending' }] } as unknown as string,
    });
    expect(extractLatestTodoList([message])![0].content).toBe('对象输入');
  });

  it('坏条目降级:content 缺失/非对象的行丢弃,未知 status 降为 pending 保留', () => {
    const todos = extractLatestTodoList([
      todoWriteMessage([
        { content: '好的', status: 'pending' },
        { content: '坏状态', status: 'blocked' },
        { status: 'pending' },
        'not-an-object',
      ]),
    ]);
    expect(todos).toHaveLength(2);
    expect(todos![0].content).toBe('好的');
    expect(todos![1]).toMatchObject({ content: '坏状态', status: 'pending' });
  });

  it('最新一次整体解析失败时,回退用更早那次', () => {
    const todos = extractLatestTodoList([
      todoWriteMessage([{ content: '早前列表', status: 'in_progress' }]),
      todoWriteMessage(null, { toolInput: '{broken json' }),
    ]);
    expect(todos).toHaveLength(1);
    expect(todos![0].content).toBe('早前列表');
  });

  it('没有 TodoWrite、或列表为空 → null', () => {
    expect(extractLatestTodoList([
      { type: 'user', content: 'hi', timestamp: new Date() } as ChatMessage,
    ])).toBeNull();
    expect(extractLatestTodoList([])).toBeNull();
    expect(extractLatestTodoList([todoWriteMessage([])])).toBeNull();
  });
});

const taskTool = (
  toolName: string,
  input: Record<string, unknown>,
  resultContent?: string,
): ChatMessage =>
  ({
    type: 'assistant',
    content: '',
    timestamp: new Date(),
    isToolUse: true,
    toolName,
    toolInput: JSON.stringify(input),
    toolResult: resultContent !== undefined ? { content: resultContent, isError: false } : null,
  }) as ChatMessage;

describe('extractSessionChecklist(TaskCreate/TaskUpdate 折叠)', () => {
  it('create 的 id 从 tool_result 拿,update 改状态,按创建顺序输出', () => {
    const todos = extractSessionChecklist([
      taskTool('TaskCreate', { subject: '任务甲' }, 'Task #1 created successfully: 任务甲'),
      taskTool('TaskCreate', { subject: '任务乙' }, 'Task #2 created successfully: 任务乙'),
      taskTool('TaskUpdate', { taskId: '1', status: 'completed' }),
      taskTool('TaskUpdate', { taskId: 2, status: 'in_progress' }),
    ]);
    expect(todos).toEqual([
      { content: '任务甲', status: 'completed' },
      { content: '任务乙', status: 'in_progress' },
    ]);
  });

  it('结果未落地的 create 用入参 subject 占位;cancelled 移除任务', () => {
    const todos = extractSessionChecklist([
      taskTool('TaskCreate', { subject: '在途任务' }),
      taskTool('TaskCreate', { subject: '会被撤' }, 'Task #7 created successfully: 会被撤'),
      taskTool('TaskUpdate', { taskId: '7', status: 'cancelled' }),
    ]);
    expect(todos).toEqual([{ content: '在途任务', status: 'pending' }]);
  });

  it('未知 status 保持原状态;update 先于 create 结果时状态不被打回', () => {
    const todos = extractSessionChecklist([
      taskTool('TaskUpdate', { taskId: '3', status: 'completed' }),
      taskTool('TaskCreate', { subject: '任务丙' }, 'Task #3 created successfully: 任务丙'),
      taskTool('TaskUpdate', { taskId: '3', status: 'blocked' }),
    ]);
    expect(todos).toEqual([{ content: '任务丙', status: 'completed' }]);
  });

  it('没有 Task* 事件时回退 TodoWrite;两者皆无 → null', () => {
    const todos = extractSessionChecklist([
      todoWriteMessage([{ content: '老制式', status: 'in_progress' }]),
    ]);
    expect(todos).toEqual([{ content: '老制式', status: 'in_progress', activeForm: undefined }]);
    expect(extractSessionChecklist([])).toBeNull();
  });

  it('子代理 childTools 里的 Task* 事件计入', () => {
    const container = {
      type: 'assistant',
      content: '',
      timestamp: new Date(),
      isToolUse: true,
      toolName: 'Task',
      toolInput: '{}',
      subagentState: {
        childTools: [
          {
            toolId: 'c1',
            toolName: 'TaskCreate',
            toolInput: { subject: '子任务' },
            toolResult: { content: 'Task #9 created successfully: 子任务', isError: false },
            timestamp: new Date(),
          },
          {
            toolId: 'c2',
            toolName: 'TaskUpdate',
            toolInput: { taskId: '9', status: 'completed' },
            toolResult: null,
            timestamp: new Date(),
          },
        ],
        currentToolIndex: 1,
        isComplete: true,
      },
    } as unknown as ChatMessage;
    expect(extractSessionChecklist([container])).toEqual([{ content: '子任务', status: 'completed' }]);
  });

  it('基线+窗口重叠重放幂等:同一段事件折两遍结果不变', () => {
    const events: ChatMessage[] = [
      taskTool('TaskCreate', { subject: '甲' }, 'Task #1 created successfully: 甲'),
      taskTool('TaskUpdate', { taskId: '1', status: 'completed' }),
    ];
    const once = extractSessionChecklist(events);
    const replayed = extractSessionChecklist([...events, ...events]);
    expect(replayed).toEqual(once);
    expect(replayed).toEqual([{ content: '甲', status: 'completed' }]);
  });
});

describe('todoProgress', () => {
  it('统计完成数与总数', () => {
    const { done, total, allDone } = todoProgress([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
    expect(done).toBe(1);
    expect(total).toBe(3);
    expect(allDone).toBe(false);
    expect(todoProgress([{ content: 'a', status: 'completed' }]).allDone).toBe(true);
  });
});
