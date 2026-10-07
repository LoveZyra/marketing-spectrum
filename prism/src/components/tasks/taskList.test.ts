import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fetchTaskList, taskListView } from './taskList';

/**
 * 定时任务页:列表拉不到不能显示成「还没有定时任务」。
 *
 * 用户看到空态会以为任务丢了去重建,服务恢复后就有了重复任务,而定时任务会真实执行。
 */
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const ok = (payload: unknown): FakeResponse => ({ ok: true, status: 200, json: async () => payload });
const fetchReturning = (response: FakeResponse | (() => never)) =>
  (async (url: string) => {
    expect(url).toBe('/api/tasks');
    return typeof response === 'function' ? response() : response;
  }) as unknown as Parameters<typeof fetchTaskList>[0];

const task = { id: 't1', name: '晨报' };
const serverTime = { tz: 'Asia/Shanghai', offsetMin: 480, local: '2026-10-07 09:00', now: '2026-10-07T01:00:00Z' };

describe('fetchTaskList', () => {
  it('成功:任务与服务器时区原样返回', async () => {
    expect(await fetchTaskList(fetchReturning(ok({ success: true, tasks: [task], serverTime }))))
      .toEqual({ tasks: [task], serverTime });
  });

  it('成功但确实没有任务:空列表', async () => {
    expect(await fetchTaskList(fetchReturning(ok({ success: true, tasks: [] }))))
      .toEqual({ tasks: [], serverTime: null });
  });

  it('非 2xx、不是 JSON、没有 tasks 数组、请求抛错:都返回 null,不是空列表', async () => {
    expect(await fetchTaskList(fetchReturning({ ok: false, status: 502, json: async () => ({ error: 'Bad Gateway' }) }))).toBeNull();
    expect(await fetchTaskList(fetchReturning({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }))).toBeNull();
    expect(await fetchTaskList(fetchReturning(ok({ success: true })))).toBeNull();
    expect(await fetchTaskList(fetchReturning(() => { throw new TypeError('Failed to fetch'); }))).toBeNull();
  });

  it('serverTime 缺 tz 时不采用', async () => {
    expect(await fetchTaskList(fetchReturning(ok({ tasks: [], serverTime: { offsetMin: 0 } }))))
      .toEqual({ tasks: [], serverTime: null });
  });
});

describe('taskListView', () => {
  const base = { loading: false, loadFailed: false, hasLoaded: true, total: 0, shown: 0 };

  it('首次加载中', () => {
    expect(taskListView({ ...base, loading: true, hasLoaded: false })).toBe('loading');
  });

  it('还没拉到过就失败:加载失败,不是空态', () => {
    expect(taskListView({ ...base, loadFailed: true, hasLoaded: false })).toBe('loadFailed');
  });

  it('拉到过之后轮询失败:照常画旧列表(过期提示另画)', () => {
    expect(taskListView({ ...base, loadFailed: true, total: 3, shown: 3 })).toBe('list');
    expect(taskListView({ ...base, loadFailed: true, total: 0, shown: 0 })).toBe('empty');
  });

  it('真没有任务是空态;有任务但搜不到是无匹配', () => {
    expect(taskListView(base)).toBe('empty');
    expect(taskListView({ ...base, total: 2, shown: 0 })).toBe('noMatch');
    expect(taskListView({ ...base, total: 2, shown: 1 })).toBe('list');
  });
});

/** 页面组件在 node 环境挂不起来,读源码钉住接线。 */
const page = readFileSync(fileURLToPath(new URL('./TasksPage.tsx', import.meta.url)), 'utf8');

describe('TasksPage 接线', () => {
  it('拉不到时不动旧列表,只记失败', () => {
    expect(page).toMatch(/const list = await fetchTaskList\(\);\s*if \(list\) \{\s*setTasks\(list\.tasks\);/);
    expect(page).toMatch(/setLoadFailed\(!list\);/);
    expect(page).toMatch(/taskListView\(\{ loading, loadFailed, hasLoaded, total: tasks\.length, shown: filtered\.length \}\)/);
    expect(page).toMatch(/listView === 'loadFailed' \? \(/);
  });

  it('轮询只在页面可见时发,切回可见时补拉一次', () => {
    expect(page).toMatch(/const pollIfVisible = \(\) => \{\s*if \(document\.visibilityState === 'visible'\) void refresh\(\);\s*\};/);
    expect(page).toMatch(/window\.setInterval\(pollIfVisible, 15_000\)/);
    expect(page).toMatch(/document\.addEventListener\('visibilitychange', pollIfVisible\)/);
    expect(page).toMatch(/document\.removeEventListener\('visibilitychange', pollIfVisible\)/);
  });

  it('列表页与详情页都画「可能已过期」提示', () => {
    expect(page.match(/\{staleNotice\}/g)).toHaveLength(2);
  });

  it('错误提示不再写死中文', () => {
    for (const literal of ["'保存失败'", "'操作失败'", "'删除失败'", "'启动失败'", "'领票据失败'", "'发起失败'"]) {
      const hits = page.split('\n').filter((line) => line.includes(literal) && !line.includes('defaultValue'));
      expect(hits, literal).toEqual([]);
    }
    expect(page).not.toMatch(/`(操作|删除|启动)失败:\$\{/);
    expect(page).not.toMatch(/\? '网络请求没有发出去/);
  });
});
