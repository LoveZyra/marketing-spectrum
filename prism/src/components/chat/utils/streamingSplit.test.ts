import { describe, expect, it } from 'vitest';

import { splitStreamingMarkdown } from './streamingSplit';

describe('splitStreamingMarkdown', () => {
  it('splits at the last blank line outside code fences', () => {
    const text = '第一段。\n\n第二段还长一些,凑够最小尾巴长度限制。\n\n正在打的第三段,同样凑长一点确保稳稳超过最小尾巴长度限制才行';
    const { stable, tail } = splitStreamingMarkdown(text);
    expect(stable).toBe('第一段。\n\n第二段还长一些,凑够最小尾巴长度限制。\n\n');
    expect(tail).toBe('正在打的第三段,同样凑长一点确保稳稳超过最小尾巴长度限制才行');
    expect(stable + tail).toBe(text);
  });

  it('never splits inside an open code fence', () => {
    const text = '开头一段。\n\n```js\nconst a = 1;\n\nconst b = 2;\n还在代码块里继续输出更多内容更多内容更多内容';
    const { stable, tail } = splitStreamingMarkdown(text);
    // 唯一安全边界是代码块开始前的那个空行
    expect(stable).toBe('开头一段。\n\n');
    expect(tail.startsWith('```js')).toBe(true);
    expect(stable + tail).toBe(text);
  });

  it('resumes splitting after a fence closes', () => {
    const text = 'A 段。\n\n```\ncode\n```\n\nB 段落写得足够长确保尾巴稳稳超过最小长度限制啊啊啊啊啊啊啊';
    const { stable, tail } = splitStreamingMarkdown(text);
    expect(stable).toBe('A 段。\n\n```\ncode\n```\n\n');
    expect(tail).toBe('B 段落写得足够长确保尾巴稳稳超过最小长度限制啊啊啊啊啊啊啊');
  });

  it('treats ~~~ fences like backtick fences and matches closers by marker', () => {
    const text = '~~~\n里面有 ```\n\n仍在波浪栅栏里\n~~~\n\n栅栏之后正常切分这里要足够长足够长足够长足够长足够长足够长';
    const { stable, tail } = splitStreamingMarkdown(text);
    expect(stable).toBe('~~~\n里面有 ```\n\n仍在波浪栅栏里\n~~~\n\n');
    expect(tail).toBe('栅栏之后正常切分这里要足够长足够长足够长足够长足够长足够长');
  });

  it('returns everything as tail when no safe boundary exists', () => {
    expect(splitStreamingMarkdown('单独一段没有空行')).toEqual({ stable: '', tail: '单独一段没有空行' });
    expect(splitStreamingMarkdown('')).toEqual({ stable: '', tail: '' });
    const inFence = '```\nabc\n\ndef';
    expect(splitStreamingMarkdown(inFence)).toEqual({ stable: '', tail: inFence });
  });

  it('keeps a too-short tail attached to avoid churn at the boundary', () => {
    const text = '很长的一个第一段落用来当作封版前缀内容。\n\n短尾';
    expect(splitStreamingMarkdown(text)).toEqual({ stable: '', tail: text });
  });

  it('reconstruction invariant: stable + tail === input for arbitrary shapes', () => {
    const samples = [
      'a\n\nb\n\nc',
      'a\n\n```\nx\n\ny\n```\n\nz 这里也要足够长足够长足够长足够长',
      '\n\n\n',
      '表格|头\n---|---\n1|2\n\n后续段落足够长足够长足够长足够长足够长',
    ];
    for (const sample of samples) {
      const { stable, tail } = splitStreamingMarkdown(sample);
      expect(stable + tail).toBe(sample);
    }
  });
});
