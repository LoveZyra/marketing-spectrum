/**
 * 数字输入框的取值规则(纯函数,`NumberInput` 与测试共用)。
 *
 * 打字时只认文字,能读成数就把这个数(不夹取)交给上层;离开输入框时再夹到 [min, max]、
 * 按需取整、把文字规范化;空着离开 → 允许空就交 `null`,否则回到 `fallback`。
 * 边打边改写会出错:删掉 "1" 时空串被立刻改回 1(「删不掉那个 1」,再敲 3 成了 "13"),
 * 边打边夹取也会乱跳(小时框里 9 后面敲 1 → "91" → 被夹成 23)。
 */
export type NumberRule = {
  min?: number;
  max?: number;
  /** 只要整数(轮数、分钟、门槛之类) */
  integer?: boolean;
  /** 空着离开时:true → 交 null(表单用 placeholder 的默认值);false → 回到 fallback */
  allowEmpty?: boolean;
  /** 不允许空时,空着离开 / 读不出数时用它(默认 min ?? 0) */
  fallback?: number;
};

/** 打字过程中:这段文字现在能不能当一个数交出去(不夹取)。"" / "-" / "1." / "abc" → null */
export function parseTyping(text: string): number | null {
  const s = text.trim();
  if (s === '' || s === '-' || s === '.' || s === '-.') return null;
  if (!/^-?\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 离开输入框:最终的数(或 null)与规范化后的文字。 */
export function commitNumber(text: string, rule: NumberRule): { value: number | null; text: string } {
  const parsed = parseTyping(text);
  if (parsed === null) {
    if (rule.allowEmpty) return { value: null, text: '' };
    const fb = rule.fallback ?? rule.min ?? 0;
    return { value: fb, text: String(fb) };
  }
  let n = rule.integer ? Math.round(parsed) : parsed;
  if (rule.min !== undefined && n < rule.min) n = rule.min;
  if (rule.max !== undefined && n > rule.max) n = rule.max;
  // 0.1 + 0.2 之类的浮点尾巴不带进文字
  const shown = rule.integer ? String(n) : String(Number(n.toFixed(6)));
  return { value: rule.integer ? n : Number(shown), text: shown };
}

/**
 * ↑/↓ 步进的起点。
 *
 * 空框(可留空、用 placeholder 显示默认值)从 placeholder 里显示的那个默认值起步,
 * 「默认 8 轮」的空框按一下 ↑ 得 9;placeholder 读不出数才退回 fallback / min / 0
 * (这类框通常不传 fallback,直接从 min 起会得到 1)。
 */
export function stepNumber(
  text: string,
  value: number | null,
  delta: number,
  rule: NumberRule & { placeholder?: string },
): { value: number | null; text: string } {
  const typed = parseTyping(text);
  const placeholderDefault = typeof rule.placeholder === 'string' ? parseTyping(rule.placeholder) : null;
  const base = typed ?? value ?? placeholderDefault ?? rule.fallback ?? rule.min ?? 0;
  return commitNumber(String(base + delta), { ...rule, allowEmpty: false });
}
