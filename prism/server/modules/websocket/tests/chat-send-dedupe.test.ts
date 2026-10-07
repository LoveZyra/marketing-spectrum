import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  SEND_DEDUPE_MAX_PER_SESSION,
  SEND_DEDUPE_TTL_MS,
  forgetSend,
  forgetSession,
  registerSend,
  resetSendDedupeForTest,
  sendDedupeSizeForTest,
} from '../services/chat-send-dedupe.js';

/**
 * `chat.send` 的幂等门。
 *
 * `socket.send()` 不抛异常只代表写进了本地发送缓冲。socket 在写入之后、服务端读到之前断开是
 * 很常见的一瞬,这一瞬里前端已经清了草稿、画了乐观气泡;用户看不到回应就会重发,如果服务端
 * 其实收到了第一条,就是真的发两遍:模型跑两轮、改两遍文件。
 */
beforeEach(() => {
  resetSendDedupeForTest();
});

describe('registerSend', () => {
  it('第一次见到的键放行', () => {
    expect(registerSend('s1', 'cmd_a')).toBe(true);
  });

  it('同一个键第二次到达 → 拦下(这就是重发那一下)', () => {
    expect(registerSend('s1', 'cmd_a')).toBe(true);
    expect(registerSend('s1', 'cmd_a')).toBe(false);
    expect(registerSend('s1', 'cmd_a')).toBe(false);
  });

  it('不同会话各记各的 —— 键撞了也不该互相影响', () => {
    expect(registerSend('s1', 'cmd_a')).toBe(true);
    expect(registerSend('s2', 'cmd_a')).toBe(true);
  });

  it('没有幂等键的请求一律放行(老客户端、外部 API)', () => {
    // 幂等是能力增强,不是准入条件 —— 拿它当门槛会把老客户端全挡在外面。
    expect(registerSend('s1', undefined)).toBe(true);
    expect(registerSend('s1', undefined)).toBe(true);
    expect(registerSend('s1', null)).toBe(true);
    expect(registerSend('s1', '')).toBe(true);
    expect(registerSend('s1', 42)).toBe(true);
    expect(sendDedupeSizeForTest('s1')).toBe(0);
  });

  it('过了窗口就不再记得 —— 隔天又发同一句话是正常操作', () => {
    const t0 = 1_000_000;
    expect(registerSend('s1', 'cmd_a', t0)).toBe(true);
    expect(registerSend('s1', 'cmd_a', t0 + SEND_DEDUPE_TTL_MS - 1)).toBe(false);
    expect(registerSend('s1', 'cmd_a', t0 + SEND_DEDUPE_TTL_MS + 1)).toBe(true);
  });

  it('窗口内重复会刷新记忆点,连续重试不会因为超时而漏过去', () => {
    const t0 = 1_000_000;
    registerSend('s1', 'cmd_a', t0);
    // 半个窗口之后又撞一次:仍然拦下
    expect(registerSend('s1', 'cmd_a', t0 + SEND_DEDUPE_TTL_MS / 2)).toBe(false);
    // 从首次登记起算超时(拦下的那次不刷新时间戳),所以这里放行
    expect(registerSend('s1', 'cmd_a', t0 + SEND_DEDUPE_TTL_MS + 1)).toBe(true);
  });

  it('每条会话的键数有上限,长会话不会把内存撑起来', () => {
    for (let i = 0; i < SEND_DEDUPE_MAX_PER_SESSION + 50; i++) {
      registerSend('s1', `cmd_${i}`);
    }
    expect(sendDedupeSizeForTest('s1')).toBeLessThanOrEqual(SEND_DEDUPE_MAX_PER_SESSION);
  });

  it('超量时丢的是最早的键(最近的重发才是要防的那一批)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < SEND_DEDUPE_MAX_PER_SESSION + 10; i++) {
      registerSend('s1', `cmd_${i}`, t0 + i);
    }
    const now = t0 + SEND_DEDUPE_MAX_PER_SESSION + 10;
    // 最早那几个已经被挤掉 —— 再来会被当成新的
    expect(registerSend('s1', 'cmd_0', now)).toBe(true);
    // 最近那个还记得
    expect(registerSend('s1', `cmd_${SEND_DEDUPE_MAX_PER_SESSION + 9}`, now)).toBe(false);
  });

  it('会话清账之后重新开始', () => {
    registerSend('s1', 'cmd_a');
    forgetSession('s1');
    expect(registerSend('s1', 'cmd_a')).toBe(true);
  });
});

