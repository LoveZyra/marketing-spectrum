import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ConversationSearchResults } from '../hooks/useSidebarController';

import { runConversationSearch } from './conversationSearch';
import type { ConversationSearchFailure, ConversationSearchPatch, ConversationSearchStream } from './conversationSearch';

/**
 * 侧栏「搜索对话」:出错不能显示成「未找到结果」。
 *
 * 流在 done 之前断开(服务端报错、反代读超时切断长搜索、断网)时若写成空结果,界面显示
 * 「未找到结果」,用户会据此以为那段对话不存在;中途断开的部分结果要标成不完整;
 * 取票失败时上一个搜索词的结果不能留着冒充这个词的结果。
 */

type SidebarSearchState = {
  results: ConversationSearchResults | null;
  progress: { scannedProjects: number; totalProjects: number } | null;
  isSearching: boolean;
  failure: ConversationSearchFailure | null;
};

class FakeStream implements ConversationSearchStream {
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  /** 关掉之后浏览器不会再派发事件。 */
  emit(type: string, data?: unknown) {
    if (this.closed) return;
    const event = { data: data === undefined ? undefined : JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const OLD_RESULTS: ConversationSearchResults = {
  query: '旧词',
  totalMatches: 3,
  results: [{ projectId: 'p0', projectName: 'old', projectDisplayName: 'old', sessions: [] }],
};

const projectResult = (id: string) => ({ projectId: id, projectName: id, projectDisplayName: id, sessions: [] });

/** 起一次搜索:初始状态照控制器的做法(旧结果还挂着、isSearching 已置真、failure 已清)。 */
const start = (options: { ticket?: () => Promise<string>; current?: { value: boolean } } = {}) => {
  const state: SidebarSearchState = { results: OLD_RESULTS, progress: null, isSearching: true, failure: null };
  const streams: FakeStream[] = [];
  const held = { stream: null as ConversationSearchStream | null };
  const current = options.current ?? { value: true };
  const done = runConversationSearch('新词', {
    issueTicket: options.ticket ?? (async () => 'ticket-1'),
    openStream: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
    isCurrent: () => current.value,
    onStreamOpened: (stream) => { held.stream = stream; },
    onStreamClosed: () => { held.stream = null; },
    apply: (patch: ConversationSearchPatch) => {
      if (patch.results !== undefined) state.results = patch.results;
      if (patch.progress !== undefined) state.progress = patch.progress;
      if (patch.isSearching !== undefined) state.isSearching = patch.isSearching;
      if (patch.failure !== undefined) state.failure = patch.failure;
    },
  });
  return { state, streams, held, current, done };
};

describe('runConversationSearch', () => {
  it('扫完、确实没有匹配:空结果,不算出错', async () => {
    const run = start();
    await run.done;
    run.streams[0].emit('progress', { totalMatches: 0, scannedProjects: 3, totalProjects: 3 });
    run.streams[0].emit('done', {});
    expect(run.state).toEqual({
      results: { results: [], totalMatches: 0, query: '新词' },
      progress: null,
      isSearching: false,
      failure: null,
    });
    expect(run.streams[0].closed).toBe(true);
    expect(run.held.stream).toBeNull();
  });

  it('扫完、有结果:结果原样留着', async () => {
    const run = start();
    await run.done;
    run.streams[0].emit('result', { projectResult: projectResult('p1'), totalMatches: 2, scannedProjects: 1, totalProjects: 2 });
    run.streams[0].emit('done', {});
    expect(run.state.results).toEqual({ results: [projectResult('p1')], totalMatches: 2, query: '新词' });
    expect(run.state.failure).toBeNull();
    expect(run.state.isSearching).toBe(false);
  });

  it('还没收到任何结果就断开:报出错,不写成空结果,旧词的结果也清掉', async () => {
    const run = start();
    await run.done;
    run.streams[0].emit('progress', { totalMatches: 0, scannedProjects: 4, totalProjects: 10 });
    run.streams[0].emit('error');
    expect(run.state).toEqual({
      results: null,
      progress: null,
      isSearching: false,
      failure: { kind: 'stream', progress: { scannedProjects: 4, totalProjects: 10 } },
    });
    expect(run.streams[0].closed).toBe(true);
    expect(run.held.stream).toBeNull();
  });

  it('扫到一半断开:部分结果保留,并标成不完整', async () => {
    const run = start();
    await run.done;
    run.streams[0].emit('result', { projectResult: projectResult('p1'), totalMatches: 1, scannedProjects: 2, totalProjects: 9 });
    run.streams[0].emit('error');
    expect(run.state.results).toEqual({ results: [projectResult('p1')], totalMatches: 1, query: '新词' });
    expect(run.state.failure).toEqual({ kind: 'stream', progress: { scannedProjects: 2, totalProjects: 9 } });
    expect(run.state.isSearching).toBe(false);
  });

  it('服务端主动发的 event: error(带 data)同样算出错', async () => {
    const run = start();
    await run.done;
    run.streams[0].emit('error', { error: 'Search failed' });
    expect(run.state.failure).toEqual({ kind: 'stream', progress: null });
    expect(run.state.results).toBeNull();
  });

  it('取票失败:清掉上一个词的结果并报出错,不开流', async () => {
    const run = start({ ticket: async () => { throw new Error('Failed to obtain search ticket (502)'); } });
    await run.done;
    expect(run.streams).toHaveLength(0);
    expect(run.state).toEqual({ results: null, progress: null, isSearching: false, failure: { kind: 'ticket', progress: null } });
  });

  it('取票期间被新的输入取代:不开流,也不动状态', async () => {
    let release: (ticket: string) => void = () => {};
    const run = start({ ticket: () => new Promise<string>((resolve) => { release = resolve; }) });
    run.current.value = false;
    release('ticket-1');
    await run.done;
    expect(run.streams).toHaveLength(0);
    expect(run.state.results).toBe(OLD_RESULTS);
    expect(run.state.failure).toBeNull();
  });

  it('取票失败但已被取代:不动状态', async () => {
    const current = { value: false };
    const run = start({ current, ticket: async () => { throw new Error('boom'); } });
    await run.done;
    expect(run.state.results).toBe(OLD_RESULTS);
    expect(run.state.failure).toBeNull();
    expect(run.state.isSearching).toBe(true);
  });

  it('流已过期:收到事件只关流,不写状态', async () => {
    const run = start();
    await run.done;
    run.current.value = false;
    run.streams[0].emit('error');
    expect(run.streams[0].closed).toBe(true);
    expect(run.state.failure).toBeNull();
    expect(run.state.results).toBe(OLD_RESULTS);
  });
});

/** 控制器与侧栏组件在 node 环境挂不起来,读源码钉住接线。 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('侧栏搜索接线', () => {
  it('每次重新搜索先清掉上一次的出错标记;重试按钮让 effect 重跑', () => {
    const controller = read('../hooks/useSidebarController.ts');
    expect(controller).toMatch(/setIsSearching\(true\);\s*setSearchFailure\(null\);/);
    expect(controller).toMatch(/if \(patch\.failure !== undefined\) setSearchFailure\(patch\.failure\);/);
    expect(controller).toMatch(/\}, \[debouncedSearchQuery, searchMode, searchRetryToken\]\);/);
    expect(controller).toMatch(/setSearchRetryToken\(\(value\) => value \+ 1\)/);
  });

  it('出错的分支排在「未找到结果」之前;部分结果顶部标不完整', () => {
    const content = read('../view/subcomponents/SidebarContent.tsx');
    const failedAt = content.indexOf("!isSearching && searchFailure && !hasPartialResults ? (");
    const noResultsAt = content.indexOf("t('search.noResults')");
    expect(failedAt).toBeGreaterThan(-1);
    expect(noResultsAt).toBeGreaterThan(failedAt);
    expect(content).toMatch(/\{!isSearching && searchFailure && \(\s*<div\s+role="alert"/);
    const sidebar = read('../view/Sidebar.tsx');
    expect(sidebar).toMatch(/searchFailure=\{searchFailure\}/);
    expect(sidebar).toMatch(/onRetrySearch=\{retryConversationSearch\}/);
  });
});
