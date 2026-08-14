import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { advancesReplayCursor } from './useChatRealtimeHandlers';

/**
 * 补发游标(`lastSeq`)该为哪些帧推进。
 *
 * 规则是"只为**留下来的**帧推进"。permission 那两种帧既不进 store,又会在不属于
 * 当前所看会话时被直接丢弃 —— 却曾经照样推进游标。后果是一条永远回不来的审批
 * 请求:切回那个会话时 `chat.subscribe` 带的 `lastSeq` 已经越过它,服务端的
 * `replayEvents` 只补 `seq > afterSeq` 的,于是不补;而没有任何地方存过它。
 *
 * 这个 bug 有个很误导人的表象:**整页刷新能恢复,页内切换不能** —— 因为
 * `lastSeqRef` 是个 useRef,刷新才清零。所以它看起来像"偶发",实际上完全确定。
 */
describe('补发游标推进规则', () => {
  test('普通内容帧推进游标', () => {
    for (const kind of ['assistant', 'user', 'tool_use', 'tool_result', 'stream_delta', 'error']) {
      assert.equal(advancesReplayCursor(kind), true, `${kind} 应当推进游标`);
    }
  });

  test('permission 两种帧不推进游标', () => {
    assert.equal(advancesReplayCursor('permission_request'), false);
    assert.equal(advancesReplayCursor('permission_cancelled'), false);
  });

  test('未知的 kind 按推进处理', () => {
    // 保守的方向是推进:漏掉一次补发只是少显示一帧,而重复补发会造成重复消息。
    assert.equal(advancesReplayCursor('some_future_kind'), true);
    assert.equal(advancesReplayCursor(undefined), true);
  });
});
