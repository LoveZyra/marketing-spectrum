import type { ProgressEvent } from './types';

/** hd:优化过程事件的分组(纯函数,供 ProcessTimeline 与测试用)。 */
export type StepGroup = {
  kind: 'step';
  key: string;
  start: ProgressEvent;
  end: ProgressEvent | null;
  tasks: ProgressEvent[];
  notes: ProgressEvent[];          // proposing / proposals / candidate / selected / proposing_doc / 嵌套 step
  children: StepGroup[];
};
export type Item = { kind: 'event'; key: string; e: ProgressEvent } | StepGroup;

export const INNER = new Set(['task', 'proposing', 'proposals', 'candidate', 'selected', 'proposing_doc']);

export function groupEvents(events: ProgressEvent[]): Item[] {
  const items: Item[] = [];
  const stack: StepGroup[] = [];
  for (const e of events) {
    if (e.kind === 'step') {
      const g: StepGroup = { kind: 'step', key: `s${e.seq}`, start: e, end: null, tasks: [], notes: [], children: [] };
      // 嵌套的 step 挂在外层下面(展开后一行小结),不单独起一行
      if (stack.length > 0) {
        stack[stack.length - 1].notes.push(e);
        stack[stack.length - 1].children.push(g);
      } else items.push(g);
      stack.push(g);
      continue;
    }
    if (e.kind === 'step_end') {
      const g = stack.pop();
      if (g) g.end = e;
      continue;
    }
    if (INNER.has(e.kind)) {
      const g = stack[stack.length - 1];
      if (g) {
        if (e.kind === 'task') g.tasks.push(e); else g.notes.push(e);
        continue;
      }
    }
    items.push({ kind: 'event', key: `e${e.seq}`, e });
  }
  return items;
}


/** 进行中的那一步(最里层还没收尾的 step)+ 它最新的一条任务 / 候选;外层 step 作 parent。 */
export function currentActivity(events: ProgressEvent[]): { step: ProgressEvent; done: number; last: ProgressEvent | null; parent: ProgressEvent | null } | null {
  const stack: Array<{ step: ProgressEvent; done: number; last: ProgressEvent | null }> = [];
  for (const e of events) {
    if (e.kind === 'step') stack.push({ step: e, done: 0, last: null });
    else if (e.kind === 'step_end') stack.pop();
    else if (stack.length > 0 && INNER.has(e.kind)) {
      const top = stack[stack.length - 1];
      if (e.kind === 'task') top.done += 1;
      top.last = e;
    }
  }
  if (stack.length === 0) return null;
  const top = stack[stack.length - 1];
  return { ...top, parent: stack.length > 1 ? stack[0].step : null };
}

