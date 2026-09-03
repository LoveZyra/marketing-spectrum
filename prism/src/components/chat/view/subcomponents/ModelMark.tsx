import type { SVGProps } from 'react';

/**
 * ee:模型芯片的标记 —— 参考用户给的三色六边形拼块,重画成与 lucide 同一套笔画的
 * 线图标(24 视窗、2px 描边、圆角、currentColor):三个六边形按参考图的位置成簇
 * (左上 / 右 / 左下),14px 下仍能看出是三块,不像位图那样糊成一团,也随主题变色。
 */
export default function ModelMark({ className = 'h-3.5 w-3.5', ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
      {...props}
    >
      <path d="M12.80 6.60L10.70 10.24L6.50 10.24L4.40 6.60L6.50 2.96L10.70 2.96Z" />
      <path d="M21.40 12.00L19.30 15.64L15.10 15.64L13.00 12.00L15.10 8.36L19.30 8.36Z" />
      <path d="M12.80 17.40L10.70 21.04L6.50 21.04L4.40 17.40L6.50 13.76L10.70 13.76Z" />
    </svg>
  );
}
