interface PrismLogoProps {
  /** Pixel size of the square mark. */
  size?: number;
  /** Render a rounded 8% 绿 tile behind the mark(新体系里基本不用,默认关)。 */
  tile?: boolean;
  className?: string;
}

/**
 * 品牌标记 —— `design_handoff_prism_ui/数据查询.svg`,矢量原图直接用。
 *
 * 换成 SVG 是为了清晰度:原来的两张 PNG 在 2× 屏与放大尺寸下都会糊,
 * 矢量在任何倍率下都是实边。写死的 `width/height="200"` 已经在资产里去掉,
 * 尺寸完全交给这里的 `size`。
 *
 * 明暗仍然是两份资产,但**不是两张图** —— 深色那份只把线稿的板岩灰
 * `#495460` 提亮到 `#93A3B1`,形状一笔没动。原色压在近黑画布上只有 2.6:1,
 * 整张纸的轮廓基本看不见;提亮后约 5.9:1,读起来才是同一张图。
 */
export default function PrismLogo({ size = 32, tile = false, className }: PrismLogoProps) {
  const markSize = tile ? Math.round(size * 0.62) : size;

  const mark = (
    <>
      <img
        src="/brand/logo.svg"
        width={markSize}
        height={markSize}
        alt=""
        aria-hidden="true"
        className="block select-none dark:hidden"
        draggable={false}
      />
      <img
        src="/brand/logo-dark.svg"
        width={markSize}
        height={markSize}
        alt=""
        aria-hidden="true"
        className="hidden select-none dark:block"
        draggable={false}
      />
    </>
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
