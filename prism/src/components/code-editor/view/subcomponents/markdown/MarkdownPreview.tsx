import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useKatexPlugins } from '../../../../../shared/markdown/katexPlugins';

import MarkdownCodeBlock from './MarkdownCodeBlock';

type MarkdownPreviewProps = {
  content: string;
};

const markdownPreviewComponents: Components = {
  code: MarkdownCodeBlock,
  // MarkdownCodeBlock renders its own highlighted <pre>; passthrough prevents a
  // second Typography-styled <pre> shell from framing it.
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-border pl-4 italic text-body">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-card-foreground hover:underline dark:text-primary" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-border">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border px-3 py-2 text-left text-sm font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-2 align-top text-sm">{children}</td>
  ),
};

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const { remarkMathPlugins, rehypeKatexPlugins } = useKatexPlugins(content);
  const remarkPlugins = useMemo(() => [remarkGfm, ...remarkMathPlugins], [remarkMathPlugins]);
  const rehypePlugins = useMemo(() => [...rehypeKatexPlugins], [rehypeKatexPlugins]);

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={markdownPreviewComponents}
    >
      {content}
    </ReactMarkdown>
  );
}
