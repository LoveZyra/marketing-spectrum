import type { ConversationSearchResults, SearchProgress } from '../hooks/useSidebarController';

type ConversationProjectResult = ConversationSearchResults['results'][number];

/**
 * 搜索没能完整跑完。
 *
 * - ticket:没换到搜索票据,流根本没开;
 * - stream:流在 done 之前断开(服务端报错、反代读超时切断长搜索、票据被拒、断网)。
 */
export type ConversationSearchFailure = {
  kind: 'ticket' | 'stream';
  /** 断开前最后一次收到的进度;取票失败或还没收到进度时为 null。 */
  progress: SearchProgress | null;
};

/** 侧栏要更新的状态。没出现的字段保持原值。 */
export type ConversationSearchPatch = {
  results?: ConversationSearchResults | null;
  progress?: SearchProgress | null;
  isSearching?: boolean;
  failure?: ConversationSearchFailure | null;
};

/** EventSource 里用到的那一小块,测试里用假的顶替。 */
export type ConversationSearchStream = {
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  close: () => void;
};

export type ConversationSearchDeps = {
  issueTicket: () => Promise<string>;
  openStream: (query: string, ticket: string) => ConversationSearchStream;
  /** 这次搜索是否仍是当前那次:没被后续输入取代、组件没卸载。 */
  isCurrent: () => boolean;
  /** 流开出来后交给调用方保管,换词或卸载时由调用方 close。 */
  onStreamOpened: (stream: ConversationSearchStream) => void;
  /** 流已结束(done 或出错),调用方不必再保管。 */
  onStreamClosed: () => void;
  apply: (patch: ConversationSearchPatch) => void;
};

/**
 * 侧栏「搜索对话」的一次搜索:换票、开 SSE 流,把流里的事件折成侧栏要显示的状态。
 *
 * 出错和「真没结果」要分开报:出错时若照样写成空结果,界面显示「未找到结果」,
 * 用户会据此以为那段对话不存在。中途断开时已收到的部分结果保留,但标成不完整。
 */
export async function runConversationSearch(query: string, deps: ConversationSearchDeps): Promise<void> {
  let ticket: string;
  try {
    ticket = await deps.issueTicket();
  } catch {
    if (deps.isCurrent()) {
      // 旧结果属于上一个搜索词,留着会被当成这个词的结果。
      deps.apply({ isSearching: false, progress: null, results: null, failure: { kind: 'ticket', progress: null } });
    }
    return;
  }
  // 取票期间查询被取代或组件卸载了,就别再开流,否则会漏一个没人 close 的连接。
  if (!deps.isCurrent()) return;

  const stream = deps.openStream(query, ticket);
  deps.onStreamOpened(stream);

  const accumulated: ConversationProjectResult[] = [];
  let totalMatches = 0;
  let lastProgress: SearchProgress | null = null;

  const isStale = () => {
    if (deps.isCurrent()) return false;
    stream.close();
    return true;
  };
  const finish = () => {
    stream.close();
    deps.onStreamClosed();
  };

  stream.addEventListener('result', (evt) => {
    if (isStale()) return;
    try {
      const data = JSON.parse(evt.data) as {
        projectResult: ConversationProjectResult;
        totalMatches: number;
        scannedProjects: number;
        totalProjects: number;
      };
      accumulated.push(data.projectResult);
      totalMatches = data.totalMatches;
      lastProgress = { scannedProjects: data.scannedProjects, totalProjects: data.totalProjects };
      deps.apply({ results: { results: [...accumulated], totalMatches, query }, progress: lastProgress });
    } catch {
      // Ignore malformed SSE data
    }
  });

  stream.addEventListener('progress', (evt) => {
    if (isStale()) return;
    try {
      const data = JSON.parse(evt.data) as { totalMatches: number; scannedProjects: number; totalProjects: number };
      totalMatches = data.totalMatches;
      lastProgress = { scannedProjects: data.scannedProjects, totalProjects: data.totalProjects };
      deps.apply({ progress: lastProgress });
    } catch {
      // Ignore malformed SSE data
    }
  });

  stream.addEventListener('done', () => {
    if (isStale()) return;
    finish();
    deps.apply({
      isSearching: false,
      progress: null,
      ...(accumulated.length === 0 ? { results: { results: [], totalMatches: 0, query } } : {}),
    });
  });

  // 收到 done 时流已经 close,之后不会再有事件;能走到这里就是 done 之前断了。
  // 服务端主动报的 `event: error` 与连接层面的错误走的都是这个监听。
  stream.addEventListener('error', () => {
    if (isStale()) return;
    finish();
    deps.apply({
      isSearching: false,
      progress: null,
      failure: { kind: 'stream', progress: lastProgress },
      ...(accumulated.length === 0 ? { results: null } : {}),
    });
  });
}
