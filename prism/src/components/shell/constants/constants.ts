import type { ITerminalOptions } from '@xterm/xterm';

export const SHELL_RESTART_DELAY_MS = 200;
export const TERMINAL_INIT_DELAY_MS = 100;
export const TERMINAL_RESIZE_DELAY_MS = 50;

// CLI prompt overlay detection
export const PROMPT_DEBOUNCE_MS = 500;
export const PROMPT_BUFFER_SCAN_LINES = 20;
export const PROMPT_OPTION_SCAN_LINES = 15;
export const PROMPT_MAX_OPTIONS = 5;
export const PROMPT_MIN_OPTIONS = 2;

/** 深色主题(霓虹终端)下的 xterm 配色 —— 原来写死的这套。 */
const TERMINAL_THEME_DARK: NonNullable<ITerminalOptions['theme']> = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

/**
 * 浅色主题(纸构蓝图 / 棱光玻璃)下的 xterm 配色。
 *
 * 原来终端只有一套写死的 VSCode 深色,浅色两个主题下就是一块突兀的黑,外圈还包着
 * 浅色的 `bg-muted` 边。这套用暖白底 + 墨色前景,ANSI 用适合浅底、对比足够的深色。
 */
const TERMINAL_THEME_LIGHT: NonNullable<ITerminalOptions['theme']> = {
  background: '#faf9f6',
  foreground: '#2d2a26',
  cursor: '#2d2a26',
  cursorAccent: '#faf9f6',
  selectionBackground: '#c8ddf0',
  selectionForeground: '#1a1a1a',
  black: '#3b3b3b',
  red: '#c0341d',
  green: '#0a7f4f',
  yellow: '#a86a00',
  blue: '#1f6feb',
  magenta: '#a83fa8',
  cyan: '#0e7490',
  white: '#d0cdc7',
  brightBlack: '#6b6b6b',
  brightRed: '#e0492c',
  brightGreen: '#12a568',
  brightYellow: '#c98a10',
  brightBlue: '#3b8eea',
  brightMagenta: '#c05fc0',
  brightCyan: '#1597b8',
  brightWhite: '#ffffff',
};

/** 按 UI 主题挑 xterm 配色:dark → 霓虹深色;其余(blueprint/glass)→ 暖白浅色。 */
export function getTerminalTheme(uiThemeIsDark: boolean): NonNullable<ITerminalOptions['theme']> {
  return uiThemeIsDark ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT;
}

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  allowProposedApi: true,
  allowTransparency: false,
  convertEol: true,
  scrollback: 10000,
  tabStopWidth: 4,
  windowsMode: false,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  // 默认给深色(创建时会按当前主题覆盖,见 useShellTerminal)。
  theme: {
    ...TERMINAL_THEME_DARK,
    extendedAnsi: [
      '#000000',
      '#800000',
      '#008000',
      '#808000',
      '#000080',
      '#800080',
      '#008080',
      '#c0c0c0',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#0000ff',
      '#ff00ff',
      '#00ffff',
      '#ffffff',
    ],
  },
};
