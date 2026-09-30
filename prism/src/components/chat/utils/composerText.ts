import i18next from 'i18next';

/**
 * hl(09-24 静态 P3 / 动态 P3 中英混排):输入框状态机里的提示文案走 i18n。
 *
 * useChatComposerState 里有约 40 处写死的中文(发送失败、附件超限、排队退回……),
 * en 界面下照样弹中文。这些文案都是在**事件发生那一刻**拼出来的,用全局 i18next 实例
 * 现取当前语言即可 —— 不必把 `t` 塞进几十个 useCallback 的依赖表。
 *
 * `fallback` 是已插好值的中文原句:i18next 还没初始化(单测、极早期)时原样返回,
 * 与改造前的行为逐字一致。键都在 chat 命名空间的 `composer.notice.*` 下。
 */
export function composerText(key: string, fallback: string, vars: Record<string, unknown> = {}): string {
  if (!i18next.isInitialized) return fallback;
  const value = i18next.t(`chat:composer.notice.${key}`, { ...vars, defaultValue: fallback });
  return typeof value === 'string' && value ? value : fallback;
}
