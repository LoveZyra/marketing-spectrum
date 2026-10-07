import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * 界面主题,三选一:两种浅色材质加一种深色。
 *
 * - `blueprint` 纸构蓝图:暖白点阵、发丝线分区、零投影、等宽标注
 * - `glass`     棱光玻璃:冷白画布浮半透明玻璃、两层柔光、紫→青分光条
 * - `dark`      霓虹终端:近黑画布、强调色当光源
 *
 * 同时导出 `isDarkMode` / `toggleDarkMode`:代码编辑器主题、语法高亮、命令面板等十来处消费方
 * 只关心"是不是深色"。
 */
export type UiTheme = 'blueprint' | 'glass' | 'dark';

export const UI_THEMES: UiTheme[] = ['blueprint', 'glass', 'dark'];

/** 每套主题的浏览器主题色(移动端地址栏 / iOS 状态栏)。 */
const THEME_COLOR: Record<UiTheme, string> = {
  blueprint: '#fbfaf8',
  glass: '#f6f6fb',
  dark: '#050607',
};

/** 用户显式选过的主题。只在用户动作里写:没有这个键就表示没选过,跟随系统。 */
const STORAGE_KEY = 'prism-ui-theme';
/** 旧的深浅开关键(值为 'dark' / 'light'):只在迁移时读取,不再写入。 */
const LEGACY_STORAGE_KEY = 'theme';
/** 上一次选过的浅色,`toggleDarkMode` 从深色切回来时用。 */
const LAST_LIGHT_STORAGE_KEY = 'prism-ui-theme-last-light';

const DEFAULT_LIGHT: UiTheme = 'blueprint';

function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && (UI_THEMES as string[]).includes(value);
}

function readStoredTheme(): UiTheme | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isUiTheme(saved)) return saved;

    // 从旧的深浅开关迁移:深色照旧,浅色落到默认那套浅色。
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === 'dark') return 'dark';
    if (legacy === 'light') return DEFAULT_LIGHT;
  } catch {
    // 隐私模式 / 禁用存储:当成没存过,跟随系统。
  }
  return null;
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不进去不影响本次会话的显示。
  }
}

function readLastLightTheme(initial: UiTheme): UiTheme {
  try {
    const saved = localStorage.getItem(LAST_LIGHT_STORAGE_KEY);
    if (isUiTheme(saved) && saved !== 'dark') return saved;
  } catch {
    // 读不到就按当前主题推断。
  }
  return initial === 'dark' ? DEFAULT_LIGHT : initial;
}

function resolveInitialTheme(): UiTheme {
  const stored = readStoredTheme();
  if (stored) return stored;

  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : DEFAULT_LIGHT;
  }
  return DEFAULT_LIGHT;
}

type ThemeContextValue = {
  uiTheme: UiTheme;
  setUiTheme: (theme: UiTheme) => void;
  /** 给只关心"是不是深色"的消费方用。 */
  isDarkMode: boolean;
  /** 命令面板的快捷切换:深色 ↔ 上一次选过的浅色。 */
  toggleDarkMode: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useTheme = (): ThemeContextValue => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [uiTheme, setUiThemeState] = useState<UiTheme>(resolveInitialTheme);
  /**
   * 上一次选过的浅色。`toggleDarkMode` 从深色切回来时回到这一套,而不是默认那套:
   * 选了棱光玻璃的人切一趟深色再切回来,不该变成纸构蓝图。
   */
  const [lastLightTheme, setLastLightTheme] = useState<UiTheme>(() => readLastLightTheme(resolveInitialTheme()));

  useEffect(() => {
    const root = document.documentElement;

    // `.dark` 类名是全库(以及 tailwind 的 dark: 变体)认的深色开关。
    root.classList.toggle('dark', uiTheme === 'dark');
    // 两套浅色靠属性区分。深色也打上,方便个别规则按主题精确命中。
    root.dataset.uiTheme = uiTheme;

    // 这里不写存储:跟随系统得出的主题不算用户选过,写进去之后系统再变就不跟了。

    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) {
      statusBarMeta.setAttribute('content', uiTheme === 'dark' ? 'black-translucent' : 'default');
    }

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', THEME_COLOR[uiTheme]);
    }
  }, [uiTheme]);

  // 没手动选过(存储里没有主题)时跟随系统;选过之后系统怎么变都不再干预。
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      if (readStoredTheme()) return;
      setUiThemeState(event.matches ? 'dark' : DEFAULT_LIGHT);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const setUiTheme = useCallback((theme: UiTheme) => {
    if (!isUiTheme(theme)) return;
    writeStorage(STORAGE_KEY, theme);
    if (theme !== 'dark') {
      setLastLightTheme(theme);
      writeStorage(LAST_LIGHT_STORAGE_KEY, theme);
    }
    setUiThemeState(theme);
  }, []);

  const toggleDarkMode = useCallback(() => {
    const next = uiTheme === 'dark' ? lastLightTheme : 'dark';
    writeStorage(STORAGE_KEY, next);
    setUiThemeState(next);
  }, [lastLightTheme, uiTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      uiTheme,
      setUiTheme,
      isDarkMode: uiTheme === 'dark',
      toggleDarkMode,
    }),
    [uiTheme, setUiTheme, toggleDarkMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};
