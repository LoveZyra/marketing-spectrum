import type { ChatMessage } from '../types/types';

/**
 * 会话级任务清单(do):把 agent 的 TodoWrite 聚合成置顶面板的数据。
 *
 * Cowork "像个同事"的第一来源就是任务清单:开工先立清单、进行中逐项打勾。
 * Prism 里 SDK 的 TodoWrite 帧一直都有(工具行里也渲染),但只是时间轴中的
 * 一行,折叠后就看不见。这里取**最新一份**清单 —— TodoWrite 的语义本来就是
 * 整表替换,最后一份即当前状态;回合结束后它还在显示日志里,刷新后照样恢复。
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** 进行中的现在分词形态(SDK 可选给),显示优先用它。 */
  activeForm?: string;
}

const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function parseTodoInput(raw: unknown): TodoItem[] | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const todos = (value as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(todos)) return null;

  const items: TodoItem[] = [];
  for (const entry of todos) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (!content) continue;
    const status = typeof record.status === 'string' && TODO_STATUSES.has(record.status)
      ? (record.status as TodoStatus)
      : 'pending';
    const activeForm = typeof record.activeForm === 'string' && record.activeForm.trim()
      ? record.activeForm.trim()
      : undefined;
    items.push({ content, status, activeForm });
  }
  return items.length > 0 ? items : null;
}

/**
 * 从(时间正序的)消息列表里取**最后一份**有效 TodoWrite 清单。
 * 从尾部往回扫,第一份能解出来的就是答案 —— 后写的整表覆盖先写的。
 */
export function extractLatestTodoList(messages: readonly ChatMessage[]): TodoItem[] | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.isToolUse || message.toolName !== 'TodoWrite') continue;
    const todos = parseTodoInput(message.toolInput);
    if (todos) return todos;
  }
  return null;
}

export function todoProgress(todos: readonly TodoItem[]): { done: number; total: number; allDone: boolean } {
  const total = todos.length;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return { done, total, allDone: total > 0 && done === total };
}

/* ------------------------------------------------------------------------- *
 * TaskCreate / TaskUpdate 折叠(do,实测补充)
 *
 * 容器内实测:这套 SDK 运行时(0.3.x)根本没有 TodoWrite —— agent 管理清单用
 * 的是 TaskCreate / TaskUpdate(经 ToolSearch 加载)。所以清单要两种都认:
 * TodoWrite 是整表替换,Task* 是增量事件,时间正序折叠成当前状态。
 * 任务 id 在 TaskCreate 的 **tool_result** 里("Task #1 created successfully:
 * 主题"),不在入参里;运行中结果未落地时先用入参 subject 占位,重转自愈。
 * ------------------------------------------------------------------------- */

const CREATE_RESULT_RE = /Task #(\d+) created successfully:\s*(.*)/;

function parseLooseObject(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 一次工具调用事件的最小形状 —— 顶层消息与子代理 childTools 共用。 */
interface ToolEvent {
  toolName: string;
  toolInput: unknown;
  resultContent: string;
}

function applyTaskEvent(tasks: Map<string, TodoItem>, event: ToolEvent): void {
  if (event.toolName === 'TaskCreate') {
    const match = CREATE_RESULT_RE.exec(event.resultContent);
    const input = parseLooseObject(event.toolInput);
    const subject = typeof input?.subject === 'string' && input.subject.trim() ? input.subject.trim() : '';
    if (match) {
      const content = (match[2] || '').trim() || subject || `任务 #${match[1]}`;
      // 状态只保不清:乱序时(update 先见于 create 结果)不打回 pending。
      tasks.set(match[1], { content, status: tasks.get(match[1])?.status ?? 'pending' });
    } else if (subject) {
      // 结果还在路上(运行中帧):先按主题占位;结果落地后整表重折即自愈。
      tasks.set(`pending:${subject}`, { content: subject, status: 'pending' });
    }
    return;
  }

  if (event.toolName === 'TaskUpdate') {
    const input = parseLooseObject(event.toolInput);
    const taskId = input?.taskId != null && String(input.taskId).trim() ? String(input.taskId).trim() : '';
    if (!taskId) return;
    const status = typeof input?.status === 'string' ? input.status : '';
    if (status === 'cancelled' || status === 'deleted') {
      tasks.delete(taskId);
      return;
    }
    const existing = tasks.get(taskId);
    const subject = typeof input?.subject === 'string' && input.subject.trim() ? input.subject.trim() : '';
    tasks.set(taskId, {
      content: subject || existing?.content || `任务 #${taskId}`,
      status: TODO_STATUSES.has(status) ? (status as TodoStatus) : existing?.status ?? 'pending',
    });
  }
}

/**
 * 会话清单(两制式统一入口):有 Task* 事件时折叠 Task*,否则回退最后一份
 * TodoWrite。给右侧工作面板用。
 *
 * dq:同一事件折两遍是**幂等**的(create 只补名不清状态、update 置同值、
 * cancelled 重复删除无害)—— 所以调用方可以放心把"服务端全量基线 + 前端
 * 已加载窗口"直接拼接传进来,重叠段不会算错。子代理 childTools 里的
 * Task* 事件同样计入 —— 子代理立的任务也是这个会话的工作。
 *
 * dw:清单是**会话级只增不减**的 —— 任务 id 在会话内单调递增、永不撞号,
 * 所以一个会话跑几十个回合,历史轮次的已完成任务会一直堆着,既没有按时间
 * 过期也没有上限。这里给一个硬上限兜底:超了只留**最近的** MAX 条(Map 的
 * 迭代顺序即插入顺序,也就是建立顺序)。上限只防"无限长",可读性靠面板把
 * 已完成的历史折起来(见 ChatWorkPanel)。
 */
export const MAX_CHECKLIST_ITEMS = 200;

export function extractSessionChecklist(messages: readonly ChatMessage[]): TodoItem[] | null {
  const tasks = new Map<string, TodoItem>();

  for (const message of messages) {
    if (message?.isToolUse && typeof message.toolName === 'string') {
      applyTaskEvent(tasks, {
        toolName: message.toolName,
        toolInput: message.toolInput,
        resultContent: typeof message.toolResult?.content === 'string' ? message.toolResult.content : '',
      });
    }
    const children = message?.subagentState?.childTools;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (!child || typeof child.toolName !== 'string') continue;
        applyTaskEvent(tasks, {
          toolName: child.toolName,
          toolInput: child.toolInput,
          resultContent: typeof child.toolResult?.content === 'string' ? child.toolResult.content : '',
        });
      }
    }
  }

  if (tasks.size > 0) {
    const items = [...tasks.values()];
    return items.length > MAX_CHECKLIST_ITEMS ? items.slice(-MAX_CHECKLIST_ITEMS) : items;
  }
  return extractLatestTodoList(messages);
}
