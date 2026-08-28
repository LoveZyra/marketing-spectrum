import { lazy, Suspense } from 'react';
import type { CSSProperties } from 'react';

import { useTheme } from '../../contexts/ThemeContext';

/**
 * Syntax-highlighted code block, with the highlighter loaded on demand.
 *
 * The fallback is not a spinner: it is the same block rendered as plain
 * monospace text with the caller's own `customStyle` applied. So the code is
 * readable and correctly laid out from the first frame, and when the chunk
 * lands the only visible change is that tokens gain colour — no reflow, no
 * flash of empty space. That matters because a chat transcript can contain
 * dozens of these and they all resolve from one shared chunk.
 */

const SyntaxHighlighterImpl = lazy(() => import('./SyntaxHighlighterImpl'));

type CodeHighlighterProps = {
  language: string;
  customStyle?: CSSProperties;
  codeTagProps?: { style?: CSSProperties };
  children: string;
  /**
   * 只出纯文本块,不加载/不运行 tokenizer。
   *
   * 给流式中的代码块用:内容每 100ms 变一次,每次全量重新 tokenize 是纯浪费,
   * 大代码块能把打字动画卡成幻灯片。布局与配色和真高亮完全一致(就是 Suspense
   * fallback 那套),所以收尾时切回高亮只是"字上色",没有跳动。
   */
  plain?: boolean;
};

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

// Matches the resting colours of the oneDark / oneLight prism themes, so the
// placeholder and the real thing sit on the same background.
const DARK_FALLBACK: CSSProperties = { background: '#282c34', color: '#abb2bf' };
const LIGHT_FALLBACK: CSSProperties = { background: 'hsl(var(--muted))', color: '#383a42' };

function PlainCodeBlock({ customStyle, codeTagProps, children }: Omit<CodeHighlighterProps, 'language'>) {
  const { isDarkMode } = useTheme();

  return (
    <pre
      style={{
        ...(isDarkMode ? DARK_FALLBACK : LIGHT_FALLBACK),
        fontSize: '0.875rem',
        // **必须和高亮版一致**。这里不写的话会继承 prose-sm 的 1.6666667,
        // 而 oneDark/oneLight 的 `pre[class*="language-"]` 是 1.5 ——
        // 高亮 chunk 落地那一刻每个代码块高度掉约 11%(40 行的块少 90 多像素),
        // 下面所有内容整体上跳。转录里十几个代码块就是十几次。
        lineHeight: 1.5,
        overflow: 'auto',
        ...customStyle,
      }}
    >
      <code style={{ fontFamily: MONO_FONT, ...codeTagProps?.style }}>{children}</code>
    </pre>
  );
}

export default function CodeHighlighter({
  language,
  customStyle,
  codeTagProps,
  children,
  plain = false,
}: CodeHighlighterProps) {
  if (plain) {
    return (
      <PlainCodeBlock customStyle={customStyle} codeTagProps={codeTagProps}>
        {children}
      </PlainCodeBlock>
    );
  }

  return (
    <Suspense
      fallback={
        <PlainCodeBlock customStyle={customStyle} codeTagProps={codeTagProps}>
          {children}
        </PlainCodeBlock>
      }
    >
      <SyntaxHighlighterImpl language={language} customStyle={customStyle} codeTagProps={codeTagProps}>
        {children}
      </SyntaxHighlighterImpl>
    </Suspense>
  );
}
