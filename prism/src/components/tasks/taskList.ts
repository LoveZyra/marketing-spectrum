import { authenticatedFetch } from '../../utils/api';

import type { ServerTime, WireTask } from './TasksPage';

export type TaskListPayload = { tasks: WireTask[]; serverTime: ServerTime | null };

/**
 * 拉一次定时任务列表。拉不到(非 2xx、不是 JSON、没有 tasks 数组、请求失败)返回 null。
 *
 * 拉不到不能当成空列表:界面会显示「还没有定时任务」,用户以为任务丢了去重建,
 * 服务恢复后就有了重复任务,而定时任务会真实执行。
 */
export async function fetchTaskList(fetchFn: typeof authenticatedFetch = authenticatedFetch): Promise<TaskListPayload | null> {
  try {
    const response = await fetchFn('/api/tasks');
    if (!response.ok) return null;
    const payload = await response.json() as { tasks?: unknown; serverTime?: { tz?: unknown } } | null;
    if (!payload || !Array.isArray(payload.tasks)) return null;
    const serverTime = payload.serverTime && typeof payload.serverTime.tz === 'string'
      ? payload.serverTime as ServerTime
      : null;
    return { tasks: payload.tasks as WireTask[], serverTime };
  } catch {
    return null;
  }
}

export type TaskListView = 'loading' | 'loadFailed' | 'empty' | 'noMatch' | 'list';

/**
 * 列表区画什么。
 *
 * 还没成功拉到过就失败了,画「加载失败」而不是空态;拉到过之后再失败(轮询),
 * 照常画手里的旧列表,另由页头提示数据可能已过期。
 */
export function taskListView(state: {
  loading: boolean;
  loadFailed: boolean;
  hasLoaded: boolean;
  total: number;
  shown: number;
}): TaskListView {
  if (state.loading) return 'loading';
  if (state.loadFailed && !state.hasLoaded) return 'loadFailed';
  if (state.shown > 0) return 'list';
  return state.total === 0 ? 'empty' : 'noMatch';
}
