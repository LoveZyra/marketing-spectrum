import assert from 'node:assert/strict';

import { afterEach, describe, test } from 'vitest';

import {
  claimForShell,
  currentHolder,
  releaseShellClaim,
  resetConversationOwnership,
} from '@/modules/websocket/services/conversation-ownership.service.js';

afterEach(() => resetConversationOwnership());

describe('对话所有权(chat / 终端互斥)', () => {
  test('默认没有登记 —— chat 可用,不需要先"认领"', () => {
    // 常见路径(只用 chat)必须零登记:否则一旦漏了释放,chat 会被自己锁死。
    assert.equal(currentHolder('s1'), null);
  });

  test('终端接管后登记持有者,带上是谁 —— chat 那边要能说清楚"被谁占着"', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });

    const holder = currentHolder('s1');
    assert.equal(holder?.panel, 'shell');
    assert.equal(holder?.username, 'bob');
    assert.equal(holder?.userId, 7);
    assert.ok(holder?.since);
  });

  test('只影响被接管的那个会话', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });
    assert.equal(currentHolder('s2'), null);
  });

  test('释放之后 chat 立刻可用', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });
    releaseShellClaim('s1');
    assert.equal(currentHolder('s1'), null);
  });

  test('释放一个没登记的会话不报错 —— PTY 退出路径不该因为这个抛异常', () => {
    assert.doesNotThrow(() => releaseShellClaim('never-claimed'));
  });

  test('重复接管按最后一次算,不会留下两个持有者', () => {
    claimForShell('s1', { userId: 7, username: 'bob' });
    claimForShell('s1', { userId: 8, username: 'carol' });
    assert.equal(currentHolder('s1')?.username, 'carol');

    releaseShellClaim('s1');
    assert.equal(currentHolder('s1'), null);
  });

  test('没有用户信息时也能登记 —— 平台模式下拿不到用户名,不能因此拒绝接管', () => {
    claimForShell('s1', {});
    const holder = currentHolder('s1');
    assert.equal(holder?.panel, 'shell');
    assert.equal(holder?.username, null);
  });
});
