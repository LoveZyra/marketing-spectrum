import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';

import MarkdownPreview from './markdown/MarkdownPreview';
import HtmlPreview from './HtmlPreview';

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  markdownPreview: boolean;
  isMarkdownFile: boolean;
  htmlPreview?: {
    active: boolean;
    previewUrl: string | null;
    error: string | null;
    isLoading: boolean;
    hasUnsavedChanges: boolean;
    onReload: () => void;
    labels: { loading: string; reload: string; unsavedNotice: string };
  };
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
};

export default function CodeEditorSurface({
  content,
  onChange,
  markdownPreview,
  isMarkdownFile,
  htmlPreview,
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
}: CodeEditorSurfaceProps) {
  if (htmlPreview?.active) {
    return (
      <HtmlPreview
        previewUrl={htmlPreview.previewUrl}
        error={htmlPreview.error}
        isLoading={htmlPreview.isLoading}
        hasUnsavedChanges={htmlPreview.hasUnsavedChanges}
        onReload={htmlPreview.onReload}
        labels={htmlPreview.labels}
      />
    );
  }

  if (markdownPreview && isMarkdownFile) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <div className="prose prose-sm mx-auto max-w-none px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-primary prose-code:text-sm prose-pre:bg-muted prose-img:rounded-lg dark:prose-a:text-primary">
          <MarkdownPreview content={content} />
        </div>
      </div>
    );
  }

  return (
    <CodeMirror
      value={content}
      onChange={onChange}
      extensions={extensions}
      theme={isDarkMode ? oneDark : undefined}
      height="100%"
      style={{
        fontSize: `${fontSize}px`,
        height: '100%',
      }}
      basicSetup={{
        lineNumbers: showLineNumbers,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        searchKeymap: true,
      }}
    />
  );
}
