import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { workFramesToMessages, type SessionWorkFrame } from '../utils/workFrames';
import type { ServerTurnOutputFile } from '../utils/turnOutputs';
import { readCachedTurnOutputs, writeCachedTurnOutputs } from '../utils/turnOutputsCache';
import type { ChatMessage } from '../types/types';

export type SessionWorkFramesState = {
  /** 服务端全量历史滤出的工具帧,已转成伪 ChatMessage(工作面板基线)。 */
  baseMessages: ChatMessage[];
  /**
   * dt:至今仍处于"已回滚"状态的绝对路径。基线里的产出帧服务端已删,
   * 但前端窗口里的旧 Write 工具帧会把文件加回来 —— 产出折叠完要用它做
   * 最终减法;回滚后重写的文件不在此集合(服务端时序折叠已处理)。
   */
  revertedPaths: ReadonlySet<string>;
  /**
   * ej:助手回答的消息 id → **这一轮**写出来的文件。服务端按**全量历史**算好,
   * 随消息一起到达,此后不再变 —— 对话正文下面那张「产出」卡的正本。
   *
   * 之前这张卡是前端从"当前加载到的消息窗口"现推的,窗口起点常落在某一轮
   * 工具流中间,于是"先产出 2、过一会儿变产出 5",加了截断保护之后变成
   * "先没有、过一会儿才出现"(用户两次实测)。数据源换成服务端,病根才断。
   */
  turnOutputs: Record<string, ServerTurnOutputFile[]>;
  /**
   * dw:服务端帧数触顶,较早的工作帧没随本次响应下发 —— 面板要如实说明
   * "更早的记录未载入",而不是装作这就是全部。
   */
  truncated: boolean;
  /** 手动重拉基线(回滚/还原成功后调,拿到含反向帧的新快照)。 */
  refresh: () => void;
};

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const EMPTY_TURN_OUTPUTS: Record<string, ServerTurnOutputFile[]> = {};

/**
 * dq/dt:工作面板的服务端基线。
 *
 * 拉取时机:会话切换、回合结束(isProcessing true→false)、以及调用方显式
 * refresh(回滚/还原后)。回合进行中的增量走前端实时消息,不在这里轮询。
 * 拉取失败静默退化为"只用已加载窗口"(即 do 的旧行为)。
 */
export function useSessionWorkFrames(sessionId: string | null, isProcessing: boolean): SessionWorkFramesState {
  const [baseMessages, setBaseMessages] = useState<ChatMessage[]>([]);
  const [revertedPaths, setRevertedPaths] = useState<ReadonlySet<string>>(EMPTY_PATHS);
  const [truncated, setTruncated] = useState(false);
  const [turnOutputs, setTurnOutputs] = useState<Record<string, ServerTurnOutputFile[]>>(EMPTY_TURN_OUTPUTS);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  /**
   * du:请求票据。只比会话 id 不够 —— 同一会话里"回合结束"与"回滚后手动
   * refresh"会连着发两次,先发后到时**旧快照覆盖新快照**,刚回滚掉的产出
   * 文件又冒回面板里,直到下一次 refetch 才消失。票据保证只有最后一次生效。
   */
  const requestSeqRef = useRef(0);

  const refreshFor = useCallback(async (targetSessionId: string) => {
    const ticket = ++requestSeqRef.current;
    try {
      const response = await authenticatedFetch(
        `/api/providers/sessions/${encodeURIComponent(targetSessionId)}/work-frames`,
      );
      if (!response.ok) return;
      const body = (await response.json().catch(() => null)) as {
        data?: {
          frames?: SessionWorkFrame[];
          revertedPaths?: unknown;
          turnOutputs?: unknown;
          truncated?: unknown;
        };
      } | null;
      const frames = body?.data?.frames;
      // 会话在途中被切走(或有更新的请求在飞)→ 丢弃,别把旧快照安上去。
      if (Array.isArray(frames) && sessionRef.current === targetSessionId
        && ticket === requestSeqRef.current) {
        setBaseMessages(workFramesToMessages(frames));
        const raw = body?.data?.revertedPaths;
        setRevertedPaths(Array.isArray(raw)
          ? new Set(raw.filter((entry): entry is string => typeof entry === 'string'))
          : EMPTY_PATHS);
        setTruncated(body?.data?.truncated === true);
        const outputs = body?.data?.turnOutputs;
        const nextTurnOutputs = outputs && typeof outputs === 'object' && !Array.isArray(outputs)
          ? (outputs as Record<string, ServerTurnOutputFile[]>)
          : EMPTY_TURN_OUTPUTS;
        // 服务端是唯一真相:整体替换,不与快照合并(合并会让删掉/回滚的产出赖着不走)。
        setTurnOutputs(nextTurnOutputs);
        writeCachedTurnOutputs(targetSessionId, nextTurnOutputs);
      }
    } catch { /* 拉不到就退化为窗口内折叠 */ }
  }, []);

  const refresh = useCallback(() => {
    const target = sessionRef.current;
    if (target) void refreshFor(target);
  }, [refreshFor]);

  useEffect(() => {
    setBaseMessages([]);
    setRevertedPaths(EMPTY_PATHS);
    setTruncated(false);
    /**
     * ek:产出映射**先用上一次的本地快照顶上**,再等请求覆盖。
     *
     * 清成空的话,刷新页面就是"卡片消失 → 请求回来 → 卡片重新出现"(用户实测)。
     * 快照是同步读的,所以首帧就有;内容一致时用户什么也看不见 —— 这正是目的。
     */
    setTurnOutputs(readCachedTurnOutputs(sessionId) ?? EMPTY_TURN_OUTPUTS);
    if (sessionId) void refreshFor(sessionId);
  }, [sessionId, refreshFor]);

  const wasProcessingRef = useRef(isProcessing);
  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    wasProcessingRef.current = isProcessing;
    if (wasProcessing && !isProcessing && sessionId) {
      void refreshFor(sessionId);
    }
  }, [isProcessing, sessionId, refreshFor]);

  return { baseMessages, revertedPaths, turnOutputs, truncated, refresh };
}
