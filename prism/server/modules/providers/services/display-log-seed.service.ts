import { sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('providers');

/**
 * 老会话第一次再开口时,把它已有的历史**一次性抄进显示日志**。
 *
 * 不做这一步会出一个很难看的错:日志表是这一轮才有的,老会话一行都没有,
 * `fetchHistory` 于是走 transcript;可只要这个会话再发一条消息,日志里就有了
 * 一行,`fetchHistory` 立刻改走日志 —— 界面上几百条历史瞬间只剩最新那一条。
 *
 * 所以规矩是:**要么日志是完整的,要么一行都没有。** 在回合真正开始之前,
 * 用和 transcript 回放**完全同一条代码路径**把历史读出来抄进去(所以老内容
 * 长什么样一点不变),抄完这个会话就永久归日志管,transcript 再也不参与显示。
 *
 * 失败不阻断发送:抄不动就当没抄,这个会话继续走 transcript 那条老路。
 *
 * 单独成一个模块而不是挂在 `sessionsService` 上,是为了不绕出一个
 * websocket → sessions.service → websocket 的循环引用:这里只依赖
 * provider 注册表和两张表。
 */
/**
 * du:抄写结果必须**可区分**。
 *
 * 老版本三种情况一律返回 0:全新会话(没历史要抄)、已经抄过、以及**抄失败**。
 * 调用方无从分辨,于是失败后照样往日志里落这一轮的消息 —— 日志有了行,
 * `fetchHistory` 立刻改走日志,老会话几百条历史一次性从界面消失,而且
 * `countForSession > 0` 让 seed 再也不会重试,**不可恢复**。这正好打破了本
 * 模块开头那条规矩。现在失败单独报出来,调用方据此**跳过本轮落库**:
 * 日志维持空,这个会话继续走 transcript,下一轮还会再抄一次。
 */
export type SeedOutcome =
  /** 无需抄(全新会话)或已经抄过 —— 日志可以当权威。 */
  | { status: 'ready'; seeded: number }
  /** 抄失败 —— 日志**不可**当权威,本轮不要往里写。 */
  | { status: 'failed' };

/**
 * fj:同一会话的并发 seed 去重。
 *
 * 此前没有互斥:两条 `chat.send` 落在同一个 `fetchHistory` 窗口里,两个调用都能
 * 通过 `countForSession === 0`,都去读 transcript。先回来的 `appendMany` 成功;
 * 后回来的写同一批 `message_id`,被 `INSERT OR IGNORE` **全部吞掉** → `seeded === 0`
 * 且历史非空 → 判成 `failed` → 调用方把 `persistDisplayLog` 设 false →
 * **那一整轮的用户消息和全部助手输出都不落库**,刷新后从界面消失且不可恢复。
 *
 * 共用同一个 promise 之后,后到的那个拿到的是先到那个的结果(`ready`),整轮正常落库。
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
    /**
     * fj:判据从「本次插入了几行」改成「抄完之后库里到底有没有行」。
     *
     * 前者把"别人已经抄好了"和"整批被拒"混为一谈 —— 而这两件事的正确处置完全相反。
     * 后者直接问要害:日志现在能不能当权威。
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
