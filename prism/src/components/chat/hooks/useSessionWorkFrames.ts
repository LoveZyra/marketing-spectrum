import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import {
  turnMarkerMessage,
  workFramesRequestHeaders,
  workFramesToMessages,
  type SessionWorkFrame,
  type WorkFramesValidator,
} from '../utils/workFrames';
import type { ServerTurnOutputFile } from '../utils/turnOutputs';
import { readCachedTurnOutputs, writeCachedTurnOutputs } from '../utils/turnOutputsCache';
import type { ChatMessage } from '../types/types';

export type SessionWorkFramesState = {
  /** 服务端全量历史滤出的工具帧,已转成伪 ChatMessage(工作面板基线)。 */
  baseMessages: ChatMessage[];
  /**
   * 仍处于"已回滚"状态的绝对路径。基线里的产出帧服务端已删,
   * 但前端窗口里的旧 Write 工具帧会把文件加回来,产出折叠完要用它做最终减法;
   * 回滚后重写的文件不在此集合(服务端时序折叠已处理)。
   */
  revertedPaths: ReadonlySet<string>;
  /**
   * 助手回答的消息 id → 这一轮写出来的文件。服务端按全量历史算好,随消息一起到达,
   * 此后不再变,是对话正文下面那张「产出」卡的正本。
   *
   * 不能由前端从当前加载到的消息窗口现推:窗口起点常落在某一轮工具流中间,
   * 推出来的结果会随加载进度变化。
   */
  turnOutputs: Record<string, ServerTurnOutputFile[]>;
  /**
   * 服务端帧数触顶,较早的工作帧没随本次响应下发:面板要如实说明
   * "更早的记录未载入",而不是装作这就是全部。
   */
  truncated: boolean;
  /** 服务端抽中的「效果如何」卡:助手回答 id → 本轮调用的 skill。 */
  skillSurveys: ReadonlyMap<string, string>;
  /** 手动重拉基线(回滚/还原成功后调,拿到含反向帧的新快照)。 */
  refresh: () => void;
};

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const EMPTY_TURN_OUTPUTS: Record<string, ServerTurnOutputFile[]> = {};
const EMPTY_SURVEYS: ReadonlyMap<string, string> = new Map();

/**
 * 工作面板的服务端基线。
 *
 * 拉取时机:会话切换、回合结束(isProcessing true→false)、以及调用方显式
 * refresh(回滚/还原后)。回合进行中的增量走前端实时消息,不在这里轮询。
 * 拉取失败静默退化为"只用已加载窗口"。
 *
 * 同一会话重取时带上次落地那份的 ETag;服务端回 304 就什么都不动:不重新解析,
 * 也不重设状态(清单 / 产出的折叠跟着这些状态,重设一次就要整份重折)。
 */
export function useSessionWorkFrames(sessionId: string | null, isProcessing: boolean): SessionWorkFramesState {
  const [baseMessages, setBaseMessages] = useState<ChatMessage[]>([]);
  const [revertedPaths, setRevertedPaths] = useState<ReadonlySet<string>>(EMPTY_PATHS);
  const [truncated, setTruncated] = useState(false);
  const [turnOutputs, setTurnOutputs] = useState<Record<string, ServerTurnOutputFile[]>>(EMPTY_TURN_OUTPUTS);
  const [skillSurveys, setSkillSurveys] = useState<ReadonlyMap<string, string>>(EMPTY_SURVEYS);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  /**
   * 请求票据。只比会话 id 不够:同一会话里"回合结束"与"回滚后手动 refresh"会连着发两次,
   * 先发后到时旧快照会覆盖新快照,刚回滚掉的产出文件又冒回面板。票据保证只有最后一次生效。
   */
  const requestSeqRef = useRef(0);
  /**
   * 当前状态对应的那份响应的 ETag。只在响应真正落地时记、切会话清空状态时一起清:
   * 被票据作废的响应不落地,它的 ETag 也不能记,否则 304 会把没显示过的那份当成手里这份。
   */
  const validatorRef = useRef<WorkFramesValidator | null>(null);

  const refreshFor = useCallback(async (targetSessionId: string) => {
    const ticket = ++requestSeqRef.current;
    try {
      const response = await authenticatedFetch(
        `/api/providers/sessions/${encodeURIComponent(targetSessionId)}/work-frames`,
        { headers: workFramesRequestHeaders(validatorRef.current, targetSessionId) },
      );
      // 304:手里这份就是最新的(请求发出时状态就是这份,之后能改状态的只有更新的票据)。
      if (response.status === 304) return;
      if (!response.ok) return;
      const body = (await response.json().catch(() => null)) as {
        data?: {
          frames?: SessionWorkFrame[];
          revertedPaths?: unknown;
          turnOutputs?: unknown;
          truncated?: unknown;
          skillSurveys?: unknown;
          userTurns?: unknown;
        };
      } | null;
      const frames = body?.data?.frames;
      // 会话在途中被切走(或有更新的请求在飞)→ 丢弃,别把旧快照安上去。
      if (Array.isArray(frames) && sessionRef.current === targetSessionId
        && ticket === requestSeqRef.current) {
        const etag = response.headers.get('ETag');
        validatorRef.current = etag ? { sessionId: targetSessionId, etag } : null;
        // 基线末尾接一条回合号标记(见 turnMarkerMessage)
        setBaseMessages([...workFramesToMessages(frames), ...turnMarkerMessage(body?.data?.userTurns)]);
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
        const surveys = body?.data?.skillSurveys;
        setSkillSurveys(Array.isArray(surveys)
          ? new Map(surveys
            .filter((entry): entry is { messageId: string; skill: string } =>
              Boolean(entry) && typeof (entry as { messageId?: unknown }).messageId === 'string' && typeof (entry as { skill?: unknown }).skill === 'string')
            .map((entry) => [entry.messageId, entry.skill]))
          : EMPTY_SURVEYS);
      }
    } catch { /* 拉不到就退化为窗口内折叠 */ }
  }, []);

  const refresh = useCallback(() => {
    const target = sessionRef.current;
    if (target) void refreshFor(target);
  }, [refreshFor]);

  useEffect(() => {
    validatorRef.current = null;
    setBaseMessages([]);
    setRevertedPaths(EMPTY_PATHS);
    setTruncated(false);
    setSkillSurveys(EMPTY_SURVEYS);
    /**
     * 产出映射先用上一次的本地快照顶上,再等请求覆盖。
     *
     * 清成空的话,刷新页面就是"卡片消失 → 请求回来 → 卡片重新出现"。
     * 快照是同步读的,首帧就有;内容一致时用户什么也看不见,这正是目的。
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

  return { baseMessages, revertedPaths, turnOutputs, truncated, skillSurveys, refresh };
}
