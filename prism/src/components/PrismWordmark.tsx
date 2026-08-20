/** 字标原图的宽高比(裁到内容边界后的 406 × 198)。 */
const WORDMARK_RATIO = 406 / 198;

interface PrismWordmarkProps {
  /** 字标高度(px)。按文字的视觉高度给,例如侧栏顶部是 19。 */
  height?: number;
  className?: string;
}

/**
 * 「棱镜」字标 —— 用的是设计目录里那张字形图。
 *
 * 不用 `<img>` 而是 **CSS mask + `currentColor`**:原图是纯黑字形,直接贴上去
 * 在深色画布上等于隐形。走遮罩之后颜色跟着文字色走,明暗两版自动各就各位,
 * 也省掉了再做一张白色版资产。
 */
export default function PrismWordmark({ height = 19, className }: PrismWordmarkProps) {
  const mask = 'url(/brand/wordmark.png)';

  return (
    <span
      role="img"
      aria-label="棱镜"
      className={`inline-block flex-shrink-0 bg-current align-middle ${className || ''}`}
      style={{
        height,
        width: Math.round(height * WORDMARK_RATIO),
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: '100% 100%',
        WebkitMaskSize: '100% 100%',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
      }}
    />
  );
}
