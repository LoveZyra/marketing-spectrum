import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme, UI_THEMES, type UiTheme } from '../../../contexts/ThemeContext';
import { cn } from '../../../lib/utils';

/**
 * 三套界面主题的选择器。
 *
 * 每张卡片带一枚**按该主题实色画的**缩略预览 —— 不能用 CSS 变量,
 * 变量拿到的永远是当前主题。所以这里的颜色是照着 `index.css` 三段 token
 * 写死的字面值,改 token 时记得同步这一处(只有这一处)。
 */

type Swatch = {
  canvas: string;
  texture?: string;
  textureSize?: string;
  rail: string;
  line: string;
  panel: string;
  panelShadow: string;
  accent: string;
  dotRadius: string;
  bar?: string;
};

const SWATCHES: Record<UiTheme, Swatch> = {
  blueprint: {
    canvas: '#fbfaf8',
    texture: 'radial-gradient(rgba(70,58,120,.10) 1px, transparent 1px)',
    textureSize: '8px 8px',
    rail: '#fbfaf8',
    line: '#e6e2da',
    panel: '#ffffff',
    panelShadow: 'inset 0 0 0 1px #e6e2da',
    accent: '#5b3df5',
    dotRadius: '0px',
  },
  glass: {
    canvas: '#f6f6fb',
    texture:
      'radial-gradient(120% 80% at 82% -10%, rgba(120,88,255,.20), transparent 60%), radial-gradient(90% 70% at -6% 106%, rgba(34,211,238,.16), transparent 62%)',
    textureSize: '100% 100%, 100% 100%',
    rail: 'rgba(255,255,255,.62)',
    line: 'rgba(102,74,200,.14)',
    panel: 'rgba(255,255,255,.86)',
    panelShadow: '0 0 0 1px rgba(102,74,200,.10), 0 8px 18px -12px rgba(46,32,96,.7)',
    accent: '#6d4aff',
    dotRadius: '999px',
    bar: 'linear-gradient(90deg,#6d4aff,#a855f7 32%,#22d3ee 68%,#6d4aff)',
  },
  dark: {
    canvas: '#050607',
    texture:
      'linear-gradient(rgba(0,217,146,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(0,217,146,.06) 1px, transparent 1px)',
    textureSize: '9px 9px, 9px 9px',
    rail: '#050607',
    line: '#042820',
    panel: '#0a100e',
    panelShadow: 'inset 0 0 0 1px rgba(0,217,146,.16)',
    accent: '#00d992',
    dotRadius: '999px',
  },
};

const FALLBACK: Record<UiTheme, { name: string; description: string }> = {
  blueprint: { name: '纸构蓝图', description: '暖白纸底、发丝线分区、零投影' },
  glass: { name: '棱光玻璃', description: '冷白玻璃面板、柔光层级、分光强调' },
  dark: { name: '霓虹终端', description: '近黑画布、点阵栅格、强调色发光' },
};

function ThemeSwatch({ theme }: { theme: UiTheme }) {
  const s = SWATCHES[theme];

  return (
    <div
      className="relative h-[74px] w-full overflow-hidden rounded-[5px]"
      style={{
        background: s.canvas,
        backgroundImage: s.texture,
        backgroundSize: s.textureSize,
        boxShadow: `inset 0 0 0 1px ${s.line}`,
      }}
      aria-hidden
    >
      {s.bar && <div className="absolute inset-x-0 top-0 h-[2px]" style={{ background: s.bar }} />}

      {/* 轨 + 侧栏 + 主区,和真实布局同构 */}
      <div className="absolute inset-0 flex">
        <div
          className="flex w-[13px] flex-col items-center gap-[3px] pt-[7px]"
          style={{ background: s.rail, borderRight: `1px solid ${s.line}` }}
        >
          <span className="h-[5px] w-[5px] rounded-[1px]" style={{ background: s.accent }} />
          <span className="h-[5px] w-[5px] rounded-[1px]" style={{ background: s.line }} />
          <span className="h-[5px] w-[5px] rounded-[1px]" style={{ background: s.line }} />
        </div>

        <div className="flex w-[34px] flex-col gap-[4px] p-[6px]" style={{ borderRight: `1px solid ${s.line}` }}>
          <span className="h-[4px] w-full rounded-[2px]" style={{ background: s.line }} />
          <span className="h-[4px] w-[70%] rounded-[2px]" style={{ background: s.line }} />
          <span className="h-[4px] w-full rounded-[2px]" style={{ background: s.accent, opacity: 0.85 }} />
          <span className="h-[4px] w-[55%] rounded-[2px]" style={{ background: s.line }} />
        </div>

        <div className="flex flex-1 flex-col justify-between p-[7px]">
          <div className="rounded-[3px] p-[5px]" style={{ background: s.panel, boxShadow: s.panelShadow }}>
            <span className="mb-[3px] flex items-center gap-[3px]">
              <span
                className="h-[3px] w-[3px]"
                style={{ background: s.accent, borderRadius: s.dotRadius }}
              />
              <span className="h-[3px] w-2/5 rounded-[2px]" style={{ background: s.line }} />
            </span>
            <span className="block h-[3px] w-[85%] rounded-[2px]" style={{ background: s.line }} />
          </div>
          <div className="h-[12px] rounded-[3px]" style={{ background: s.panel, boxShadow: s.panelShadow }} />
        </div>
      </div>
    </div>
  );
}

export default function ThemePicker() {
  const { t } = useTranslation('settings');
  const { uiTheme, setUiTheme } = useTheme();

  return (
    <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
      {UI_THEMES.map((theme) => {
        const isActive = uiTheme === theme;
        return (
          <button
            key={theme}
            type="button"
            onClick={() => setUiTheme(theme)}
            aria-pressed={isActive}
            className={cn(
              'group/theme relative flex flex-col gap-2.5 rounded-md border p-2.5 text-left',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              isActive
                ? 'border-primary bg-accent'
                : 'border-border bg-card hover:border-border-strong',
            )}
          >
            <ThemeSwatch theme={theme} />

            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {t(`appearanceSettings.uiTheme.options.${theme}.name`, {
                    defaultValue: FALLBACK[theme].name,
                  })}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {t(`appearanceSettings.uiTheme.options.${theme}.description`, {
                    defaultValue: FALLBACK[theme].description,
                  })}
                </span>
              </span>

              {isActive && (
                <Check className="mt-0.5 h-4 w-4 flex-none text-primary" strokeWidth={2.5} aria-hidden />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
