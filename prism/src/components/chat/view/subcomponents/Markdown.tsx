import React, { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';

import CodeHighlighter from '../../../../shared/view/CodeHighlighter';
import { useKatexPlugins } from '../../../../shared/markdown/katexPlugins';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { splitStreamingMarkdown } from '../../utils/streamingSplit';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { usePaletteOps } from '../../../../contexts/PaletteOpsContext';
import { useTheme } from '../../../../contexts/ThemeContext';

import MermaidDiagram from './MermaidDiagram';
import { safeLinkHref } from './markdownLinkSafety';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /**
   * 正文还在流式增长中。传下去只影响一件事:代码块先渲染成纯文本块
   * (布局配色与高亮版一致),等这条消息定稿后再整体上色 —— 避免每个
   * flush 都对越来越长的代码块全量重新 tokenize。
   */
  streaming?: boolean;
};

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));


// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A usable file path contains a separator or a filename with an extension.
const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

type CodeBlockProps = {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  /** 见 MarkdownProps.streaming —— 为真时跳过语法高亮,渲染纯文本块。 */
  streaming?: boolean;
};

/** mermaid 图右上角的「复制源码」,悬停出现,样式与代码块的复制一致。 */
const MermaidCopyButton = ({ raw }: { raw: string }) => {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        copyTextToClipboard(raw).then((success) => {
          if (success) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        })
      }
      className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card px-2 py-1 text-xs text-body opacity-0 transition-opacity hover:bg-muted focus:opacity-100 active:opacity-100 group-hover:opacity-100"
      title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
      aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
    >
      {copied ? t('codeBlock.copied') : t('codeBlock.copy')}
    </button>
  );
};

const CodeBlock = ({ node, inline, className, children, streaming, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(raw);
  const inlineDetected = inline || (node && node.type === 'inlineCode');
  const shouldInline = inlineDetected || !looksMultiline;

  if (shouldInline) {
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';

  // mermaid 块渲染成图(F3):流式期间不试渲染(半截源码必然报错),
  // 定稿后再画;渲染失败回退为下面这个高亮源码块。
  if (language === 'mermaid' && !streaming) {
    return (
      <div className="group relative my-2">
        <MermaidCopyButton raw={raw} />
        <MermaidDiagram
          code={raw}
          fallback={
            <CodeHighlighter
              language="mermaid"
              customStyle={{ margin: 0, borderRadius: '0.75rem', fontSize: '0.875rem', padding: '1rem' }}
            >
              {raw}
            </CodeHighlighter>
          }
        />
      </div>
    );
  }

  return (
    <div className="group relative my-2">
      {language && language !== 'text' && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-muted-foreground">{language}</div>
      )}

      <button
        type="button"
        onClick={() =>
          copyTextToClipboard(raw).then((success) => {
            if (success) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          })
        }
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card px-2 py-1 text-xs text-body opacity-0 transition-opacity hover:bg-muted focus:opacity-100 active:opacity-100 group-hover:opacity-100"
        title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
      >
        {copied ? (
          <span className="flex items-center gap-1">
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            {t('codeBlock.copied')}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
            {t('codeBlock.copy')}
          </span>
        )}
      </button>

      <CodeHighlighter
        language={language}
        plain={Boolean(streaming)}
        customStyle={{
          margin: 0,
          borderRadius: '0.75rem',
          fontSize: '0.875rem',
          padding: language && language !== 'text' ? '2rem 1rem 1rem 1rem' : '1rem',
          // ChatGPT-style soft grey block in light mode; keep oneDark's own bg in dark.
          ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
        }}
        codeTagProps={{
          style: {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            ...(isDarkMode ? {} : { background: 'transparent' }),
          },
        }}
      >
        {raw}
      </CodeHighlighter>
    </div>
  );
};

const markdownComponents = {
  code: CodeBlock,
  // dl:图片惰性解码。滚动到再取,解码不占主线程;加载完成前后由外层
  // 滚动控制器守位,这里不做占位框 —— 猜错的 min-height 比不占位更晃。
  img: ({ alt, ...imgProps }: { alt?: string; src?: string }) => (
    <img alt={alt ?? ''} loading="lazy" decoding="async" {...imgProps} />
  ),
  // CodeBlock renders its own syntax-highlighted <pre>; this passthrough stops
  // react-markdown (and Tailwind Typography) from wrapping it in a second,
  // dark-themed <pre> shell that would frame the block.
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-4 border-border pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{children}</div>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-border">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-muted">{children}</thead>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border px-3 py-2 text-left text-sm font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-3 py-2 align-top text-sm">{children}</td>
  ),
};

