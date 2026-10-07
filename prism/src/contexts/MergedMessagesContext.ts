import { createContext, useContext } from 'react';

/**
 * 插话(合流进 CLI 队列的用户消息)的状态,气泡据此显示「模型读到前可撤回」或「已撤回」。
 *
 * - `pending`:服务端已把它推进 CLI 的命令队列,模型还没读到(还撤得回);
 * - `withdrawn`:没执行就被撤掉了(按了停止,或用户点了撤回)。
 * 送达(被模型读进某一轮)之后条目即删除,此后它和普通消息没有区别。
 * 刷新后不再有 pending(撤不撤得回由服务端判定,下一次点撤回会得到答复);withdrawn 由落库的那一行带着。
 */
export type MergedMessageState = 'pending' | 'withdrawn';

export interface MergedMessagesContextValue {
  stateFor: (clientMessageId: string | undefined) => MergedMessageState | undefined;
  withdraw: (clientMessageId: string) => void;
}

const MergedMessagesContext = createContext<MergedMessagesContextValue | null>(null);

export function useMergedMessages(): MergedMessagesContextValue | null {
  return useContext(MergedMessagesContext);
}

export default MergedMessagesContext;
