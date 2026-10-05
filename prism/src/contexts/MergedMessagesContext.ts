import { createContext, useContext } from 'react';

/**
 * ho(ho-1):**插话(合流进 CLI 队列的用户消息)的状态** —— 气泡据此显示「模型读到前可撤回」或「已撤回」。
 *
 * - `pending`:服务端把它推进了 CLI 的命令队列,模型还没读到(还撤得回);
 * - `withdrawn`:没执行就被撤掉了(按了停止,或用户点了撤回)。
 * 送达(被模型读进某一轮)之后条目就删了 —— 那时它和普通消息没有区别。
 * 刷新之后 pending 不再有(撤不撤得回由服务端说了算,下一次点撤回会得到答复);withdrawn 由落库的那一行带着。
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
