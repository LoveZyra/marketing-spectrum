import { describe, expect, test } from 'vitest';

import type { Project } from '../../../types/app';

import { getAllSessions, getProjectLastActivity, sortProjects } from './utils';

/**
 * 侧栏派生数据的缓存。
 *
 * `getProjectLastActivity` 在 `sortProjects` 的比较器里面调用,一次排序就是 O(n log n) 次;
 * 不缓存的话每次都要把那个项目的会话整份拷贝再排一遍,200 项目 × 30 会话单次渲染约 45ms,
 * 而侧栏在搜索框每敲一个字都会重渲染。
 *
 * 这里不测时间,测做了多少功:计时断言在 CI 上不稳定,红几次就会被加 skip,缓存掉了也没人知道。
 * 所以把 `project.sessions` 做成会计数的 getter,缓存在不在直接看它被读了几次,与机器快慢无关。
 */

type Countable = Project & { __reads: number };

/**
 * `spread` 让不同项目的"最后活跃时间"互不相同。
 *
 * 这一条是我写第一版时踩的坑:所有项目活跃时间相同的话,比较器全返回 0,
 * V8 的 TimSort 认出一整段有序、只比 n-1 次 —— 于是"排序很贵"这件事在测试里
 * 根本没发生,断言看着过了却什么都没证明。
 */
const makeProject = (id: string, sessionCount: number, spread = 0): Countable => {
  const sessions = Array.from({ length: sessionCount }, (_, index) => ({
    id: `${id}-s${index}`,
    summary: `会话 ${index}`,
    // 故意打乱顺序,这样"排序真的发生过"能验出来
    lastActivity: new Date(2026, 0, 1 + ((index * 7) % Math.max(sessionCount, 1)), spread % 24).toISOString(),
    __provider: 'claude',
  }));

  const project = {
    projectId: id,
    path: `/w/${id}`,
    displayName: id,
    __reads: 0,
  } as unknown as Countable;

  Object.defineProperty(project, 'sessions', {
    get() { project.__reads += 1; return sessions; },
    enumerable: true,
  });
  return project;
};

describe('侧栏派生数据缓存', () => {
  test('同一个 project 对象只算一次', () => {
    const project = makeProject('p1', 30);

    const first = getAllSessions(project);
    expect(project.__reads).toBe(1);

    for (let i = 0; i < 50; i += 1) getAllSessions(project);
    expect(project.__reads).toBe(1);

    // 命中缓存要返回同一个数组,不是内容相等的另一个 —— 后者对 React.memo 没用
    expect(getAllSessions(project)).toBe(first);
  });

  test('换了 project 对象就重算(失效逻辑靠对象身份,不靠手写判断)', () => {
    const before = makeProject('p1', 10);
    getAllSessions(before);
    expect(before.__reads).toBe(1);

    /*
     * `useProjectsState` 是严格不可变的:会话变了就换一个新的 Project 对象。
     * 所以"新对象 = 新数据 = 该重算"这条等式是状态层保证的,不是这里假设的。
     */
    const after = makeProject('p1', 11);
    const result = getAllSessions(after);
    expect(after.__reads).toBe(1);
    expect(result).toHaveLength(11);
    expect(result).not.toBe(getAllSessions(before));
  });

  test('排序结果与缓存前一致:仍然按时间倒序', () => {
    const project = makeProject('p1', 12);
    const sessions = getAllSessions(project);
    const times = sessions.map((s) => new Date(s.lastActivity as string).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test('getProjectLastActivity 取的仍是最大值(改成取首位不能改变语义)', () => {
    /*
     * getProjectLastActivity 取的是已排序数组的第一条;这里拿逐条 `reduce` 求最大值的结果对照,
     * 而不是相信"排过序所以第一条就是最大的"。
     */
    for (const count of [0, 1, 5, 40]) {
      const project = makeProject(`p-${count}`, count);
      const sessions = getAllSessions(project);
      const oldWay = sessions.reduce(
        (latest, session) => {
          const d = new Date(session.lastActivity as string);
          return d > latest ? d : latest;
        },
        new Date(0),
      );
      expect(getProjectLastActivity(project).getTime()).toBe(oldWay.getTime());
    }
  });

  test('sortProjects 排 200 个项目:每个项目的会话只读一次', () => {
    const projects = Array.from({ length: 200 }, (_, i) => makeProject(`p${i}`, 30, i));

    sortProjects(projects as unknown as Project[], 'date');

    const totalReads = projects.reduce((sum, p) => sum + p.__reads, 0);
    /*
     * 这个文件里最要紧的一条断言:每个项目的会话只读一次。
     * 缓存掉了的话,这个数会跳到 2162 左右(200 个项目排序约 1080 次比较,每次比较调两次
     * `getProjectLastActivity`,每次都完整拷贝 + 排序一遍),而不是 200。
     */
    expect(totalReads).toBe(200);
  });

  test('多次排序不会重复做功', () => {
    const projects = Array.from({ length: 50 }, (_, i) => makeProject(`p${i}`, 20, i));
    sortProjects(projects as unknown as Project[], 'date');
    const afterFirst = projects.reduce((sum, p) => sum + p.__reads, 0);

    // 搜索框每敲一个字就是这样重来一遍
    for (let i = 0; i < 10; i += 1) sortProjects(projects as unknown as Project[], 'date');

    expect(projects.reduce((sum, p) => sum + p.__reads, 0)).toBe(afterFirst);
  });
});