/**
 * 没回 ACK 的早退,必须把幂等键退回去。
 *
 * 这张表的契约是"收到 ACK 才算发出去了"。`handleChatSend` 在可见性检查之后立刻登记键,
 * 之后的早退分支都不回 ACK;键不退回的话,遵守契约的重投会撞上去重、拿到假的
 * `duplicate` ACK,前端据此清盘:这条消息既没执行,也没有任何痕迹。
 */
describe('forgetSend', () => {
  it('退还之后同一个键可以重新登记(相当于这一次从没发生过)', () => {
    expect(registerSend('s1', 'cmd_a')).toBe(true);
    expect(registerSend('s1', 'cmd_a')).toBe(false);
    forgetSend('s1', 'cmd_a');
    expect(registerSend('s1', 'cmd_a')).toBe(true);
  });

  it('只退还指定的那一个键,别人不受影响', () => {
    registerSend('s1', 'cmd_a');
    registerSend('s1', 'cmd_b');
    forgetSend('s1', 'cmd_a');
    expect(registerSend('s1', 'cmd_a')).toBe(true);
    expect(registerSend('s1', 'cmd_b')).toBe(false);
  });

  it('没有键 / 没有这条会话 → 什么都不做,也不炸', () => {
    expect(() => forgetSend('never-seen', 'cmd_x')).not.toThrow();
    expect(() => forgetSend('s1', null)).not.toThrow();
    expect(() => forgetSend('s1', '')).not.toThrow();
  });

  it('退空了就把这条会话的表也收掉,不留空壳', () => {
    registerSend('s1', 'cmd_a');
    forgetSend('s1', 'cmd_a');
    expect(sendDedupeSizeForTest('s1')).toBe(0);
  });
});

/**
 * 上面几条只证明"退还这个动作是对的",证明不了调用方真的退了。
 *
 * `handleChatSend` 需要真的 socket / 数据库 / provider 才跑得起来,这里挂不起来,所以退一步读源码:
 * 幂等门与"已收下"的 ACK 之间,每一条 `return;` 前面都必须有一句退还。漏掉一条,这里立刻红。
 */
describe('handleChatSend 的八条早退都退还了幂等键', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../services/chat-websocket.service.ts', import.meta.url)),
    'utf8',
  );

  it('幂等门与"已收下"ACK 之间的每一条 return 都先退还', () => {
    const gate = source.indexOf('const releaseSendKey =');
    const acceptedAck = source.indexOf("sendSendAck(ws, sessionId, clientMessageId, 'accepted');");
    expect(gate).toBeGreaterThan(0);
    expect(acceptedAck).toBeGreaterThan(gate);

    const lines = source.slice(gate, acceptedAck).split('\n');
    const returns = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line === 'return;');
    // 终端接管 / provider 不支持 / 模型不在目录里或已下架(MODEL_NOT_ALLOWED)/ 准备期被停止 /
    // 抄历史后的两道复检 / 分叉目标已有历史(FORK_TARGET_HAS_HISTORY)
    expect(returns.length).toBe(7);
    for (const { index } of returns) {
      expect(lines[index - 1].trim()).toBe('releaseSendKey();');
    }
  });

  it('第八条(排队位已满)也退还 —— 它在 ACK 之后的 !run 分支里', () => {
    const queueFull = source.indexOf("'QUEUE_FULL'");
    expect(queueFull).toBeGreaterThan(0);
    expect(source.slice(queueFull, queueFull + 400)).toMatch(/releaseSendKey\(\);\n\s*return;/);
  });

  it('续发不过幂等门,所以也不该由它来退还别人的键', () => {
    // `isDrainReentry` 只挡登记,退还是按键做的(键本身是排队那一条登记的)。
    expect(source).toMatch(/const isDrainReentry = Boolean\(drainToken\);/);
    expect(source).toMatch(/if \(!isDrainReentry && !registerSend\(sessionId, clientMessageId\)\)/);
  });
});