/**
 * 单段正文的解析与渲染(不带外层 div)。memo:content 没变就整棵跳过 ——
 * markdown 解析(remark/rehype)是聊天列表里最重的纯计算之一。
 */
const MarkdownBody = memo(function MarkdownBody({ content, streaming }: { content: string; streaming?: boolean }) {
  // remark-math / rehype-katex arrive only for content that contains maths;
  // until then these are stable empty arrays and KaTeX is never fetched.
  const { remarkMathPlugins, rehypeKatexPlugins } = useKatexPlugins(content);
  const remarkPlugins = useMemo(() => [remarkGfm, ...remarkMathPlugins], [remarkMathPlugins]);
  const rehypePlugins = useMemo(() => [...rehypeKatexPlugins], [rehypeKatexPlugins]);
  const { openFileInEditor } = usePaletteOps();

  const components = useMemo(
    () => ({
      ...markdownComponents,
      code: (props: CodeBlockProps) => <CodeBlock {...props} streaming={streaming} />,
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        // Prefer the href when it is a real path; otherwise fall back to the
        // link text, since models often emit `[src/foo.ts]()` with an empty href.
        const linkText = childrenToText(linkChildren);
        const fileRef = looksLikeFilePath(href) ? href : looksLikeFilePath(linkText) ? linkText : undefined;

        if (fileRef && !isExternalHref(href)) {
          return (
            <a
              href={href || fileRef}
              className="cursor-pointer text-foreground hover:underline dark:text-primary"
              onClick={(event) => {
                event.preventDefault();
                openFileInEditor(stripLineSuffix(fileRef));
              }}
            >
              {linkChildren}
            </a>
          );
        }

        // dv:协议白名单外的一律不挂 href —— 只把原文显示出来。
        const safeHref = safeLinkHref(href);
        if (!safeHref) {
          return (
            <span className="text-muted-foreground underline decoration-dotted" title={href}>
              {linkChildren}
            </span>
          );
        }

        return (
          <a
            href={safeHref}
            className="text-foreground hover:underline dark:text-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkChildren}
          </a>
        );
      },
    }),
    [openFileInEditor, streaming],
  );

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components as any}>
      {content}
    </ReactMarkdown>
  );
});

/**
 * memo 的意义:正文字符串没变就整棵跳过。props 里只有 children/className/
 * streaming 三个值类型,浅比较天然成立。
 */
export const Markdown = memo(function Markdown({ children, className, streaming }: MarkdownProps) {
  const content = normalizeInlineCodeFences(String(children ?? ''));
  return (
    <div className={className}>
      <MarkdownBody content={content} streaming={streaming} />
    </div>
  );
});

/**
 * 流式专用的两段式渲染(dl)。
 *
 * 每次 flush 全量重解析是打字机后期变卡的根源:成本随答案长度线性涨,整轮
 * 二次方。这里按 `splitStreamingMarkdown` 切成「封版前缀 + 活动尾巴」:
 * 前缀那份 MarkdownBody 的 content 只在又一个段落完成时才变(memo 命中,
 * 整棵跳过),每次 flush 真正重解析的只有尾巴那几百个字符。
 *
 * 两个 body 放在**同一个** prose 容器里:Typography 的样式按后代选择器生效,
 * 段间距由每个块自己的 margin 提供,拼缝处与单实例渲染一致。定稿后走回
 * 普通 Markdown(整段一个实例),行为与 dl 之前完全相同。
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ children, className }: { children: React.ReactNode; className?: string }) {
  const content = normalizeInlineCodeFences(String(children ?? ''));
  const { stable, tail } = useMemo(() => splitStreamingMarkdown(content), [content]);
  return (
    <div className={className}>
      {stable ? <MarkdownBody content={stable} streaming /> : null}
      {tail ? <MarkdownBody content={tail} streaming /> : null}
    </div>
  );
});
