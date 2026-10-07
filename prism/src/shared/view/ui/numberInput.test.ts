import { describe, expect, it } from 'vitest';

import { commitNumber, parseTyping, stepNumber } from './numberInput';

/**
 * 数字框不能「删不掉那个 1、敲 3 变 13」:打字时不改写文字、离开时才夹取。
 */
describe('parseTyping', () => {
  it('空串 / 只有符号 / 小数点结尾都不算数(让人接着打)', () => {
    expect(parseTyping('')).toBeNull();
    expect(parseTyping('-')).toBeNull();
    expect(parseTyping('.')).toBeNull();
    expect(parseTyping('1a')).toBeNull();
    expect(parseTyping('3')).toBe(3);
    expect(parseTyping('1.')).toBe(1);
    expect(parseTyping('0.25')).toBe(0.25);
  });
});

describe('commitNumber', () => {
  it('离开时夹到范围、取整,文字规范化', () => {
    expect(commitNumber('30', { min: 1, max: 20, integer: true })).toEqual({ value: 20, text: '20' });
    expect(commitNumber('0', { min: 1, max: 20, integer: true })).toEqual({ value: 1, text: '1' });
    expect(commitNumber('2.6', { min: 1, max: 20, integer: true })).toEqual({ value: 3, text: '3' });
    expect(commitNumber('007', { min: 0, integer: true })).toEqual({ value: 7, text: '7' });
    expect(commitNumber('0.30000000000000004', { min: 0 })).toEqual({ value: 0.3, text: '0.3' });
  });

  it('空着离开:允许空 → null;不允许 → 回到 fallback / min', () => {
    expect(commitNumber('', { min: 0, allowEmpty: true })).toEqual({ value: null, text: '' });
    expect(commitNumber('', { min: 1, max: 20, integer: true })).toEqual({ value: 1, text: '1' });
    expect(commitNumber('  ', { min: 1, fallback: 2 })).toEqual({ value: 2, text: '2' });
  });

  it('没给 max 时不夹上限(费用上限超了由表单提示说清楚,不悄悄改掉)', () => {
    expect(commitNumber('10', { min: 0, allowEmpty: true })).toEqual({ value: 10, text: '10' });
  });
});

describe('stepNumber', () => {
  it('可留空的空框按 ↑ 从 placeholder 的默认值起步,而不是从 0 / min', () => {
    // 基线:base = value ?? fallback ?? min ?? 0 → 空框「默认 8」按 ↑ 得 2(min=1)
    expect(stepNumber('', null, 1, { min: 1, max: 50, integer: true, placeholder: '8' })).toEqual({ value: 9, text: '9' });
    expect(stepNumber('', null, -1, { min: 1, max: 50, integer: true, placeholder: '8' })).toEqual({ value: 7, text: '7' });
  });

  it('有文字 / 有值时照旧从当前数起;placeholder 读不出数退回 fallback / min', () => {
    expect(stepNumber('3', 3, 1, { min: 1, placeholder: '8' })).toEqual({ value: 4, text: '4' });
    expect(stepNumber('', null, 1, { min: 1, placeholder: '默认' })).toEqual({ value: 2, text: '2' });
    expect(stepNumber('', null, 1, { min: 0, fallback: 5 })).toEqual({ value: 6, text: '6' });
  });

  it('步进后仍夹在范围内', () => {
    expect(stepNumber('50', 50, 1, { min: 1, max: 50, integer: true })).toEqual({ value: 50, text: '50' });
  });
});
