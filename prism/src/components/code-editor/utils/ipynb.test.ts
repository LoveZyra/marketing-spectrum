import { describe, expect, it } from 'vitest';

import { joinSource, normalizeOutput, parseNotebook, pickFromDataBundle, stripAnsi } from './ipynb';

describe('joinSource', () => {
  it('数组行合并、字符串原样、其他类型给空串', () => {
    expect(joinSource(['a\n', 'b'])).toBe('a\nb');
    expect(joinSource('plain')).toBe('plain');
    expect(joinSource(null)).toBe('');
    expect(joinSource(42)).toBe('');
    expect(joinSource(['a', 7, 'b'])).toBe('ab');
  });
});

describe('stripAnsi', () => {
  it('剥掉 CSI 颜色序列,普通方括号文本不受伤', () => {
    expect(stripAnsi('[0;31mError[0m done')).toBe('Error done');
    expect(stripAnsi('list[0] = x')).toBe('list[0] = x');
  });
});

describe('pickFromDataBundle', () => {
  it('图片优先于 html,html 优先于纯文本', () => {
    const picked = pickFromDataBundle({
      'text/plain': '<Figure>',
      'text/html': '<table></table>',
      'image/png': 'aGk=\n',
    });
    expect(picked).toEqual({ kind: 'image', mime: 'image/png', data: 'aGk=' });
  });

  it('只有 html 和文本时选 html', () => {
    const picked = pickFromDataBundle({ 'text/plain': 'df', 'text/html': ['<div>', '</div>'] });
    expect(picked).toEqual({ kind: 'html', markup: '<div></div>' });
  });

  it('全不认识 → null', () => {
    expect(pickFromDataBundle({ 'application/x-custom': 'x' })).toBeNull();
    expect(pickFromDataBundle(undefined)).toBeNull();
  });
});

describe('normalizeOutput', () => {
  it('stream 输出保留通道名并剥 ANSI', () => {
    expect(normalizeOutput({ output_type: 'stream', name: 'stderr', text: ['[33mwarn[0m\n'] })).toEqual({
      kind: 'stream',
      name: 'stderr',
      text: 'warn\n',
    });
  });

  it('error 输出合并 traceback 并剥 ANSI', () => {
    const output = normalizeOutput({
      output_type: 'error',
      ename: 'ValueError',
      evalue: 'boom',
      traceback: ['[0;31mValueError[0m', 'boom'],
    });
    expect(output).toEqual({ kind: 'error', ename: 'ValueError', evalue: 'boom', traceback: 'ValueError\nboom' });
  });

  it('空 stream 与未知类型 → null(渲染侧直接跳过)', () => {
    expect(normalizeOutput({ output_type: 'stream', name: 'stdout', text: [] })).toBeNull();
    expect(normalizeOutput({ output_type: 'update_display_data' })).toBeNull();
    expect(normalizeOutput(null)).toBeNull();
  });
});

describe('parseNotebook', () => {
  it('nbformat 4:cell 类型、source 合并、执行序号、输出归一', () => {
    const nb = JSON.stringify({
      nbformat: 4,
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['# 标题\n', '正文'] },
        {
          id: 'abc',
          cell_type: 'code',
          execution_count: 3,
          source: 'print(1)',
          outputs: [{ output_type: 'stream', name: 'stdout', text: '1\n' }],
        },
      ],
    });
    const parsed = parseNotebook(nb);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.language).toBe('python');
    expect(parsed.cells).toHaveLength(2);
    expect(parsed.cells[0]).toMatchObject({ type: 'markdown', source: '# 标题\n正文', id: 'cell-0' });
    expect(parsed.cells[1]).toMatchObject({ type: 'code', id: 'abc', executionCount: 3 });
    expect(parsed.cells[1].outputs).toEqual([{ kind: 'stream', name: 'stdout', text: '1\n' }]);
  });

  it('nbformat 3(worksheets)→ legacy_nbformat;坏 JSON → not_json', () => {
    expect(parseNotebook(JSON.stringify({ nbformat: 3, worksheets: [] }))).toEqual({
      ok: false,
      error: 'legacy_nbformat',
    });
    expect(parseNotebook('{oops')).toEqual({ ok: false, error: 'not_json' });
    expect(parseNotebook(JSON.stringify({ hello: 1 }))).toEqual({ ok: false, error: 'not_notebook' });
  });
});
