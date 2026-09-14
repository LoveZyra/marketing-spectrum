import { describe, expect, it } from 'vitest';

import { lookbackForToolGroups } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * F37:页边界不许把一次工具调用和它的结果拆开。
 *
 * 分页按原始事件切,而工具调用与结果是两条独立事件。边界落在中间时,这一页
 * 第一条就是找不到 `tool_use` 的结果 —— 前端会跳过渲染,上一页里对应的调用
 * 显示成"没有结果"。
 *
 * fj 的处理是**把那几条丢掉**,而注释写的是"往前挪把 tool_use 带进来" ——
 * 代码和注释做的是相反的事。丢掉还有个不明显的代价:调用方按**服务端返回的
 * 条数**推进 offset,少返回几条就少走几格,下一页窗口与这一页重叠,去重后
 * 净增可能是 0 —— 上翻卡在同一个位置。
 *
 * 所以往**更早**的方向扩:游标自洽,内容也不丢。
 */
const msg = (kind: string, toolId?: string, id = `${kind}_${toolId ?? Math.random()}`): NormalizedMessage => ({
  id,
  kind,
  ...(toolId ? { toolId } : {}),
} as unknown as NormalizedMessage);

describe('lookbackForToolGroups', () => {
  it('页首不是 tool_result → 不用挪', () => {
    expect(lookbackForToolGroups([msg('tool_use', 't1')], [msg('text')])).toBe(0);
  });

  it('页首是孤儿 result,前一条正好是它的 use → 挪 1 条', () => {
    const older = [msg('text'), msg('tool_use', 't1')];
    const page = [msg('tool_result', 't1'), msg('text')];
    expect(lookbackForToolGroups(older, page)).toBe(1);
  });

  it('连着两条孤儿 result → 挪到把两个 use 都带进来为止', () => {
    const older = [msg('tool_use', 't1'), msg('tool_use', 't2')];
    const page = [msg('tool_result', 't1'), msg('tool_result', 't2'), msg('text')];
    expect(lookbackForToolGroups(older, page)).toBe(2);
  });

  it('中间隔着别的行也要一路挪过去', () => {
    const older = [msg('tool_use', 't1'), msg('thinking'), msg('text')];
    const page = [msg('tool_result', 't1')];
    expect(lookbackForToolGroups(older, page)).toBe(3);
  });

  it('页内自己就有对应的 use → 不用挪', () => {
    const page = [msg('tool_result', 't1'), msg('tool_use', 't1')];
    expect(lookbackForToolGroups([msg('text')], page)).toBe(0);
  });

  it('**只看页首连续那一段** —— 页中间的 result 自然有它的 use 在同页', () => {
    const page = [msg('text'), msg('tool_result', 't9')];
    expect(lookbackForToolGroups([msg('tool_use', 't9')], page)).toBe(0);
  });

  it('没有 toolId 的 result 不参与配对(配不上也不该拖着整页走)', () => {
    expect(lookbackForToolGroups([msg('tool_use', 't1')], [msg('tool_result')])).toBe(0);
  });

  it('older 里根本没有那个 use(已经是最早一页)→ 返回 0,调用方退回丢弃', () => {
    const older = [msg('text'), msg('thinking')];
    expect(lookbackForToolGroups(older, [msg('tool_result', 'missing')])).toBe(0);
  });

  it('older 为空 → 0', () => {
    expect(lookbackForToolGroups([], [msg('tool_result', 't1')])).toBe(0);
  });

  it('超过上限还配不齐 → 0(不把分页拉成没有边界)', () => {
    const older = Array.from({ length: 60 }, () => msg('text'));
    older[0] = msg('tool_use', 't1');   // 在 60 条之前,远超上限
    expect(lookbackForToolGroups(older, [msg('tool_result', 't1')])).toBe(0);
  });

  it('恰好在上限内配齐 → 挪', () => {
    const older = Array.from({ length: 24 }, () => msg('text'));
    older[0] = msg('tool_use', 't1');   // 倒数第 24 条
    expect(lookbackForToolGroups(older, [msg('tool_result', 't1')])).toBe(24);
  });
});
