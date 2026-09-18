/**
 * gk:「这条会话已被删除」态的判据与信息。
 *
 * 两条路会把一条会话变成这个态:
 *   1. 服务端推的 `session_removed`(别处永久删除了它,已进最近删除);
 *   2. `chat.send` 收到 `SESSION_NOT_FOUND` —— 页面开着的时候行没了(2026-09-14 生产的
 *      那张截图:同一句英文报错出现两次,还给了一个只会再撞一次的「重发上一条」)。
 *
 * 只对 `request === 'chat.send'` 的 `SESSION_NOT_FOUND` 切态:同一个 code 在
 * permission-response 上的意思是"没这条待批",不是会话没了。
 */

export type SessionRemovedReason = 'deleted' | 'project_deleted' | 'not_found';

export type SessionRemovedInfo = {
  reason: SessionRemovedReason;
  deletedBy: string | null;
  sessionName: string | null;
  restorable: boolean;
  at: string;
  /**
   * 切态时挂在这条会话上的**排队消息正文**(有的话)。
   *
   * 切态会把排队记录清掉(否则后台续发会一直给一条不存在的会话起新轮),
   * 而那句话是用户亲手打的:回合跑着的时候打一句回车 → 进排队卡 → 这时别人把会话删了。
   * 不带出来的话它在盘上和内存里同时消失,「新建会话继续」也带不走 ——
   * 说明卡上那句"你刚才输入的内容还在"只对输入框里的字成立,对排队的那条是假的。
   */
  queuedText: string | null;
};

type ProtocolErrorLike = {
  code?: unknown;
  request?: unknown;
};

/** `chat.send` 撞到"会话不存在"—— 只有这一种 protocol_error 算"会话已被删除"。 */
export function isSessionGoneProtocolError(message: ProtocolErrorLike): boolean {
  return message.code === 'SESSION_NOT_FOUND' && message.request === 'chat.send';
}

type SessionRemovedFrameLike = {
  reason?: unknown;
  deletedBy?: unknown;
  sessionName?: unknown;
  restorable?: unknown;
  timestamp?: unknown;
};

export function removedInfoFromFrame(frame: SessionRemovedFrameLike, queuedText: string | null = null): SessionRemovedInfo {
  return {
    reason: frame.reason === 'project_deleted' ? 'project_deleted' : 'deleted',
    deletedBy: typeof frame.deletedBy === 'string' && frame.deletedBy ? frame.deletedBy : null,
    sessionName: typeof frame.sessionName === 'string' && frame.sessionName ? frame.sessionName : null,
    restorable: frame.restorable !== false,
    at: typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString(),
    queuedText: queuedText?.trim() ? queuedText : null,
  };
}

export function removedInfoFromNotFound(queuedText: string | null = null): SessionRemovedInfo {
  return {
    reason: 'not_found',
    deletedBy: null,
    sessionName: null,
    // 行没了但很可能在最近删除里(gk 起永久删除都进回收站);拿不准就说"可能"。
    restorable: true,
    at: new Date().toISOString(),
    queuedText: queuedText?.trim() ? queuedText : null,
  };
}

/**
 * 切「已被删除」态之前,把盘上那条排队消息的正文取出来再清掉。
 * 读失败(隐私模式、存储被禁)时返回 null —— 这条路不能因为读存储把整帧带崩。
 */
export function takeQueuedTextForRemoval(
  sessionId: string,
  read: (sessionId: string) => { content?: unknown } | null,
  clear: (sessionId: string) => void,
): string | null {
  let text: string | null = null;
  try {
    const stored = read(sessionId);
    const content = typeof stored?.content === 'string' ? stored.content : '';
    text = content.trim() ? content : null;
  } catch {
    text = null;
  }
  try {
    clear(sessionId);
  } catch {
    // 清不掉也要继续切态;后台续发那条路自己有次数上限。
  }
  return text;
}

/**
 * 「新建会话继续」要把没发出去的那段话带过去。
 * 新建会话页的草稿键是项目键(见 composerDrafts.ts 的 draftStorageKey),
 * 写进去之后换草稿 effect 会自己把它恢复到输入框。
 */
export function carryDraftKey(projectId: string | null | undefined): string | null {
  return projectId ? `draft_input_${projectId}` : null;
}
