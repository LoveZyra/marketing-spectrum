import type { CSSProperties } from 'react';
// 用 prism-async-light,不用同步的 Prism:它的 languageLoaders 覆盖 refractor 的全部语言
// (任何语言都能高亮),但每种语法单独成块、用到才拉。这个 chunk 虽然是 lazy 的,
// 聊天记录里几乎必然有代码块,同步版等于每次打开会话都要多下两百多 kB(gzip)。
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-async-light';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { useTheme } from '../../contexts/ThemeContext';

import { withAccessibleContrast } from './accessibleCodeTheme';

// oneLight 的注释 / 字符串色在浅底上只有 3.0–3.8:1,调到 ≥4.5:1(见 accessibleCodeTheme)。
const accessibleOneLight = withAccessibleContrast(oneLight as Record<string, Record<string, unknown>>);

export type SyntaxHighlighterImplProps = {
  language: string;
  customStyle?: CSSProperties;
  codeTagProps?: { style?: CSSProperties };
  children: string;
};

/**
 * The real highlighter, kept in its own module so it lands in its own chunk.
 *
 * Nothing may import this file statically — go through `CodeHighlighter`.
 * The `Light` build with a hand-registered language list would be smaller, but
 * it silently drops highlighting for anything not on the list, and this renders
 * whatever language a model happens to emit.
 */
export default function SyntaxHighlighterImpl({
  language,
  customStyle,
  codeTagProps,
  children,
}: SyntaxHighlighterImplProps) {
  const { isDarkMode } = useTheme();

  return (
    <SyntaxHighlighter
      language={language}
      style={isDarkMode ? oneDark : accessibleOneLight}
      customStyle={customStyle}
      codeTagProps={codeTagProps}
    >
      {children}
    </SyntaxHighlighter>
  );
}
