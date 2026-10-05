/**
 * hm(A3.3):接管终端要用这段对话在 chat 里的权限档位。
 *
 * chat 把档位记在浏览器 localStorage(`permissionMode-<会话 id>`,新会话还没 id 时退回
 * `permissionMode-last-claude`,见 useChatProviderState),服务端没有记录 —— 所以由前端随
 * `init` 一起带上,服务端按白名单与 PRISM_ALLOW_BYPASS_USERS 再过一遍。
 * 读不到(隐私模式、被清)就给 'default'。
 */
export function readChatPermissionMode(sessionId: string | null | undefined, provider = 'claude'): string {
  try {
    const perSession = sessionId ? window.localStorage.getItem(`permissionMode-${sessionId}`) : null;
    const lastForProvider = window.localStorage.getItem(`permissionMode-last-${provider}`);
    const picked = perSession || lastForProvider;
    return typeof picked === 'string' && picked.trim() ? picked.trim() : 'default';
  } catch {
    return 'default';
  }
}
