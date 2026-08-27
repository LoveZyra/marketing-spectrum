interface PrismLogoProps {
  /** Pixel size of the square mark. */
  size?: number;
  /** Render a rounded 8% 绿 tile behind the mark(新体系里基本不用,默认关)。 */
  tile?: boolean;
  className?: string;
}

/**
 * 品牌标记 —— 水彩棱镜(`public/brand/logo.png`)。
 *
 * 一张手绘水彩的玻璃棱镜 + 彩虹色散图,底色透明、明暗两个主题共用同一张,
 * 不分浅/深两份资产。原图 512² 直接压到 256²(约 60KB),自带约 2% 透明边,
 * 所以 56px 满宽摆进图标轨也不顶边框。
 *
 * 注意**下限**:水彩笔触细,低于 48px 会开始糊成一团色,favicon 那种 16–20px
 * 只剩轮廓 —— 真要在标签页里更好认,得另画一版极简标记,而不是继续缩这张。
 * 尺寸完全交给这里的 `size`。
 */
export default function PrismLogo({ size = 32, tile = false, className }: PrismLogoProps) {
  const markSize = tile ? Math.round(size * 0.62) : size;

  const mark = (
    <img
      src="/brand/logo.png"
      width={markSize}
      height={markSize}
      alt=""
      aria-hidden="true"
      className="block select-none"
      draggable={false}
    />
  );

  if (!tile) {
    return <span className={`inline-flex flex-shrink-0 ${className || ''}`}>{mark}</span>;
  }

  return (
    <span
      className={`inline-flex flex-shrink-0 items-center justify-center ${className || ''}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, size * 0.28),
        backgroundColor: 'hsl(var(--primary) / 0.08)',
      }}
    >
      {mark}
    </span>
  );
}
