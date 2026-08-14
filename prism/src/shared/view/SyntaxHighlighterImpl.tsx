import type { CSSProperties } from 'react';
// prism-async-light,不是同步的 Prism。
//
// 本文件原有的权衡是对的 —— 用 `Light` 手工注册语言会静默丢掉没注册到的高亮。
// 但它漏了第三个选项:`prism-async-light` 的 languageLoaders 覆盖 refractor
// 的全部语言,行为与同步版完全一致(任何语言都高亮),只是每种语法单独成块、
// 用到才拉。实测入口块 633 kB / 227 kB gzip -> 51 kB / 13 kB gzip。
// 这个 chunk 本来就是 lazy 的,但聊天记录里几乎必然有代码块,等于每次打开
// 会话都要下 231 kB gzip。
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-async-light';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { useTheme } from '../../contexts/ThemeContext';

/**
 * The real highlighter, kept in its own module so it lands in its own chunk.
 *
 * Nothing may import this file statically — go through `CodeHighlighter`. The
 * `Prism` build of react-syntax-highlighter registers every language refractor
 * ships, which is ~1 MB minified and was the single largest thing in the entry
 * chunk, loaded on every page view for the sake of code blocks that may never
 * appear. Importing the `Light` build with a hand-registered language list
 * would be smaller still, but it silently drops highlighting for anything not
 * on the list — and this renders whatever language a model happens to emit.
 */

export type SyntaxHighlighterImplProps = {
  language: string;
  customStyle?: CSSProperties;
  codeTagProps?: { style?: CSSProperties };
  children: string;
};

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
      style={isDarkMode ? oneDark : oneLight}
      customStyle={customStyle}
      codeTagProps={codeTagProps}
    >
      {children}
    </SyntaxHighlighter>
  );
}
