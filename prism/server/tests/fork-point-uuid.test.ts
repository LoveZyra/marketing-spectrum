import { describe, expect, it } from 'vitest';

import { extractNativeUuid } from '@/modules/system/usage.routes.js';

/**
 * F14:「编辑重跑」的分叉点定位。
 *
 * 网页那侧的消息 id 有两种来源,形状完全不同:
 *   - 从 transcript 读来的历史行 → id 就是 jsonl 的 uuid,可能带展示后缀;
 *   - **fj 之后**显示日志成了权威来源 → id 是应用自己生成的(`text_…`)。
 *
 * 第二种切出来是 `text` 这种垃圾,扫描必然扫不到,而端点此前照样返回
 * `resumeSessionAt: null` + 200 —— 客户端拿着它开跑,**「编辑重跑」静默变成
 * 「整段历史从头重跑」**,没有任何提示。
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

  it('**显示日志的 id 认不出来** —— 这正是要拦下的那一类', () => {
    // 旧代码在这里会切出 "text",然后拿它去扫 transcript,注定扫不到。
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
