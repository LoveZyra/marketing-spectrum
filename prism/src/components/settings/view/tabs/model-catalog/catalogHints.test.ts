import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  KNOWN_FAILURE_REASONS,
  cliAssumesOneMillionWindow,
  failureReasonKey,
  formatFailureRate,
  formatTtft,
  isContextWindowMissing,
  isFailureRateHigh,
  isKnownFailureReason,
  needsContextWindowWarning,
  probeAgo,
  topFailureReasons,
} from './catalogHints';

const readLocale = (lang: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../i18n/locales/${lang}/settings.json`, import.meta.url)), 'utf8')) as Record<string, unknown>;

const lookup = (dict: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), dict);

describe('cliAssumesOneMillionWindow(CLI 2.1.285 走自定义网关时按 1M 算的那几族)', () => {
  test.each([
    'claude-sonnet-5',
    'claude-sonnet-5-1',
    'claude-sonnet-5-20261001',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-4-9-20261001',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-fable-1',
    'CLAUDE-OPUS-4-7',
    '  claude-fable-2  ',
  ])('认:%s', (modelId) => {
    expect(cliAssumesOneMillionWindow(modelId)).toBe(true);
  });

  test.each([
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-1',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    'opus-4-7',
    'sonnet',
    'opus',
    'fable',
    'glm-5.2',
    'my-claude-opus-5',
    '',
  ])('不认:%s', (modelId) => {
    expect(cliAssumesOneMillionWindow(modelId)).toBe(false);
  });

  test('空值不认', () => {
    expect(cliAssumesOneMillionWindow(null)).toBe(false);
    expect(cliAssumesOneMillionWindow(undefined)).toBe(false);
  });
});

describe('needsContextWindowWarning', () => {
  test('认得出的族 + 没填窗口 → 提醒', () => {
    expect(needsContextWindowWarning({ modelId: 'claude-opus-4-7', contextWindow: null })).toBe(true);
    expect(needsContextWindowWarning({ modelId: 'claude-sonnet-5', contextWindow: undefined })).toBe(true);
    expect(needsContextWindowWarning({ modelId: 'claude-fable-1', contextWindow: 0 })).toBe(true);
  });

  test('填了窗口就不提醒(哪怕填的是 1M)', () => {
    expect(needsContextWindowWarning({ modelId: 'claude-opus-4-7', contextWindow: 200_000 })).toBe(false);
    expect(needsContextWindowWarning({ modelId: 'claude-opus-5', contextWindow: 1_000_000 })).toBe(false);
  });

  test('别的模型不填窗口也不提醒(CLI 不按 1M 算它们)', () => {
    expect(needsContextWindowWarning({ modelId: 'claude-sonnet-4-5', contextWindow: null })).toBe(false);
    expect(needsContextWindowWarning({ modelId: 'glm-5.2', contextWindow: null })).toBe(false);
  });

  test('isContextWindowMissing:null / 0 / NaN 都算没填', () => {
    expect(isContextWindowMissing(null)).toBe(true);
    expect(isContextWindowMissing(undefined)).toBe(true);
    expect(isContextWindowMissing(0)).toBe(true);
    expect(isContextWindowMissing(Number.NaN)).toBe(true);
    expect(isContextWindowMissing(128_000)).toBe(false);
  });
});

describe('健康度格式化', () => {
  test('formatTtft:不到 1 秒写毫秒,否则一位小数的秒', () => {
    expect(formatTtft(850)).toBe('850ms');
    expect(formatTtft(0)).toBe('0ms');
    expect(formatTtft(849.6)).toBe('850ms');
    expect(formatTtft(999.6)).toBe('1.0s');
    expect(formatTtft(1000)).toBe('1.0s');
    expect(formatTtft(1234)).toBe('1.2s');
    expect(formatTtft(12_345)).toBe('12.3s');
  });

  test('formatTtft:没数据 → null', () => {
    expect(formatTtft(null)).toBeNull();
    expect(formatTtft(undefined)).toBeNull();
    expect(formatTtft(-1)).toBeNull();
    expect(formatTtft(Number.NaN)).toBeNull();
  });

  test('formatFailureRate:整数百分比;有失败但太小写 <1%', () => {
    expect(formatFailureRate(0, 0)).toBe('0%');
    expect(formatFailureRate(0.05, 2)).toBe('5%');
    expect(formatFailureRate(0.125, 1)).toBe('13%');
    expect(formatFailureRate(1, 3)).toBe('100%');
    expect(formatFailureRate(0.002, 1)).toBe('<1%');
  });

  test('isFailureRateHigh:≥ 5 轮且 ≥ 10% 才算', () => {
    expect(isFailureRateHigh({ turns: 5, errorRate: 0.1 })).toBe(true);
    expect(isFailureRateHigh({ turns: 42, errorRate: 0.5 })).toBe(true);
    expect(isFailureRateHigh({ turns: 4, errorRate: 0.5 })).toBe(false);
    expect(isFailureRateHigh({ turns: 100, errorRate: 0.09 })).toBe(false);
  });

  test('topFailureReasons:保持服务端顺序,截前几个,丢掉 0 次的', () => {
    const reasons = [
      { reason: 'prompt_too_long', count: 5 },
      { reason: 'api_error', count: 3 },
      { reason: 'model_error', count: 2 },
      { reason: 'image_error', count: 1 },
      { reason: 'max_turns', count: 0 },
    ];
    expect(topFailureReasons(reasons).map((item) => item.reason)).toEqual(['prompt_too_long', 'api_error', 'model_error']);
    expect(topFailureReasons(reasons, 10).map((item) => item.reason)).toEqual(['prompt_too_long', 'api_error', 'model_error', 'image_error']);
    expect(topFailureReasons([])).toEqual([]);
  });

  test('isKnownFailureReason:列表外的原样显示', () => {
    expect(isKnownFailureReason('prompt_too_long')).toBe(true);
    expect(isKnownFailureReason('unknown')).toBe(true);
    expect(isKnownFailureReason('something_new')).toBe(false);
  });
});

describe('文案键两份 locale 都有(失败原因的键是拼出来的,i18n 守卫扫不到,这里补上)', () => {
  const locales = { 'zh-CN': readLocale('zh-CN'), en: readLocale('en') };

  test.each(Object.keys(locales))('%s:每个已知失败原因都有翻译', (lang) => {
    const dict = locales[lang as keyof typeof locales];
    const missing = KNOWN_FAILURE_REASONS.filter((reason) => typeof lookup(dict, failureReasonKey(reason)) !== 'string');
    expect(missing).toEqual([]);
  });

  test('zh-CN 的失败原因与约定的译名一致', () => {
    const dict = locales['zh-CN'];
    const expected: Record<string, string> = {
      prompt_too_long: '上下文超限',
      rapid_refill_breaker: '反复超限熔断',
      api_error: '网关报错',
      malformed_tool_use_exhausted: '工具调用格式错误',
      model_error: '模型出错',
      image_error: '图片被拒',
      max_turns: '轮数上限',
      budget_exhausted: '预算上限',
      blocking_limit: '用量上限',
      turn_setup_failed: '回合没能开始',
      unknown: '未知',
    };
    for (const reason of KNOWN_FAILURE_REASONS) {
      expect(lookup(dict, failureReasonKey(reason)), reason).toBe(expected[reason]);
    }
  });
});

describe('probeAgo(实测是多久以前做的)', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  test('分钟 / 小时 / 天', () => {
    expect(probeAgo('2026-10-01T11:59:40.000Z', now)).toBe('<1m');
    expect(probeAgo('2026-10-01T11:55:00.000Z', now)).toBe('5m');
    expect(probeAgo('2026-10-01T09:00:00.000Z', now)).toBe('3h');
    expect(probeAgo('2026-09-29T12:00:00.000Z', now)).toBe('2d');
  });
  test('认不出 / 在将来 → 空串', () => {
    expect(probeAgo('not a date', now)).toBe('');
    expect(probeAgo('2026-10-01T12:05:00.000Z', now)).toBe('');
  });
});
