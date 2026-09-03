/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        // 界面默认中文,但拉丁字体后面必须挂上系统中文字体,否则中文会落到
        // Windows 的宋体(SimSun)—— 又细又旧,和这套设计完全不搭。挂上
        // 各平台的现代黑体(苹方 / 微软雅黑 / 思源黑体),不需要额外下载。
        // 具体字族由主题决定(纸构蓝图 = IBM Plex,棱光玻璃 = Space Grotesk,
        // 霓虹终端 = Inter),所以这里只指到变量;回落链写在 index.css 的
        // --font-ui / --font-mono 里,三套各自完整。
        sans: ['var(--font-ui)'],
        // 等宽给一切「可以被打出来或算出来的东西」:路径、id、token 数、耗时、行数、diff 数字
        mono: ['var(--font-mono)'],
      },
      colors: {
        border: {
          DEFAULT: "hsl(var(--border))",
          // outline 按钮 hover 的边框:深色 #b8b3b0 / 淡色 #8b949e
          strong: "hsl(var(--border-strong))",
        },
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        body: "hsl(var(--body))",
        // 代码/等宽文字色(volt-text-code):淡色 #1a1a1a、深色 #f5f6f7
        code: "hsl(var(--code-foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          // hover 提亮档:深色 #2fd6a1 / 淡色 #0ea371
          hover: "hsl(var(--primary-hover))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // ef:圆角三档的另外两档(第一档就是 md)。值按主题在 index.css 里给。
        panel: "var(--radius-panel)",
        bubble: "var(--radius-bubble)",
        dialog: "var(--radius-dialog)",
      },
      spacing: {
        'safe-area-inset-bottom': 'env(safe-area-inset-bottom)',
        'mobile-nav': 'var(--mobile-nav-total)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'dialog-overlay-show': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        // 模态入场只做透明度(定位交给静态 -translate-x/y-1/2,不做缩放位移)
        'dialog-content-show': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s linear infinite',
        'dialog-overlay-show': 'dialog-overlay-show 150ms ease-out',
        'dialog-content-show': 'dialog-content-show 150ms ease-out',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}