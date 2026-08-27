/**
 * 进程重启后,给「回合跑到一半被打断」的会话补一条标记(F14)。
 *
 * 一个回合的中断在库里长这样:显示日志的**最后一条是用户消息**,后面什么都没有。
 * 正常结束的回合最后一定是助手的文本/工具结果;而进程被 kill / 部署重启时,
 * 用户那条已经落库、模型的回答再也不会来了。
 *
 * 之前这种会话打开后是**静默**的:用户看到自己那句话孤零零挂在最后,以为还在跑
 * (转圈早没了)或者以为模型没理他。既不知道发生过什么,也不知道该重发。
 *
 * 这里在启动时扫一遍,给每条这样的会话补一条 error 消息。判定安全的前提是
 * **启动时没有任何回合在跑** —— 正在流式输出的会话同样"最后一条是用户消息",
 * 但那种状态在进程刚起来的时刻不存在。所以这件事只能在启动那一刻做,
 * 晚一秒都可能误伤。
 *
 * 幂等:补的那条本身是 durable 消息,补完之后最后一条就不再是用户消息了,
 * 下次启动自然跳过。
 */

import { getConnection, sessionMessagesDb } from '@/modules/database/index.js';
import { generateMessageId } from '@/shared/utils.js';

type TailRow = { session_id: string; kind: string; payload: string };

export const INTERRUPTED_TURN_NOTICE =
  '上一轮回合没有跑完 —— 服务在回答生成期间重启了。上面这条消息没有得到回复,重新发一次即可。';

/**
 * 找出"日志最后一条是用户消息"的会话。
 *
 * 窗口函数一次取回每个会话的最后一行,而不是先列会话再逐个查(会话上千时那是
 * 上千次查询,而这段跑在启动路径上)。
 */
export function findInterruptedSessions(): string[] {
  const db = getConnection();
  const rows = db.prepare(`
    SELECT session_id, kind, payload FROM (
      SELECT session_id, kind, payload,
             ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn
      FROM session_display_messages
    ) WHERE rn = 1
  `).all() as TailRow[];

  const interrupted: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'text') continue;
    try {
      const payload = JSON.parse(row.payload) as { role?: unknown };
      if (payload?.role === 'user') interrupted.push(row.session_id);
    } catch {
      // payload 坏了就跳过 —— 这只是个提示,不值得让启动失败。
    }
  }
  return interrupted;
}

/**
 * 启动时给被打断的会话补标记。返回补了几条。
 *
 * 整段包在 try 里:这是个体验补丁,任何失败都不该拦住服务起来。
 */
export function markInterruptedTurnsOnStartup(): number {
  let marked = 0;
  try {
    for (const sessionId of findInterruptedSessions()) {
      const appended = sessionMessagesDb.append(sessionId, {
        id: generateMessageId('interrupted'),
        sessionId,
        timestamp: new Date().toISOString(),
        // provider 只有 'claude' 一个合法值(NormalizedMessage 的类型);
        // 这条是网关补的,不是模型说的,靠 kind='error' 与内容自证。
        provider: 'claude',
        kind: 'error',
        content: INTERRUPTED_TURN_NOTICE,
      } as Parameters<typeof sessionMessagesDb.append>[1]);
      if (appended) marked += 1;
    }
    if (marked > 0) {
      console.log(`[startup] 已给 ${marked} 条被重启打断的会话补上「请重发」标记`);
    }
  } catch (error) {
    console.warn('[startup] 打断标记补写失败:', (error as Error)?.message || error);
  }
  return marked;
}
