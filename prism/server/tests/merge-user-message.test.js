import assert from 'node:assert/strict';

import { describe, expect, it } from 'vitest';

import { mergeRefusalReason, mergeUserMessage } from '../claude-sdk.js';

/**
 * 合流的边界。
 *
 * 会话忙着时,排队是把消息放进 Prism 自己的 `pendingSends`、画一张「已排队」卡片,等这一轮跑完再由 Prism
 * 重新发起一轮;合流则把它直接推进 CLI 的命令队列(`Query.streamInput` 是独立的 `for await` 循环,
 * 原样透传整个对象;`SDKUserMessage.priority` 决定投递时机),模型在这一轮里就能看到。
 *
 * 合流是增强而不是替换:任何一条边界不成立都要退回排队。这一份钉的就是那几条边界:判错一条,
 * 轻则消息卡住,重则把用户的话推进一个不该收它的 runtime。
 */
describe('mergeRefusalReason', () => {
  /**
   * "正常"的 runtime 正跑着一个用户回合:合流的定义就是并进正在跑的回合。
   * `turn: null` 的 runtime 处在两段危险窗口里(回合起点 / 末尾),合流进去的回复会整批丢失。
   */
  const liveRuntime = {
    disposed: false,
    suspect: false,
    turn: { internal: false },
    input: { push() {} },
    ownerUserId: 7,
    actorUsername: 'alice',
    settings: { permissionMode: 'acceptEdits', allowedTools: [], disallowedTools: [] },
  };

  it('一切正常 → 不拒绝', () => {
    assert.equal(mergeRefusalReason(liveRuntime, '把配置也改一下'), null);
  });

  it('没有用户回合在跑 → 退回排队(回合起点/末尾那两段窗口里合流进去的回复会整批丢失)', () => {
    assert.equal(mergeRefusalReason({ ...liveRuntime, turn: null }, 'x'), 'no-turn');
  });

  it('发送者不是这个 runtime 的主人 → 退回排队(不能借别人的 bypass 档跑命令)', () => {
    assert.equal(
      mergeRefusalReason(liveRuntime, 'rm -rf /', { actorUsername: 'bob', ownerUserId: 8 }),
      'actor-mismatch',
    );
    // 同名不同 id / 同 id 不同名,都不算同一个人
    assert.equal(
      mergeRefusalReason(liveRuntime, 'x', { actorUsername: 'alice', ownerUserId: 8 }),
      'actor-mismatch',
    );
    assert.equal(
      mergeRefusalReason(liveRuntime, 'x', { actorUsername: 'bob', ownerUserId: 7 }),
      'actor-mismatch',
    );
  });

  it('同一个人、同一档位 → 合流;同一个人换了档位 → 退回排队', () => {
    const same = { actorUsername: 'alice', ownerUserId: 7, runtimeOptions: { permissionMode: 'acceptEdits' } };
    assert.equal(mergeRefusalReason(liveRuntime, 'x', same), null);
    const switched = { actorUsername: 'alice', ownerUserId: 7, runtimeOptions: { permissionMode: 'plan' } };
    assert.equal(mergeRefusalReason(liveRuntime, 'x', switched), 'policy-mismatch');
  });

  it('不带身份的老调用方照旧只看回合状态(兼容)', () => {
    assert.equal(mergeRefusalReason(liveRuntime, 'x', {}), null);
  });

  it('空正文不合流 —— 只发图片那条路这一版走排队', () => {
    assert.equal(mergeRefusalReason(liveRuntime, ''), 'empty');
    assert.equal(mergeRefusalReason(liveRuntime, '   \n  '), 'empty');
    assert.equal(mergeRefusalReason(liveRuntime, undefined), 'empty');
  });

  it('没有常驻 runtime → 退回排队(一次性路径、runtime 被淘汰过)', () => {
    assert.equal(mergeRefusalReason(null, 'x'), 'no-runtime');
  });

  it('runtime 已废弃 → 退回排队', () => {
    assert.equal(mergeRefusalReason({ ...liveRuntime, disposed: true }, 'x'), 'disposed');
  });

  it('runtime 被标 suspect → 退回排队(它还在跑东西而 Prism 不再跟踪了)', () => {
    assert.equal(mergeRefusalReason({ ...liveRuntime, suspect: true }, 'x'), 'suspect');
  });

  it('那一轮已被停止、还在收尾 → 退回排队(合流进去只会排到停止后重发的那一条前面)', () => {
    assert.equal(mergeRefusalReason({ ...liveRuntime, turn: { stopping: true } }, 'x'), 'turn-stopping');
  });

  it('正在跑回合 → 照常合流(这正是合流要解决的场景)', () => {
    assert.equal(mergeRefusalReason({ ...liveRuntime, turn: {} }, 'x'), null);
  });
});

