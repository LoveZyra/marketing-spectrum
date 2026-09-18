import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * gh:审计报告(gg 后)里发送链路那几条的接线测试。
 *
 * 这些都是 handleChatSend 内部的分支,没有可单独调用的纯函数;按这一轮的纪律,
 * 每条把**整句**钉住,不匹配片段(前面加一个 `false &&` 关掉整支也照样是绿的)。
 */
const source = readFileSync(
  fileURLToPath(new URL('../services/chat-websocket.service.ts', import.meta.url)),
  'utf8',
);

describe('#1 / #10 合流带上发送者身份、运行时选项与 hiddenContext', () => {
  it('mergeFn 收到 actorUsername / ownerUserId / runtimeOptions,command 拼了 hiddenContext', () => {
    const call = source.slice(source.indexOf('merged = await mergeFn(sessionId, {'), source.indexOf('} catch (error) {', source.indexOf('merged = await mergeFn(sessionId, {')));
    expect(call).toMatch(/command: mergeHiddenContext \? `\$\{rawContent\}\\n\\n\$\{mergeHiddenContext\}` : rawContent,/);
    expect(call).toMatch(/actorUsername: authUsername,/);
    expect(call).toMatch(/ownerUserId: authUserId,/);
    expect(call).toMatch(/runtimeOptions: pickClientRuntimeOptions\(mergeClientOptions\),/);
  });

  it('hiddenContext 在合流分支用的是与 spawn 那条路同一套截断规则(16KB + trim)', () => {
    expect(source).toMatch(/const mergeHiddenContext = typeof mergeClientOptions\.hiddenContext === 'string'\s*\n\s*\? mergeClientOptions\.hiddenContext\.slice\(0, 16_384\)\.trim\(\)/);
  });

  it('依赖类型里声明了这三个字段 —— 组合根接线时类型会逼着传', () => {
    expect(source).toMatch(/actorUsername\?: string \| null;\s*\n\s*ownerUserId\?: number \| null;\s*\n\s*runtimeOptions\?: AnyRecord;/);
  });
});

describe('#6 重新排队也算"服务端收下了"', () => {
  it('!run 分支的排队路径调了 drainToken.onAccepted —— 否则 .finally 会把它当 undeliverable 丢掉', () => {
    const requeueStart = source.indexOf('const pending: PendingSend = {');
    const requeue = source.slice(
      requeueStart,
      source.indexOf("sendSendAck(ws, sessionId, clientMessageId, 'accepted');\n    return;\n  }", requeueStart),
    );
    expect(requeue).toMatch(/drainToken\?\.onAccepted\?\.\(\);/);
    /**
     * 顺序:onAccepted 会广播 chat_queue_flushed,必须在重新广播 chat_queued **之前** ——
     * 反过来客户端最后收到的是"队列空了",而队列里明明还有这一条(gh 自查时抓到的)。
     */
    expect(requeue.indexOf('drainToken?.onAccepted?.();'))
      .toBeLessThan(requeue.indexOf('broadcastToSessionViewersPerViewer(sessionId, (viewer) => queuedFrame(sessionId, pending, viewer));'));
  });
});

describe('#7 分叉不能接在已有历史的会话后面', () => {
  it('startRun 之前:目标会话有原生 id 且带 forkFrom → 协议错误 + 退还幂等键,不再无声丢弃', () => {
    const at = source.indexOf("'FORK_TARGET_HAS_HISTORY'");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(source.indexOf('const run = chatRunRegistry.startRun({'));
    expect(source.slice(at - 200, at)).toMatch(/if \(session\.provider_session_id && \(data\.options as AnyRecord \| undefined\)\?\.forkFrom\) \{/);
    expect(source.slice(at, at + 400)).toMatch(/releaseSendKey\(\);\s*\n\s*return;/);
  });
});

describe('#25 排队消息的正文只给排它的人(三条路都脱敏)', () => {
  it('chat_subscribed:preview 按 isPendingOwner 给,并带 redacted 标记', () => {
    expect(source).toMatch(/preview: isPendingOwner\(pending, readSocketViewer\(ws\)\) \? pending\.preview : '',\s*\n\s*redacted: !isPendingOwner\(pending, readSocketViewer\(ws\)\),/);
  });

  it('chat_queued:按查看者分别造帧(gi 自查:gh 只改了 subscribe 那一条,广播那条仍在漏)', () => {
    expect(source).toMatch(/broadcastToSessionViewersPerViewer\(sessionId, \(viewer\) => queuedFrame\(sessionId, pending, viewer\)\);/);
    expect(source).toMatch(/preview: own \? pending\.preview : '',\s*\n\s*redacted: !own,/);
    // 不许再有整包广播 chat_queued 的老写法
    expect(source).not.toMatch(/broadcastToSessionViewers\(sessionId, queuedFrame\(/);
  });

  it('chat_queue_cancelled:退回的正文只退给排它的人', () => {
    expect(source).toMatch(/\.\.\.\(content && pending && isPendingOwner\(pending, viewer\) \? \{ content \} : \{\}\),/);
  });
});

describe('#27 附件台账的绝对路径回退分支也校验发送者', () => {
  it('owner.sessionId 之外还要 owner.userId === actorUserId(或调用方没给 actor)', () => {
    expect(source).toMatch(/if \(owner && owner\.sessionId === sessionId && \(actorUserId === null \|\| actorUserId === undefined \|\| String\(owner\.userId\) === String\(actorUserId\)\)\) \{/);
  });
});
