import { sessionMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

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
export async function seedDisplayLogFromTranscript(sessionId: string): Promise<number> {
  const session = sessionsDb.getSessionById(sessionId);
  // 没有 transcript(全新会话)就没有历史要抄 —— 它从第一条消息起天然就是日志。
  if (!session?.provider_session_id) return 0;
  if (sessionMessagesDb.countForSession(sessionId) > 0) return 0;

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
    return sessionMessagesDb.appendMany(
      sessionId,
      result.messages.map((message) => ({ ...message, sessionId })),
    );
  } catch (error) {
    console.warn('[display-log] seed failed:', (error as Error)?.message || error);
    return 0;
  }
}
