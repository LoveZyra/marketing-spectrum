import { describe, expect, it } from 'vitest';

import { extractNativeUuid } from '@/modules/system/usage.routes.js';

/**
 * 「编辑重跑」的分叉点定位:从网页消息 id 里取回 jsonl 的原生 uuid。
 *
 * 网页那侧的消息 id 有两种来源,形状完全不同:
 *   - 从 transcript 读来的历史行 → id 就是 jsonl 的 uuid,可能带展示后缀;
 *   - 来自显示日志(权威来源)的行 → id 是应用自己生成的(`text_…`)。
 *
 * 第二种必须认不出来(返回 null),端点据此明确报错。若从中切出 `text` 之类去扫 transcript,必然扫不到,
 * 返回 `resumeSessionAt: null` + 200 就会让「编辑重跑」静默变成「整段历史从头重跑」。
 */
const UUID = '9f3b2c1a-4d5e-4f60-8a71-b2c3d4e5f607';

describe('extractNativeUuid', () => {
  it('裸 uuid', () => {
    expect(extractNativeUuid(UUID)).toBe(UUID);
  });

  it('带展示后缀的三种形状都认', () => {
    expect(extractNativeUuid(`${UUID}_text`)).toBe(UUID);
    expect(extractNativeUuid(`${UUID}_images`)).toBe(UUID);
    expect(extractNativeUuid(`${UUID}_tr_toolu_01`)).toBe(UUID);
  });

  it('显示日志的 id 认不出来 —— 这正是要拦下的那一类', () => {
    // 不能按下划线切出 "text" 当 uuid 去扫 transcript,注定扫不到。
    expect(extractNativeUuid('text_1757400000000_ab12cd')).toBeNull();
    expect(extractNativeUuid('local_1757400000000')).toBeNull();
    expect(extractNativeUuid('protocol_error_1757400000000')).toBeNull();
  });

  it('空 / 非字符串 → null', () => {
    expect(extractNativeUuid('')).toBeNull();
    expect(extractNativeUuid(undefined as unknown as string)).toBeNull();
  });

  it('长得像但不合规的一律不认(宁可报错也不拿它去扫)', () => {
    expect(extractNativeUuid('9f3b2c1a-4d5e-4f60-8a71')).toBeNull();
    expect(extractNativeUuid('zzzzzzzz-4d5e-4f60-8a71-b2c3d4e5f607')).toBeNull();
  });

  it('大写 uuid 也认(jsonl 里两种写法都出现过)', () => {
    expect(extractNativeUuid(UUID.toUpperCase())).toBe(UUID.toUpperCase());
  });
});
