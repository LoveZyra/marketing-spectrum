import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { advancesReplayCursor } from './useChatRealtimeHandlers';

/**
 * 补发游标(`lastSeq`)该为哪些帧推进:只为留下来的帧推进。
 *
 * permission 那两种帧既不进 store,又会在不属于当前所看会话时被直接丢弃。若它们推进游标,
 * 切回那个会话时 `chat.subscribe` 带的 `lastSeq` 已越过它,服务端 `replayEvents` 只补
 * `seq > afterSeq` 的帧,这条审批请求就再也回不来。
 * `lastSeqRef` 只在整页刷新时清零,所以这种丢失只出现在页内切换会话时。
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
