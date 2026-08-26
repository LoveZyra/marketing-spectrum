interface PrismLogoProps {
  /** Pixel size of the square mark. */
  size?: number;
  /** Render a rounded 8% 绿 tile behind the mark(新体系里基本不用,默认关)。 */
  tile?: boolean;
  className?: string;
}

/**
 * 品牌标记 —— 棱镜彩虹图(`public/brand/logo.png`)。
 *
 * 这是一张自发光的玻璃棱镜 + 彩虹光带图,底色透明、明暗两个主题下都读得清,
 * 所以**明暗共用同一张图**,不再分浅/深两份资产。原图 1254² 已裁掉透明边、
 * 居中放进正方形并压到 256²(约 60KB),≤72px 展示位在 2×/3× 屏下都够清晰。
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
