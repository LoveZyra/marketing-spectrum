import i18next from 'i18next';

/**
 * hl(动态 P3 中英混排,切片 D 转来):lib 里的校验 / 打包报错不在组件里,拿不到 `t`;
 * 照 `chat/utils/composerText.ts` 的做法用全局 i18next 现取当前语言。
 *
 * `key` 写全 `skillwhet:…`(字面量,死键检查认得);`fallback` 是带 `{{var}}` 的中文原句 ——
 * i18next 还没初始化(单测、极早期)时就地插值后返回,与改造前逐字一致。
 */
export function swText(key: string, fallback: string, vars: Record<string, unknown> = {}): string {
  if (!i18next.isInitialized) {
    return fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ''));
  }
  const value = i18next.t(key, { ...vars, defaultValue: fallback, interpolation: { escapeValue: false } });
  return typeof value === 'string' && value ? value : fallback;
}
