import { describe, expect, it } from 'vitest';

import { detectResultShape, tokenizeJson, toParamRows } from './detailsFormatting';

describe('tokenizeJson', () => {
  it('marks a quoted name followed by a colon as a key and the rest as values', () => {
    const tokens = tokenizeJson('{\n  "id": "15082b3a",\n  "count": 3\n}');
    expect(tokens.filter((token) => token.kind === 'key').map((token) => token.text))
      .toEqual(['"id"', '"count"']);
    expect(tokens.filter((token) => token.kind === 'string').map((token) => token.text))
      .toEqual(['"15082b3a"']);
    expect(tokens.filter((token) => token.kind === 'literal').map((token) => token.text))
      .toEqual(['3']);
  });

  it('round-trips the original text', () => {
    const source = '{"a":[1,true,null,"x"],"b":-2.5e3}';
    expect(tokenizeJson(source).map((token) => token.text).join('')).toBe(source);
  });

  it('does not mistake a colon inside a string for a key separator', () => {
    const tokens = tokenizeJson('{"url": "https://x.dev/a"}');
    expect(tokens.filter((token) => token.kind === 'key').map((token) => token.text)).toEqual(['"url"']);
    expect(tokens.filter((token) => token.kind === 'string').map((token) => token.text))
      .toEqual(['"https://x.dev/a"']);
  });
});

describe('detectResultShape', () => {
  it('treats blank output as empty', () => {
    expect(detectResultShape('   \n ')).toEqual({ kind: 'empty' });
    expect(detectResultShape(null)).toEqual({ kind: 'empty' });
  });

  it('pretty-prints parseable JSON', () => {
    const shape = detectResultShape('{"ok":true,"results":["ok-1","ok-2"]}');
    expect(shape.kind).toBe('json');
    if (shape.kind === 'json') {
      expect(shape.text).toContain('\n  "ok": true');
      expect(shape.lines).toBeGreaterThan(1);
    }
  });

  it('keeps a short one-liner as a bare line', () => {
    expect(detectResultShape('Cancelled job 15082b3a')).toEqual({ kind: 'line', text: 'Cancelled job 15082b3a' });
  });

  it('falls back to text for multi-line output and unparseable JSON', () => {
    expect(detectResultShape('a\nb\nc')).toMatchObject({ kind: 'text', lines: 3 });
    expect(detectResultShape('{not json\nsecond line')).toMatchObject({ kind: 'text', lines: 2 });
    // 短的一行即使长得像 JSON,也当一行显示 —— 套个盒子反而更难读
    expect(detectResultShape('{not json')).toMatchObject({ kind: 'line' });
  });
});

describe('toParamRows', () => {
  it('keeps short scalars inline and pushes long or structured values into blocks', () => {
    const rows = toParamRows({
      id: '15082b3a',
      count: 3,
      enabled: true,
      body: 'line1\nline2',
      options: { deep: [1, 2] },
    });
    expect(rows.map((row) => row.key)).toEqual(['id', 'count', 'enabled', 'body', 'options']);
    expect(rows[0].inline).toBe('15082b3a');
    expect(rows[1].inline).toBe('3');
    expect(rows[2].inline).toBe('true');
    expect(rows[3].block).toMatchObject({ lines: 2, isJson: false });
    expect(rows[4].block?.isJson).toBe(true);
  });

  it('gives an empty object no rows and wraps a bare string in a single block', () => {
    expect(toParamRows({})).toEqual([]);
    expect(toParamRows('just text')).toEqual([
      { key: '', block: { text: 'just text', lines: 1, isJson: false } },
    ]);
  });
});
