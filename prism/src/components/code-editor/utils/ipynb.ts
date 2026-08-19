/**
 * .ipynb(nbformat 4)解析:把 notebook JSON 归一成渲染友好的纯数据结构。
 *
 * 只做解析不做渲染,全部纯函数 —— NotebookViewer 消费这里的输出,单测直接
 * 盯这里。nbformat 3(2015 年前)不支持:结构差异太大(worksheets/input/
 * pyout),遇到直接给出可读的错误,用户可以切回源码视图。
 */

export type NotebookOutput =
  | { kind: 'stream'; name: string; text: string }
  | { kind: 'error'; ename: string; evalue: string; traceback: string }
  | { kind: 'image'; mime: string; data: string }
  | { kind: 'svg'; markup: string }
  | { kind: 'html'; markup: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'text'; text: string };

export type NotebookCell = {
  id: string;
  type: 'code' | 'markdown' | 'raw';
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
};

export type ParsedNotebook =
  | { ok: true; language: string; cells: NotebookCell[] }
  | { ok: false; error: string };

/** nbformat 的多行字段既可能是字符串也可能是行数组 —— 统一成字符串。 */
export function joinSource(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((line) => typeof line === 'string').join('');
  }
  return '';
}

// CSI 序列(颜色等)。traceback 里全是这类转义,浏览器端直接剥掉。
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * display_data / execute_result 的 mimetype 挑选顺序。
 * 图片优先于 html:同一个 bundle 里两者常常并存(matplotlib),图片是
 * 无脚本的安全形态;html 只在没有更安全选项时才用(渲染侧走沙箱 iframe)。
 */
const MIME_PRIORITY = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
  'text/html',
  'text/markdown',
  'text/latex',
  'text/plain',
] as const;

type RawOutput = {
  output_type?: unknown;
  name?: unknown;
  text?: unknown;
  ename?: unknown;
  evalue?: unknown;
  traceback?: unknown;
  data?: Record<string, unknown>;
};

/** data bundle → 单个渲染输出。全部 mimetype 都不认识时返回 null。 */
export function pickFromDataBundle(data: Record<string, unknown> | undefined): NotebookOutput | null {
  if (!data || typeof data !== 'object') return null;
  for (const mime of MIME_PRIORITY) {
    if (!(mime in data)) continue;
    const value = data[mime];
    if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif') {
      // base64,可能被 json 序列化成带换行的多行串。
      const base64 = joinSource(value).replace(/\s+/g, '');
      if (!base64) continue;
      return { kind: 'image', mime, data: base64 };
    }
    if (mime === 'image/svg+xml') {
      const markup = joinSource(value).trim();
      if (!markup) continue;
      return { kind: 'svg', markup };
    }
    if (mime === 'text/html') {
      const markup = joinSource(value).trim();
      if (!markup) continue;
      return { kind: 'html', markup };
    }
    if (mime === 'text/markdown') {
      const text = joinSource(value);
      if (!text.trim()) continue;
      return { kind: 'markdown', text };
    }
    // text/latex 交给 markdown 渲染器(KaTeX 接得住 $$…$$)。
    if (mime === 'text/latex') {
      const text = joinSource(value);
      if (!text.trim()) continue;
      return { kind: 'markdown', text };
    }
    const text = joinSource(value);
    if (!text) continue;
    return { kind: 'text', text };
  }
  return null;
}

/** 单条 output → 渲染输出。空的/不认识的返回 null,渲染侧直接跳过。 */
export function normalizeOutput(raw: unknown): NotebookOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const output = raw as RawOutput;
  const type = typeof output.output_type === 'string' ? output.output_type : '';

  if (type === 'stream') {
    const text = joinSource(output.text);
    if (!text) return null;
    return {
      kind: 'stream',
      name: typeof output.name === 'string' ? output.name : 'stdout',
      text: stripAnsi(text),
    };
  }

  if (type === 'error') {
    const tracebackLines = Array.isArray(output.traceback)
      ? output.traceback.filter((line): line is string => typeof line === 'string')
      : [];
    return {
      kind: 'error',
      ename: typeof output.ename === 'string' ? output.ename : 'Error',
      evalue: typeof output.evalue === 'string' ? output.evalue : '',
      traceback: stripAnsi(tracebackLines.join('\n')),
    };
  }

  if (type === 'execute_result' || type === 'display_data') {
    return pickFromDataBundle(output.data);
  }

  return null;
}

type RawCell = {
  id?: unknown;
  cell_type?: unknown;
  source?: unknown;
  execution_count?: unknown;
  outputs?: unknown;
};

/** notebook 文本 → 渲染结构。任何形态问题都归结为一条人话错误。 */
export function parseNotebook(text: string): ParsedNotebook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not_json' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'not_notebook' };
  }

  const notebook = parsed as {
    nbformat?: unknown;
    cells?: unknown;
    metadata?: { language_info?: { name?: unknown }; kernelspec?: { language?: unknown } };
  };

  if (!Array.isArray(notebook.cells)) {
    // nbformat 3 没有顶层 cells;其余情况多半根本不是 notebook。
    return {
      ok: false,
      error: typeof notebook.nbformat === 'number' && notebook.nbformat < 4 ? 'legacy_nbformat' : 'not_notebook',
    };
  }

  const language =
    (typeof notebook.metadata?.language_info?.name === 'string' && notebook.metadata.language_info.name) ||
    (typeof notebook.metadata?.kernelspec?.language === 'string' && notebook.metadata.kernelspec.language) ||
    'python';

  const cells: NotebookCell[] = [];
  notebook.cells.forEach((rawCell: unknown, index: number) => {
    if (!rawCell || typeof rawCell !== 'object') return;
    const cell = rawCell as RawCell;
    const cellType = cell.cell_type === 'markdown' || cell.cell_type === 'raw' ? cell.cell_type : 'code';
    const outputs =
      cellType === 'code' && Array.isArray(cell.outputs)
        ? cell.outputs.map(normalizeOutput).filter((output): output is NotebookOutput => output !== null)
        : [];
    cells.push({
      // nbformat 4.5 起才有 cell.id;老文件用位置合成,只求 React key 稳定。
      id: typeof cell.id === 'string' && cell.id ? cell.id : `cell-${index}`,
      type: cellType,
      source: joinSource(cell.source),
      executionCount: typeof cell.execution_count === 'number' ? cell.execution_count : null,
      outputs,
    });
  });

  return { ok: true, language, cells };
}
