import type { CSSProperties } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
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
