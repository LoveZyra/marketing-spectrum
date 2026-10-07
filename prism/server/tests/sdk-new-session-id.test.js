import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { mapCliOptionsToSDK } from '../claude-sdk.js';

/**
 * 「新建会话且 id 由调用方定」全靠 SDK 的 `Options.sessionId`。
 *
 * 它和 `resume` 是互斥的两件事:一个是"开一段新的,用这个 id",
 * 一个是"接着那段旧的写"。CLI 明确拒绝同时给两个,所以这里必须二选一,
 * 不能两个都往 sdkOptions 上放。
 *
 * "什么都不传"也要测:这段映射每个回合都会跑,server 又是 ESM(严格模式),
 * 引用一个没解构出来的变量会让每一个回合都抛 ReferenceError,而不只是传了 newSessionId 的那些。
 */
describe('mapCliOptionsToSDK —— 新建指定 id vs 续对话', () => {
  test('什么都不传时两个都不下发 —— CLI 自己发一个新 id', () => {
    const sdk = mapCliOptionsToSDK({});
    assert.equal(sdk.sessionId, undefined);
    assert.equal(sdk.resume, undefined);
  });

  test('只给 sessionId 是续对话', () => {
    const sdk = mapCliOptionsToSDK({ sessionId: 'old-one' });
    assert.equal(sdk.resume, 'old-one');
    assert.equal(sdk.sessionId, undefined);
  });

  test('给了 newSessionId 就是新建,落盘文件名即这个 id', () => {
    const sdk = mapCliOptionsToSDK({ newSessionId: 'c0c9b6bf-bf3d-4936-a655-460f5d2d10db' });
    assert.equal(sdk.sessionId, 'c0c9b6bf-bf3d-4936-a655-460f5d2d10db');
    assert.equal(sdk.resume, undefined);
  });

  test('两个都给时新建优先,且绝不同时下发 —— CLI 会拒绝这种组合', () => {
    const sdk = mapCliOptionsToSDK({ sessionId: 'old-one', newSessionId: 'brand-new' });
    assert.equal(sdk.sessionId, 'brand-new');
    assert.equal(sdk.resume, undefined);
  });

  test('空串按"没给"处理,不会下发一个空 id', () => {
    const sdk = mapCliOptionsToSDK({ newSessionId: '', sessionId: 'old-one' });
    assert.equal(sdk.resume, 'old-one');
    assert.equal(sdk.sessionId, undefined);
  });
});
