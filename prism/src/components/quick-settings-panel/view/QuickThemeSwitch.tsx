import { FileText, Layers, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme, UI_THEMES, type UiTheme } from '../../../contexts/ThemeContext';
import { cn } from '../../../lib/utils';

/**
 * 快速设置面板里的主题切换 —— 一个三档分段控件。
 *
 * 这里原来是一枚「深色模式」开关。浅色分成两种材质之后开关表达不了三个值,
 * 而快速面板的空间又放不下设置页那种带预览的卡片,所以收成图标 + 短名的分段控件。
 */

const ICONS: Record<UiTheme, typeof FileText> = {
  blueprint: FileText,
  glass: Layers,
  dark: Terminal,
};

/** 面板只有两百来像素宽,三档平分下来放不下四个汉字 —— 这里用两字简称。 */
const FALLBACK_SHORT: Record<UiTheme, string> = {
  blueprint: '纸构',
  glass: '棱光',
  dark: '霓虹',
};

const FALLBACK_NAME: Record<UiTheme, string> = {
  blueprint: '纸构蓝图',
  glass: '棱光玻璃',
  dark: '霓虹终端',
};

export default function QuickThemeSwitch() {
  const { t } = useTranslation('settings');
  const { uiTheme, setUiTheme } = useTheme();

  return (
    <div className="flex w-full items-center gap-1 rounded-md border border-border p-1">
      {UI_THEMES.map((theme) => {
        const Icon = ICONS[theme];
        const isActive = uiTheme === theme;
        const name = t(`appearanceSettings.uiTheme.options.${theme}.name`, {
          defaultValue: FALLBACK_NAME[theme],
        });
        const short = t(`appearanceSettings.uiTheme.options.${theme}.short`, {
          defaultValue: FALLBACK_SHORT[theme],
        });

        return (
          <button
            key={theme}
            type="button"
            onClick={() => setUiTheme(theme)}
            aria-pressed={isActive}
            title={name}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isActive
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5 flex-none" strokeWidth={1.8} aria-hidden />
            <span className="truncate">{short}</span>
          </button>
        );
      })}
    </div>
  );
}
