import { useId } from 'react';

interface PrismLogoProps {
  /** Pixel size of the square mark. */
  size?: number;
  /** Render the rounded gradient tile behind the prism mark. */
  tile?: boolean;
  className?: string;
}

/**
 * Prism brand mark: a light beam entering a triangular prism and leaving as
 * a color spectrum. Pure SVG, no external assets; gradient ids are scoped
 * via useId so multiple instances can coexist.
 */
export default function PrismLogo({ size = 28, tile = true, className }: PrismLogoProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const tileGradient = `prism-tile-${uid}`;

  const mark = (
    <svg
      width={tile ? size * 0.62 : size}
      height={tile ? size * 0.62 : size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {/* incoming beam */}
      <line x1="1" y1="12.5" x2="8.6" y2="12.5" stroke={tile ? 'rgba(255,255,255,0.95)' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" />
      {/* prism triangle */}
      <polygon
        points="12,4.5 19.5,19 4.5,19"
        stroke={tile ? '#ffffff' : 'currentColor'}
        strokeWidth="1.9"
        strokeLinejoin="round"
        fill={tile ? 'rgba(255,255,255,0.14)' : 'none'}
      />
      {/* spectrum rays */}
      <line x1="15.6" y1="13.2" x2="23" y2="9.4" stroke="#f0abfc" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="16.2" y1="14.6" x2="23" y2="13.2" stroke="#67e8f9" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="16.6" y1="16" x2="23" y2="17" stroke="#6ee7b7" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );

  if (!tile) {
    return <span className={className}>{mark}</span>;
  }

  return (
    <span
      className={`inline-flex flex-shrink-0 items-center justify-center shadow-sm ${className || ''}`}
      style={{ width: size, height: size, borderRadius: Math.max(6, size * 0.28) }}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id={tileGradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="55%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx={Math.max(6, size * 0.28) * (32 / size)} fill={`url(#${tileGradient})`} />
      </svg>
      <span style={{ position: 'relative', display: 'inline-flex' }}>{mark}</span>
    </span>
  );
}
