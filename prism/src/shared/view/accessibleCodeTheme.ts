/**
 * 浅色代码高亮的对比度(可访问性)。
 *
 * oneLight 的注释 / 字符串 / 关键字色在浅底上只有 3.0–3.8:1(注释灰 hsl(230,4%,64%)
 * 在淡紫底上连 3:1 都不到),WCAG AA 正文要 4.5:1。不手挑一套颜色(换主题就又漂了),
 * 而是保留色相、只把亮度往下压,直到对最暗的那块代码底色也 ≥ 4.5:1:语法配色的辨识度不变,
 * 只是整体深一点。
 *
 * 代码块的底色有两种:oneLight 自带的 hsl(230,1%,98%),以及调用方用 customStyle 盖上的
 * `--muted`(三套浅色主题里最暗的是淡紫 hsl(247,68%,95%))。取两者里更暗的做基准。
 */

type Rgb = [number, number, number];

const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
};

const luminance = ([r, g, b]: Rgb): number => {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const HSL_RE = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i;

export const parseHsl = (value: string): [number, number, number] | null => {
  const match = HSL_RE.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** 把一个 hsl() 颜色的亮度压到对 `background` ≥ `target`;已达标的原样返回。 */
export function darkenToContrast(color: string, background: Rgb, target = 4.5): string {
  const parsed = parseHsl(color);
  if (!parsed) return color;
  const [h, s, initialL] = parsed;
  let l = initialL;
  while (l > 0 && contrastRatio(hslToRgb(h, s, l), background) < target) l -= 1;
  return l === initialL ? color : `hsl(${h}, ${s}%, ${l}%)`;
}

/** 三套浅色主题里最暗的代码底色(见文件头)。 */
export const LIGHT_CODE_BACKGROUNDS: Rgb[] = [
  hslToRgb(230, 1, 98),
  hslToRgb(40, 20, 96),
  hslToRgb(247, 68, 95),
];

type StyleMap = Record<string, Record<string, unknown>>;

export function withAccessibleContrast(style: StyleMap, backgrounds: Rgb[] = LIGHT_CODE_BACKGROUNDS): StyleMap {
  const darkest = backgrounds.reduce((worst, bg) => (luminance(bg) < luminance(worst) ? bg : worst));
  const out: StyleMap = {};
  for (const [selector, rules] of Object.entries(style)) {
    const color = rules.color;
    out[selector] = typeof color === 'string' ? { ...rules, color: darkenToContrast(color, darkest) } : rules;
  }
  return out;
}
