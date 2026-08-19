import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import CodeHighlighter from '../../../../../shared/view/CodeHighlighter';
import { useTheme } from '../../../../../contexts/ThemeContext';
import { parseNotebook, type NotebookCell, type NotebookOutput } from '../../../utils/ipynb';
import MarkdownPreview from '../markdown/MarkdownPreview';

type NotebookViewerProps = {
  /** notebook 文件的原始文本(编辑器已经加载好的 content,原样传入)。 */
  content: string;
};

/**
 * html 输出走沙箱 iframe:pandas 表格、styler 这类静态 html 原样呈现,
 * 脚本一律不跑(不给 allow-scripts)—— notebook 可能是别人写的,这里是
 * 多用户环境,富输出不能拿当前用户的会话上下文执行任意 JS。
 * 代价是 plotly/bokeh 这类靠脚本的交互图出不来,只显示占位;要交互去 JupyterLab。
 */
function HtmlOutput({ markup }: { markup: string }) {
  return (
    <iframe
      sandbox=""
      srcDoc={markup}
      title="notebook html output"
      className="max-h-[520px] min-h-[120px] w-full rounded-md border border-border bg-white"
    />
  );
}

function OutputBlock({ output }: { output: NotebookOutput }) {
  if (output.kind === 'stream') {
    return (
      <pre
        className={`overflow-x-auto whitespace-pre-wrap rounded-md px-3 py-2 font-mono text-xs leading-relaxed ${
          output.name === 'stderr'
            ? 'bg-amber-50 text-amber-900 dark:bg-amber-900/15 dark:text-amber-200'
            : 'bg-muted/60 text-foreground/90'
        }`}
      >
        {output.text}
      </pre>
    );
  }

  if (output.kind === 'error') {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-red-50 px-3 py-2 font-mono text-xs leading-relaxed text-red-700 dark:bg-red-900/15 dark:text-red-300">
        {output.traceback || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  }

  if (output.kind === 'image') {
    return (
      <img
        src={`data:${output.mime};base64,${output.data}`}
        alt="notebook output"
        className="max-w-full rounded-md border border-border/50 bg-white"
      />
    );
  }

  if (output.kind === 'svg') {
    // 以 <img> 承载:svg 里即便带 <script> 也不会执行。
    return (
      <img
        src={`data:image/svg+xml;utf8,${encodeURIComponent(output.markup)}`}
        alt="notebook output"
        className="max-w-full rounded-md border border-border/50 bg-white"
      />
    );
  }

  if (output.kind === 'html') {
    return <HtmlOutput markup={output.markup} />;
  }

  if (output.kind === 'markdown') {
    return (
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <MarkdownPreview content={output.text} />
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/90">
      {output.text}
    </pre>
  );
}

function CellBlock({ cell, language, isDarkMode }: { cell: NotebookCell; language: string; isDarkMode: boolean }) {
  if (cell.type === 'markdown') {
    return (
      <div className="prose prose-sm max-w-none px-1 py-1 dark:prose-invert">
        <MarkdownPreview content={cell.source} />
      </div>
    );
  }

  if (cell.type === 'raw') {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
        {cell.source}
      </pre>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {/* 执行序号沿用 Jupyter 的 [n]/[ ] 习惯,一眼能对上执行顺序。 */}
        <div className="w-10 shrink-0 pt-2 text-right font-mono text-[11px] text-muted-foreground/70">
          [{cell.executionCount ?? ' '}]
        </div>
        <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-border/60">
          <CodeHighlighter
            language={language}
            customStyle={{
              margin: 0,
              fontSize: '0.8125rem',
              padding: '0.75rem 1rem',
              ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
            }}
            codeTagProps={{ style: isDarkMode ? {} : { background: 'transparent' } }}
          >
            {cell.source || ' '}
          </CodeHighlighter>
        </div>
      </div>
      {cell.outputs.length > 0 && (
        <div className="ml-12 space-y-2">
          {cell.outputs.map((output, index) => (
            <OutputBlock key={index} output={output} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * .ipynb 只读渲染。点开 notebook 默认看到的就是它;要改源码/JSON 用头部的
 * 切换按钮回编辑器,要执行用「在 JupyterLab 打开」。
 */
export default function NotebookViewer({ content }: NotebookViewerProps) {
  const { t } = useTranslation('codeEditor');
  const { isDarkMode } = useTheme();
  const notebook = useMemo(() => parseNotebook(content), [content]);

  if (!notebook.ok) {
    const message =
      notebook.error === 'legacy_nbformat'
        ? t('notebook.legacyFormat', {
            defaultValue: '这个 notebook 是很老的 nbformat 3 格式,预览不支持 —— 可切换到源码视图查看,或在 JupyterLab 里打开(会自动升级格式)。',
          })
        : t('notebook.parseFailed', {
            defaultValue: '无法解析这个 notebook 文件(JSON 结构不对)。可切换到源码视图检查内容。',
          });
    return (
      <div className="h-full overflow-y-auto p-4">
        <p className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
          {message}
        </p>
      </div>
    );
  }

  if (notebook.cells.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t('notebook.empty', { defaultValue: '空 notebook —— 还没有任何单元格。' })}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl space-y-4 px-3 py-4 sm:px-5">
        {notebook.cells.map((cell) => (
          <CellBlock key={cell.id} cell={cell} language={notebook.language} isDarkMode={isDarkMode} />
        ))}
      </div>
    </div>
  );
}
