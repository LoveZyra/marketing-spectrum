/**
 * PDF 抽文本 worker 里的两个纯函数。
 *
 * 背景:原先用的 `pdf-parse@1.1.4` 打包的是 2018 年的 pdf.js v1.10.100,实测读不了
 * reportlab 生成的 PDF(一律 `bad XRef entry`)。换成维护中的 pdfjs-dist 之后,
 * 同一批样本(reportlab 四种变体、手写残缺 PDF、LibreOffice、Chromium)全部能读。
 *
 * 这里钉住的是两件容易回退的事:
 *   1. 报错要说人话 —— `bad XRef entry` 对用户毫无意义,也不提示能怎么办;
 *   2. 换行要保住 —— 不看 `hasEOL` 就会把整页文字拼成没有空格的一长条。
 */

import { describe, it, expect } from 'vitest';

import { describeFailure, readPageText } from '../../workers/pdf-extract.worker.js';

describe('describeFailure', () => {
  it('加密 / 需要密码的,给出可操作的一句话', () => {
    expect(describeFailure({ name: 'PasswordException', message: 'No password given' }))
      .toContain('密码');
    expect(describeFailure(new Error('Incorrect Password')))
      .toContain('密码');
    expect(describeFailure(new Error('File is encrypted')))
      .toContain('加密');
  });

  it('不是 PDF / 已损坏的,说清楚是文件本身的问题', () => {
    expect(describeFailure({ name: 'InvalidPDFException', message: 'bad XRef entry' }))
      .toContain('不是有效的 PDF');
    expect(describeFailure(new Error('Invalid PDF structure')))
      .toContain('不是有效的 PDF');
  });

  it('认不出的原因回落到原始信息,而不是吞掉', () => {
    expect(describeFailure(new Error('something unexpected'))).toBe('something unexpected');
  });

  it('null / undefined 不抛,给一句兜底', () => {
    expect(describeFailure(null)).toBe('unknown error');
    expect(describeFailure(undefined)).toBe('unknown error');
  });
});

describe('readPageText', () => {
  it('按 hasEOL 断行,而不是把整页拼成一条', () => {
    expect(readPageText([
      { str: '第一行', hasEOL: true },
      { str: '第二行', hasEOL: true },
    ])).toBe('第一行\n第二行\n');
  });

  it('同一行内的片段直接相接', () => {
    expect(readPageText([
      { str: 'Prism ', hasEOL: false },
      { str: 'upload ', hasEOL: false },
      { str: 'test', hasEOL: true },
    ])).toBe('Prism upload test\n');
  });

  it('跳过没有 str 的项(pdf.js 会混入 marked-content 之类的条目)', () => {
    expect(readPageText([
      { type: 'beginMarkedContent' },
      { str: 'ok', hasEOL: false },
      { hasEOL: true },
    ])).toBe('ok\n');
  });

  it('空页给空串', () => {
    expect(readPageText([])).toBe('');
  });
});
