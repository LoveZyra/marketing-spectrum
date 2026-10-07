import { sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('providers');

/**
 * 还没有显示日志的老会话第一次再开口时,把它已有的历史一次性抄进显示日志。
 *
 * 没有日志行时 `fetchHistory` 走 transcript;这个会话一发消息,日志里就有了一行,
 * `fetchHistory` 立刻改走日志 —— 不先抄的话,界面上几百条历史瞬间只剩最新那一条。
 *
 * 所以规矩是:要么日志是完整的,要么一行都没有。在回合真正开始之前,
 * 用和 transcript 回放完全同一条代码路径把历史读出来抄进去(所以老内容
 * 长什么样一点不变),抄完这个会话就永久归日志管,transcript 不再参与显示。
 *
 * 失败不阻断发送:抄不动就当没抄,这个会话继续走 transcript。
 *
 * 单独成一个模块而不是挂在 `sessionsService` 上,是为了不绕出一个
 * websocket → sessions.service → websocket 的循环引用:这里只依赖
 * provider 注册表和两张表。
 */
/**
 * 抄写结果必须区分"日志可以当权威"与"抄失败"。
 *
 * 抄失败时调用方要跳过本轮落库:否则日志有了行,`fetchHistory` 立刻改走日志,
 * 老会话几百条历史一次性从界面消失,而且 `countForSession > 0` 让 seed 再也不会重试,
 * 不可恢复。跳过之后日志维持空,这个会话继续走 transcript,下一轮还会再抄一次。
 */
export type SeedOutcome =
  /** 无需抄(全新会话)或已经抄过 —— 日志可以当权威。 */
  | { status: 'ready'; seeded: number }
  /** 抄失败:日志不可当权威,本轮不要往里写。 */
  | { status: 'failed' };

/**
 * 同一会话的并发 seed 共用一个 promise。
 *
 * 两条 `chat.send` 落在同一个 `fetchHistory` 窗口里时,两个调用都能通过 `countForSession === 0`;
 * 各抄各的话,后回来的那批会被 `INSERT OR IGNORE` 全部吞掉。共用之后,后到的直接拿先到那个的结果。
 */
const inFlightSeeds = new Map<string, Promise<SeedOutcome>>();

export function seedDisplayLogFromTranscript(sessionId: string): Promise<SeedOutcome> {
  const running = inFlightSeeds.get(sessionId);
  if (running) return running;

  const attempt = runSeed(sessionId).finally(() => {
    inFlightSeeds.delete(sessionId);
  });
  inFlightSeeds.set(sessionId, attempt);
  return attempt;
}

async function runSeed(sessionId: string): Promise<SeedOutcome> {
  const session = sessionsDb.getSessionById(sessionId);
  // 没有 transcript(全新会话)就没有历史要抄 —— 它从第一条消息起天然就是日志。
  if (!session?.provider_session_id) return { status: 'ready', seeded: 0 };
  if (sessionMessagesDb.countForSession(sessionId) > 0) return { status: 'ready', seeded: 0 };

  try {
    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: null,
      offset: 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    // 整批一个事务(见 appendMany):老会话上千条历史逐条 append 会是上千次独立
    // 隐式事务,首条消息发送前明显卡顿。
    const seeded = sessionMessagesDb.appendMany(
      sessionId,
      result.messages.map((message) => ({ ...message, sessionId })),
    );
    /*
     * 判据是「抄完之后库里到底有没有行」,而不是「本次插入了几行」:后者会把"别人已经抄好了"
     * 和"整批被拒"混为一谈,而这两件事的正确处置完全相反。
     */
    if (result.messages.length > 0 && sessionMessagesDb.countForSession(sessionId) === 0) {
      return { status: 'failed' };
    }
    return { status: 'ready', seeded };
  } catch (error) {
    log.warn('[display-log] seed failed:', (error as Error)?.message || error);
    return { status: 'failed' };
  }
}