describe('mergeUserMessage', () => {
  it('这段对话没有常驻 runtime 时安静地退回排队,不抛', async () => {
    const result = await mergeUserMessage('session-with-no-runtime', { command: '你好' });
    expect(result.merged).toBe(false);
    // 常驻被关掉时是 persistent-disabled,否则是 no-runtime —— 两种都算"退回排队"
    expect(['no-runtime', 'persistent-disabled']).toContain(result.reason);
  });

  it('appSessionId 为空时也不抛(合流失败绝不能把发送带崩)', async () => {
    const result = await mergeUserMessage('', { command: '你好' });
    expect(result.merged).toBe(false);
  });
});

/**
 * 上面证明判据对,下面证明调用方真的按它分流:判据写对了、接线却没接上,是这里最容易出的错。
 */
describe('合流的接线', () => {
  it('mergeUserMessage 用的是同一份判据,没有自己再写一遍', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sdk = readFileSync(fileURLToPath(new URL('../claude-sdk.js', import.meta.url)), 'utf8');
    const fn = sdk.slice(sdk.indexOf('export async function mergeUserMessage'));
    // 第三个参数是发送者身份与运行时选项;判据仍只有这一处
    expect(fn.slice(0, 900)).toMatch(/const refusal = mergeRefusalReason\(runtime, command, options\);/);
    expect(fn.slice(0, 900)).toMatch(/if \(refusal\) return \{ merged: false, reason: refusal \};/);
  });

  it('推进去的那条带 priority,而且 uuid 是自己生成并带上的', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sdk = readFileSync(fileURLToPath(new URL('../claude-sdk.js', import.meta.url)), 'utf8');
    const fn = sdk.slice(sdk.indexOf('export async function mergeUserMessage'));
    // 插话用 'next'('now' 会打断这一轮,撤回后原任务无声停住 —— 见 mergeUserMessage 的说明)
    expect(fn.slice(0, 2600)).toMatch(/priority: 'next',/);
    expect(fn.slice(0, 2600)).not.toMatch(/priority: 'now',/);
    expect(fn.slice(0, 2600)).toMatch(/uuid,/);
  });

  it('找 runtime 时必须用 appSessionId 复核 —— 找错一个就是把话推进别人的对话', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sdk = readFileSync(fileURLToPath(new URL('../claude-sdk.js', import.meta.url)), 'utf8');
    const fn = sdk.slice(sdk.indexOf('function runtimeForMerge'), sdk.indexOf('export function mergeRefusalReason'));
    expect(fn).toMatch(/direct\.appSessionId === appSessionId/);
    expect(fn).toMatch(/runtime\.appSessionId === appSessionId/);
  });

  it('chat.send 的排队分支先试合流,而且三条边界都在', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const chat = readFileSync(
      fileURLToPath(new URL('../modules/websocket/services/chat-websocket.service.ts', import.meta.url)),
      'utf8',
    );
    const branch = chat.slice(chat.indexOf('const mergeFn = dependencies.mergeFns?.[provider];'));
    // 三条边界:带图不合流 / 已经有一条在排队不合流 / 正文非空。
    // 整条 if 一字不差地钉住:只匹配片段的话,前面加一个 `false &&` 关掉整支也照样是绿的。
    expect(branch.slice(0, 900)).toMatch(
      /if \(mergeFn && !carriesImages && !pendingSends\.has\(sessionId\) && rawContent\.trim\(\)\) \{/,
    );
    // 合流成功要落库 + 推实时帧 + 记一笔 + 回 ACK,而且不进 pendingSends
    const upToQueue = branch.slice(0, branch.indexOf('pendingSends.set(sessionId, pending);'));
    expect(upToQueue).toMatch(/sessionMessagesDb\.append\(sessionId, mergedRow\);/);
    expect(upToQueue).toMatch(/chatRunRegistry\.broadcastWithoutPersist\(sessionId, mergedRow\);/);
    // 记下 uuid 与那一行(撤回要用;没落库也记行 id,那一行已经作为实时帧发出去了),ACK 带上合流 uuid
    expect(upToQueue).toMatch(/rememberMergedRow\(merged\.uuid, \{ sessionId, rowId: mergedRowId, clientMessageId \}\);/);
    expect(upToQueue).toMatch(/sendSendAck\(ws, sessionId, clientMessageId, 'accepted', merged\.uuid \?\? null\);/);
    // 合流那一支必须 return —— 掉下去就会既合流又排队,同一句话发两遍
    expect(upToQueue).toMatch(/return;\n\s*\}\n\s*log\.info/);
  });

  it('组合根接了 mergeFns', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const root = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');
    expect(root).toMatch(/mergeFns: \{ claude: mergeUserMessage \}/);
  });
});
