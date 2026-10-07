/**
 * 两处"删完之后界面不能停在旧状态"的接线:已删除会话向上滚不打 404;「最近删除」跟着别人的操作刷新。
 *
 * vitest 这边没有 jsdom,挂不起 store 和 hook,而要钉的都是接线,
 * 所以直接对源码断言(和仓库里其它钉接线的测试同一做法)。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(path.join(here, relative), 'utf8');

const sessionStore = read('../stores/useSessionStore.ts');
const projectsState = read('./useProjectsState.ts');
const sidebar = read('../components/sidebar/view/Sidebar.tsx');

describe('「已被删除」态下向上滚不打 404', () => {
  /**
   * 会话被别处永久删除之后向上滚,`fetchMore` 会拿到 404。
   * 那不是"加载失败",是"没有更多历史可加载":走 throw 分支会往控制台打错,
   * 返回 null 又会被判成失败,让自动补页一直重试。
   */
  it('fetchMore 对 404 单独处理,而且发生在 `!response.ok` 抛错之前', () => {
    const notFoundAt = sessionStore.indexOf('response.status === 404');
    const throwAt = sessionStore.indexOf('if (!response.ok) throw new Error(`HTTP ${response.status}`);', notFoundAt - 2000 > 0 ? notFoundAt - 2000 : 0);
    expect(notFoundAt, 'fetchMore 里找不到 404 分支').toBeGreaterThan(-1);
    expect(throwAt, '找不到抛错那一行').toBeGreaterThan(-1);
    expect(notFoundAt, '404 分支必须在抛错之前,否则永远走不到').toBeLessThan(throwAt);
  });

  it('404 分支要把 hasMore 落下来 —— 否则调用方会一直再问一次', () => {
    const branch = sessionStore.slice(sessionStore.indexOf('response.status === 404'));
    const body = branch.slice(0, branch.indexOf('}') + 1);
    expect(body).toContain('slot.hasMore = false');
  });
});

describe('「最近删除」跟着别人的操作刷新', () => {
  it('session_removed 与 session_restored 两帧都 bump trashSignal', () => {
    for (const kind of ['session_removed', 'session_restored']) {
      const at = projectsState.indexOf(`event.kind === '${kind}'`);
      expect(at, `找不到 ${kind} 的分支`).toBeGreaterThan(-1);
      // 从这个分支起、到下一个 `event.kind ===` 之前,必须有一次 bump
      // (分支里还有 `if (!eventSessionId) return;` 这种早退,所以不能按第一个 return 切)
      const tail = projectsState.slice(at + 10);
      const nextBranch = tail.indexOf('event.kind ===');
      const block = nextBranch > -1 ? tail.slice(0, nextBranch) : tail;
      expect(block, `${kind} 分支没有 bump trashSignal`).toContain('setTrashSignal');
    }
  });

  it('trashSignal 往下传到了侧栏,并且与侧栏自己的 token 相加', () => {
    expect(projectsState).toContain('externalTrashSignal: trashSignal');
    expect(sidebar).toContain('trashReloadToken={trashReloadToken + (externalTrashSignal ?? 0)}');
  });
});
