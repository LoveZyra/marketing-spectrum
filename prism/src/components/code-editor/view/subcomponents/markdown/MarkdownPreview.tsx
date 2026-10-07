import { createContext, useContext, useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useKatexPlugins } from '../../../../../shared/markdown/katexPlugins';

import MarkdownCodeBlock from './MarkdownCodeBlock';
import MarkdownImage, { type MarkdownImageBase } from './MarkdownImage';

type MarkdownPreviewProps = {
  content: string;
  /** 相对图片按这份文件所在目录解析,见 MarkdownImage。 */
  base?: MarkdownImageBase;
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

/**
 * 相对图片的解析基准走 context,`img` 渲染器是模块级常量:若按 base 现造组件,
 * base 一变所有图片组件就换了类型、整体重挂载、重新下载(预览与编辑同屏时每敲一个字都会触发)。
 */
const EMPTY_BASE: MarkdownImageBase = {};
const MarkdownImageBaseContext = createContext<MarkdownImageBase>(EMPTY_BASE);

function MarkdownImageRenderer({ src, alt, title }: { src?: unknown; alt?: string; title?: string }) {
  const base = useContext(MarkdownImageBaseContext);
  return <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title} base={base} />;
}

const previewComponentsWithImages: Components = {
  ...markdownPreviewComponents,
  img: MarkdownImageRenderer,
};

export default function MarkdownPreview({ content, base }: MarkdownPreviewProps) {
  const { remarkMathPlugins, rehypeKatexPlugins } = useKatexPlugins(content);
  const remarkPlugins = useMemo(() => [remarkGfm, ...remarkMathPlugins], [remarkMathPlugins]);
  const rehypePlugins = useMemo(() => [...rehypeKatexPlugins], [rehypeKatexPlugins]);

  return (
    <MarkdownImageBaseContext.Provider value={base ?? EMPTY_BASE}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={previewComponentsWithImages}
      >
        {content}
      </ReactMarkdown>
    </MarkdownImageBaseContext.Provider>
  );
}
