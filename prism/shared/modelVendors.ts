/**
 * 模型目录的共用规则:服务端(目录校验、下发厂商)与前端(选择器图标、设置页)同一份。
 *
 * 纯函数、零依赖;放在仓库根的 shared/,两棵树都能 import。
 */

export type ModelVendorId =
  | 'claude' | 'gpt' | 'gemini' | 'grok' | 'glm' | 'deepseek' | 'qwen' | 'kimi' | 'doubao';

export type ModelVendorInfo = {
  id: ModelVendorId;
  /** 分组标题 / 图标旁的名字 */
  label: string;
  /** public/model-icons/ 下的文件名(来自 @lobehub/icons-static-svg 1.95.1,MIT) */
  icon: string;
  /**
   * 单色图(`fill="currentColor"`):用 CSS mask + currentColor 画,跟随主题文字色;
   * 彩色图直接 `<img>`。`<img>` 拿不到 currentColor,单色图在深色主题下会是一块黑。
   */
  mono: boolean;
};

/**
 * 9 家,顺序即分组顺序。
 * 自动识别见 `detectModelVendor` —— 那边另有自己的匹配顺序(先匹配先得)。
 */
export const MODEL_VENDORS: readonly ModelVendorInfo[] = Object.freeze([
  { id: 'claude', label: 'Claude', icon: 'claude-color.svg', mono: false },
  { id: 'gpt', label: 'GPT', icon: 'openai.svg', mono: true },
  { id: 'gemini', label: 'Gemini', icon: 'gemini-color.svg', mono: false },
  { id: 'grok', label: 'Grok', icon: 'grok.svg', mono: true },
  { id: 'glm', label: 'GLM', icon: 'zai.svg', mono: true },
  { id: 'deepseek', label: 'DeepSeek', icon: 'deepseek-color.svg', mono: false },
  { id: 'qwen', label: 'Qwen', icon: 'qwen-color.svg', mono: false },
  // 彩色版 kimi-color.svg 主字形是白色(给深色圆底用的),浅色主题下看不见 → 用单色版
  { id: 'kimi', label: 'Kimi', icon: 'kimi.svg', mono: true },
  { id: 'doubao', label: '豆包', icon: 'doubao-color.svg', mono: false },
]);

const VENDOR_BY_ID = new Map<string, ModelVendorInfo>(MODEL_VENDORS.map((vendor) => [vendor.id, vendor]));

export function getModelVendor(id: string | null | undefined): ModelVendorInfo | null {
  return id ? VENDOR_BY_ID.get(id) ?? null : null;
}

/**
 * 按模型名猜厂商 —— 规则取自 LobeHub 的 modelConfig,只留这 9 家。
 *
 * 不分大小写、按下面的顺序先匹配先得:`DeepSeek-R1-Distill-Qwen-32B` 这类名字里两家都有,
 * 靠顺序归到 DeepSeek(蒸馏的是 Qwen 的底座,但出品的是 DeepSeek)。
 * `^o\d(-|$)`:o1 / o3 / o4-mini 这类 OpenAI 推理模型;v2 的 `^o[134]-` 匹配不到单独的 `o3`。
 * 认不出来返回 null(前端画首字母徽标;root 可在目录里手动指定)。
 */
const VENDOR_RULES: ReadonlyArray<[ModelVendorId, RegExp]> = [
  ['claude', /claude/],
  ['deepseek', /deepseek/],
  ['qwen', /qwen|qwq|qvq|tongyi/],
  ['kimi', /kimi|moonshot/],
  ['glm', /glm|zhipu|chatglm/],
  ['doubao', /doubao|^ep-/],
  ['gemini', /gemini/],
  ['grok', /^grok|\/grok/],
  ['gpt', /^gpt-|\/gpt-|^o\d(-|$)|\/o\d(-|$)|openai/],
];

export function detectModelVendor(modelId: string | null | undefined): ModelVendorId | null {
  const name = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (!name) return null;
  for (const [vendor, pattern] of VENDOR_RULES) {
    if (pattern.test(name)) return vendor;
  }
  return null;
}

/**
 * 网关模型名的字符集 —— 与 SkillWhet 0.5.3 的 `_model_ok` 对齐:
 * 字母数字开头(不能以 `-` 开头,否则会被当成下一个命令行参数),其后允许 `. _ : / @ - [ ]`,≤ 80 字符。
 */
export const MODEL_ID_MAX_LENGTH = 80;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@\-[\]]*$/;

export function isValidModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MODEL_ID_MAX_LENGTH
    && MODEL_ID_PATTERN.test(value);
}

/**
 * 目录里能填的最小窗口 —— CLI 的 `autoCompactWindow` 下限就是 100000(低于它 CLI 静默忽略),
 * 而 Claude Code 自己的系统提示与工具定义就要占去一两万,再扣压缩余量 33000,
 * 更小的窗口在这里根本跑不起来。
 */
export const CONTEXT_WINDOW_MIN = 100_000;
export const CONTEXT_WINDOW_MAX = 10_000_000;
/** CLI 的自动压缩触发线 = 有效窗口 − 这么多(200000 → 167000、128000 → 95000)。 */
export const AUTO_COMPACT_MARGIN = 33_000;

/** `128000` → `128K`,`1000000` → `1M`(选择器上的窗口角标)。 */
export function formatContextWindow(tokens: number | null | undefined): string | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** 首字母徽标用的那个字(认不出厂商时)。 */
export function modelInitial(label: string | null | undefined): string {
  const text = typeof label === 'string' ? label.trim() : '';
  const first = text.match(/[A-Za-z0-9一-鿿]/u)?.[0] ?? '?';
  return first.toUpperCase();
}
