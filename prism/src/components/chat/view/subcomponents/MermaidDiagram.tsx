import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';

/**
 * ```mermaid 代码块的图形渲染(F3)。
 *
 * - **懒加载**:mermaid(约 1MB+ 的库)只在正文里真的出现 mermaid 块时才
 *   动态 import,不进首屏;
 * - **主题适配**:亮/暗各初始化一套主题,切主题重渲;
 * - **失败回退**:语法不合法(模型输出的图经常有小错)就原样显示源码块
 *   (fallback 由调用方传入,即原来的高亮代码块),加一行小字说明;
 * - 流式期间不会走到这里 —— Markdown/CodeBlock 在 streaming 时保持纯文本,
 *   定稿后才渲染,不会拿半截源码反复试。
 *
 * securityLevel 用 mermaid 默认的 strict(不执行内嵌脚本/点击)。
 */

let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null;
let renderCounter = 0;
let initializedTheme: string | null = null;

/**
 * dn-O2:渲染结果缓存(code+theme → svg,模块级,LRU 上限 50)。
 *
 * 同一张图在窗口进出、列表重挂载、切会话回来时都会重新走 parse+render ——
 * 每次都是一轮异步、一次占位/放开的高度过渡。缓存命中就同步拿到 svg,
 * 首帧即终态,占位逻辑整个短路。切主题 key 不同,天然各存一份。
 */
const svgCache = new Map<string, string>();
const SVG_CACHE_MAX = 50;

function cacheKey(code: string, dark: boolean): string {
  return `${dark ? 'dark' : 'light'}::${code}`;
}

function readCachedSvg(code: string, dark: boolean): string | null {
  const key = cacheKey(code, dark);
  const hit = svgCache.get(key);
  if (hit === undefined) return null;
  // 刷新 LRU 近度
  svgCache.delete(key);
  svgCache.set(key, hit);
  return hit;
}

function writeCachedSvg(code: string, dark: boolean, svg: string): void {
  const key = cacheKey(code, dark);
  svgCache.delete(key);
  svgCache.set(key, svg);
  while (svgCache.size > SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next().value;
    if (oldest === undefined) break;
    svgCache.delete(oldest);
  }
}

async function loadMermaid(dark: boolean) {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid');
  }
  const mod = await mermaidModulePromise;
  const mermaid = mod.default;
  const theme = dark ? 'dark' : 'default';
  if (initializedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, theme, fontFamily: 'inherit' });
    initializedTheme = theme;
  }
  return mermaid;
}

type MermaidDiagramProps = {
  code: string;
  /** 渲染失败时显示的源码块(原高亮代码块原样交回)。 */
  fallback: ReactNode;
};

export default function MermaidDiagram({ code, fallback }: MermaidDiagramProps) {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  // 缓存命中时首帧就是终态 —— 不走占位、不走异步渲染。
  const [svg, setSvg] = useState<string | null>(() => readCachedSvg(code, isDarkMode));
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * 占位源码块的高度。
   *
   * 源码块的高度和渲染出来的图**毫无关系**(20 行源码约 420px,图可能 200px
   * 也可能 800px)。直接整块替换的话,图比源码矮就是一次向上塌陷,下面所有内容
   * 跟着跳。这里把替换前的高度记下来当 `min-height`,再用一次过渡放开 ——
   * 变矮变成"收",不是"塌"。变高由浏览器的滚动锚定兜住。
   */
  const placeholderRef = useRef<HTMLDivElement>(null);
  const reservedHeightRef = useRef(0);
  const [releasedHeight, setReleasedHeight] = useState(false);

  // 替换前把占位块的高度量下来(布局阶段读,不会看到中间态)。
  useLayoutEffect(() => {
    if (!svg && placeholderRef.current) {
      const height = placeholderRef.current.offsetHeight;
      if (height > 0) reservedHeightRef.current = height;
    }
  });

  // 图挂上去之后放开预留高度 —— CSS 那边有 min-height 过渡,收得平滑。
  useLayoutEffect(() => {
    if (!svg) {
      setReleasedHeight(false);
      return;
    }
    const raf = requestAnimationFrame(() => setReleasedHeight(true));
    return () => cancelAnimationFrame(raf);
  }, [svg]);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // dn-O2:code/theme 变化先查缓存 —— 命中就同步落位,跳过整轮异步渲染。
    const cached = readCachedSvg(code, isDarkMode);
    if (cached !== null) {
      setSvg(cached);
      return undefined;
    }
    (async () => {
      try {
        const mermaid = await loadMermaid(isDarkMode);
        // parse 先行:render 对非法源码会往 DOM 里塞错误占位,parse 能干净拦下
        await mermaid.parse(code);
        renderCounter += 1;
        const { svg: rendered } = await mermaid.render(`prism-mermaid-${renderCounter}`, code);
        writeCachedSvg(code, isDarkMode, rendered);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, isDarkMode]);

  if (failed) {
    return (
      <div>
        {fallback}
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t('mermaid.renderFailed', { defaultValue: 'mermaid 图渲染失败,已显示源码。' })}
        </div>
      </div>
    );
  }

  if (!svg) {
    // 加载/渲染中:先占位为源码块,图好了再替换 —— 没有空白闪烁。
    return <div ref={placeholderRef}>{fallback}</div>;
  }

  return (
    <div
      ref={containerRef}
      className="prism-mermaid my-2 overflow-x-auto rounded-lg border border-border bg-card p-3"
      style={reservedHeightRef.current > 0 && !releasedHeight
        ? { minHeight: reservedHeightRef.current }
        : undefined}
      // mermaid.render 的输出是自己生成的 SVG(securityLevel strict 已消毒),
      // 不是用户可控的原始 HTML 直插。
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
