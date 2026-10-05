import { detectModelVendor, getModelVendor, modelInitial } from '../../../shared/modelVendors';

type ModelVendorIconProps = {
  /** 目录里存的厂商(root 手动指定的优先);空 = 按 `modelId` 自动识别。 */
  vendor?: string | null;
  /** 网关模型名 —— 认厂商用;也是首字母徽标的兜底来源。 */
  modelId?: string | null;
  /** 首字母徽标取字的来源(认不出厂商时);缺省用 `modelId`。 */
  label?: string | null;
  /** 边长(px)。 */
  size?: number;
  className?: string;
};

/**
 * hn(B6):模型厂商图标。图来自 `@lobehub/icons-static-svg` 1.95.1(MIT,见 NOTICE),拷在 `public/model-icons/`。
 *
 * - **彩色**图直接 `<img>`;
 * - **单色**图(`fill="currentColor"`)用 CSS mask + `bg-current`,颜色跟着文字色走 —— `<img>` 拿不到 currentColor,
 *   深色主题下会是一块黑(与 `PrismWordmark` 同法);
 * - 认不出厂商 → 首字母徽标。
 */
export default function ModelVendorIcon({ vendor, modelId, label, size = 16, className = '' }: ModelVendorIconProps) {
  const info = getModelVendor(vendor) ?? getModelVendor(detectModelVendor(modelId));
  const box = { width: size, height: size };

  if (!info) {
    return (
      <span
        aria-hidden
        className={`inline-grid shrink-0 place-items-center rounded-[4px] border border-border bg-muted font-semibold leading-none text-muted-foreground ${className}`}
        style={{ ...box, fontSize: Math.max(8, Math.round(size * 0.6)) }}
      >
        {modelInitial(label || modelId)}
      </span>
    );
  }

  const src = `/model-icons/${info.icon}`;
  if (info.mono) {
    const mask = `url(${src})`;
    return (
      <span
        role="img"
        aria-label={info.label}
        className={`inline-block shrink-0 bg-current ${className}`}
        style={{
          ...box,
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
  return <img src={src} alt={info.label} width={size} height={size} draggable={false} className={`inline-block shrink-0 ${className}`} style={box} />;
}
