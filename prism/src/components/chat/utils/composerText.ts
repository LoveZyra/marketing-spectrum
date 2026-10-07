import i18next from 'i18next';

/**
 * 聊天里纯函数拼出来的界面文案(工具行计量、清单兜底名、排队作废提示……)按当前语言取词。
 *
 * 这些文案在事件发生那一刻、或渲染时才拼出来,直接用全局 i18next 实例取当前语言即可,
 * 不必把 `t` 一路传进纯函数,也不必塞进几十个 useCallback 的依赖表。
 *
 * `key` 是 chat 命名空间里的键;`fallback` 是已插好值的中文原句:i18next 尚未初始化
 * (单测、极早期)时原样返回。
 */
export function chatText(key: string, fallback: string, vars: Record<string, unknown> = {}): string {
  if (!i18next.isInitialized) return fallback;
  const value = i18next.t(`chat:${key}`, { ...vars, defaultValue: fallback });
  return typeof value === 'string' && value ? value : fallback;
}

/** 输入框状态机里的提示文案(发送失败、附件超限、排队退回……),键都在 `composer.notice.*` 下。 */
export function composerText(key: string, fallback: string, vars: Record<string, unknown> = {}): string {
  return chatText(`composer.notice.${key}`, fallback, vars);
}
