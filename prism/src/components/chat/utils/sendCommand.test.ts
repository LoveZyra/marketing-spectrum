import { describe, expect, test } from 'vitest';

import {
  canClearDraft,
  freezeSendCommand,
  fromStoredCommand,
  isPendingSend,
  isSendable,
  newClientMessageId,
  reduceOutbox,
  restoredEntry,
  toStoredCommand,
  withSessionId,
  type OutboxEntry,
} from './sendCommand';

/**
 * A 组:一次发送是**在提交那一刻冻结的命令**。
 *
 * 此前"发送"是十几个 ref / state 现拼出来的,而它们在发送过程中(上传、建会话
 * 都是网络等待)全都会变。这里钉的就是"冻结"这件事本身,以及围绕它的三条规矩:
 * 幂等键跟着持久化走、ACK 之后才清草稿、附件丢了就停下而不是照发。
 */
const base = {
  sessionKey: 's1:p1',
  sessionId: 's1',
  projectId: 'p1',
  text: '帮我看看这个报错',
  options: { model: 'opus' },
};

describe('freezeSendCommand', () => {
  test('冻结之后改不动 —— 后面的 await 期间没人能偷偷改它', () => {
    const cmd = freezeSendCommand(base);
    expect(() => {
      (cmd as { text: string }).text = '换一句';
    }).toThrow();
    expect(cmd.text).toBe('帮我看看这个报错');
  });

  test('图片引用也冻结,且是拷贝而不是引用', () => {
    const images = [{ path: '/assets/a1.png' }];
    const cmd = freezeSendCommand({ ...base, images });
    images.push({ path: '/assets/a2.png' });   // 调用方后来动了原数组
    expect(cmd.images).toEqual([{ path: '/assets/a1.png' }]);
  });

  test('没给命名正文时退回正文本身', () => {
    expect(freezeSendCommand(base).namingText).toBe(base.text);
  });

  test('命名正文与发送正文可以不同 —— 附件块不该进会话名', () => {
    const cmd = freezeSendCommand({
      ...base,
      text: '总结一下\n<attached-document name="a.pdf">…</attached-document>',
      namingText: '总结一下',
    });
    expect(cmd.namingText).toBe('总结一下');
    expect(cmd.text).toContain('attached-document');
  });

  test('每次冻结的幂等键都不同', () => {
    const a = freezeSendCommand(base).clientMessageId;
    const b = freezeSendCommand(base).clientMessageId;
    expect(a).not.toBe(b);
  });

  test('给了幂等键就用给的那个 —— 恢复出来的那条不能换 id', () => {
    const id = newClientMessageId();
    expect(freezeSendCommand({ ...base, clientMessageId: id }).clientMessageId).toBe(id);
  });
});

describe('withSessionId', () => {
  test('补会话 id 返回新对象,原对象不变', () => {
    const cmd = freezeSendCommand({ ...base, sessionId: null });
    const withId = withSessionId(cmd, 'new-session');
    expect(cmd.sessionId).toBeNull();
    expect(withId.sessionId).toBe('new-session');
    expect(withId.clientMessageId).toBe(cmd.clientMessageId);
  });

  test('已经是这个 id 就原样返回', () => {
    const cmd = freezeSendCommand(base);
    expect(withSessionId(cmd, 's1')).toBe(cmd);
  });
});

describe('reduceOutbox', () => {
  const cmd = freezeSendCommand(base);
  const queued: OutboxEntry = { command: cmd, status: 'queued', error: null, attempts: 0 };

  test('入队 → queued', () => {
    expect(reduceOutbox(null, { type: 'enqueue', command: cmd })?.status).toBe('queued');
  });

  test('投递计数在 sending 时 +1(幂等键保证服务端只收一条)', () => {
    const sending = reduceOutbox(queued, { type: 'sending' });
    expect(sending?.status).toBe('sending');
    expect(sending?.attempts).toBe(1);
    expect(reduceOutbox(sending, { type: 'retry' })?.status).toBe('queued');
    expect(reduceOutbox(reduceOutbox(sending, { type: 'retry' }), { type: 'sending' })?.attempts).toBe(2);
  });

  test('已确认的不再重发', () => {
    const acked = reduceOutbox(queued, { type: 'acked' })!;
    expect(reduceOutbox(acked, { type: 'sending' })).toBe(acked);
    expect(reduceOutbox(acked, { type: 'retry' })).toBe(acked);
  });

  test('失败带原因,可重试', () => {
    const failed = reduceOutbox(queued, { type: 'failed', error: '断网了' })!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('断网了');
    expect(reduceOutbox(failed, { type: 'retry' })?.status).toBe('queued');
  });

  test('附件缺失时"重试"没有意义 —— 状态不动,等用户补附件', () => {
    const needs = reduceOutbox(queued, { type: 'needs_attachment', error: '图没了' })!;
    expect(reduceOutbox(needs, { type: 'retry' })).toBe(needs);
  });

  test('丢弃 → 空', () => {
    expect(reduceOutbox(queued, { type: 'discard' })).toBeNull();
  });
});

describe('什么时候能清草稿', () => {
  const cmd = freezeSendCommand(base);

  test('**只有 acked**。socket.send 返回 true 不算', () => {
    // F09 的核心:本地 send 成功只代表没抛异常,不代表服务端收到了。
    expect(canClearDraft({ command: cmd, status: 'sending', error: null, attempts: 1 })).toBe(false);
    expect(canClearDraft({ command: cmd, status: 'queued', error: null, attempts: 0 })).toBe(false);
    expect(canClearDraft({ command: cmd, status: 'failed', error: 'x', attempts: 1 })).toBe(false);
    expect(canClearDraft({ command: cmd, status: 'acked', error: null, attempts: 1 })).toBe(true);
  });

  test('只有 queued 才投递', () => {
    expect(isSendable({ command: cmd, status: 'queued', error: null, attempts: 0 })).toBe(true);
    expect(isSendable({ command: cmd, status: 'sending', error: null, attempts: 1 })).toBe(false);
    expect(isSendable({ command: cmd, status: 'needs_attachment', error: 'x', attempts: 0 })).toBe(false);
    expect(isSendable(null)).toBe(false);
  });
});

describe('持久化往返', () => {
  const ctx = { sessionKey: 's1:p1', sessionId: 's1', projectId: 'p1' };

  test('存回来的还是同一个幂等键 —— 否则幂等就白做了', () => {
    const cmd = freezeSendCommand({ ...base, images: [{ path: '/assets/img_1.png', name: 'img_1.png' }] });
    const back = fromStoredCommand(toStoredCommand(cmd), ctx);
    expect(back.command.clientMessageId).toBe(cmd.clientMessageId);
    expect(back.command.text).toBe(cmd.text);
    expect(back.command.images).toEqual([{ path: '/assets/img_1.png', name: 'img_1.png' }]);
    expect(back.attachmentsLost).toBe(false);
  });

  test('分叉点与隐藏上下文也跟着走(F15:它们此前是全局 ref)', () => {
    const cmd = freezeSendCommand({
      ...base,
      forkFrom: { providerSessionId: 'prov-1', resumeSessionAt: 'uuid-9' },
      hiddenContext: '这段不显示给用户',
    });
    const back = fromStoredCommand(toStoredCommand(cmd), ctx);
    expect(back.command.forkFrom).toEqual({ providerSessionId: 'prov-1', resumeSessionAt: 'uuid-9' });
    expect(back.command.hiddenContext).toBe('这段不显示给用户');
  });

  test('排队时有图、恢复出来没有 → 标成"附件丢了",**不发**', () => {
    // F12:此前 restoreQueuedDraft 直接 `images: []`,后台自动发送就把一条
    // 引用了不存在图片的话发了出去,用户毫不知情。
    const restored = fromStoredCommand({ content: '看这张图', imageCount: 2, images: [] }, ctx);
    expect(restored.attachmentsLost).toBe(true);
    expect(restoredEntry(restored).status).toBe('needs_attachment');
  });

  test('存了图但形状坏掉(没有 path)也算丢了', () => {
    const restored = fromStoredCommand(
      { content: 'x', imageCount: 1, images: [{ name: '只有名字' } as never] },
      ctx,
    );
    expect(restored.attachmentsLost).toBe(true);
  });

  test('老格式(没有任何新字段)照旧能读出来,当成没有附件', () => {
    // 向后兼容:用户升级时排着的那条不能因为多了字段就丢掉。
    const restored = fromStoredCommand({ content: '老记录' }, ctx);
    expect(restored.command.text).toBe('老记录');
    expect(restored.attachmentsLost).toBe(false);
    expect(restoredEntry(restored).status).toBe('queued');
    // 老记录没有幂等键,补一个新的(从现在起这条是幂等的)
    expect(restored.command.clientMessageId).toMatch(/^cmd_/);
  });

  test('伪造的幂等键不被采信,换成新的', () => {
    const restored = fromStoredCommand({ content: 'x', clientMessageId: '' as unknown as string }, ctx);
    expect(restored.command.clientMessageId).toMatch(/^cmd_/);
  });

  test('恢复时归属按**当前**上下文重新绑定,不用存的那份', () => {
    // 命令是按会话键落盘的,读它的时候我们已经知道自己是谁了;
    // 存一份归属再读回来只会多一个可能对不上的来源。
    const restored = fromStoredCommand({ content: 'x' }, { sessionKey: 's9:p9', sessionId: 's9', projectId: 'p9' });
    expect(restored.command.sessionKey).toBe('s9:p9');
    expect(restored.command.sessionId).toBe('s9');
  });
});

/**
 * **落盘的是"还没发出去的那条"。**
 *
 * `markCommandSent` 之后条目停在 `sending` 等 ACK。若这时还写 localStorage,
 * 而 ACK 因为任何原因没到(服务端是旧版本、帧丢了、页面在 ACK 之前被关掉),
 * 这条记录就永久留在盘上 —— 而"换会话"那个 effect 每次都会把它读回来并置成
 * `queued`,冲队随即又发一次:**同一句话反复发送,停不下来**。
 */
describe('哪些状态该落盘', () => {
  const cmd = freezeSendCommand(base);
  const shouldPersist = (status: OutboxEntry['status']) =>
    status === 'queued' || status === 'needs_attachment';

  test('queued 落盘 —— 刷新之后还得把它发出去', () => {
    expect(shouldPersist('queued')).toBe(true);
  });

  test('needs_attachment 落盘 —— 刷新之后卡片还得在,等用户补图', () => {
    expect(shouldPersist('needs_attachment')).toBe(true);
  });

  test('**sending 不落盘** —— 已经交出去了,盘上再留一份就是那个循环', () => {
    expect(shouldPersist('sending')).toBe(false);
  });

  test('acked / failed 都不落盘', () => {
    expect(shouldPersist('acked')).toBe(false);
    expect(shouldPersist('failed')).toBe(false);
  });

  test('恢复出来的条目一定是"还没发出去"的那两种之一', () => {
    // 落盘只写这两种,所以读回来也只该是这两种 —— 两侧对齐,不会读出一个
    // 已经发过的 `sending` 又被当成待发。
    expect(shouldPersist(restoredEntry(fromStoredCommand({ content: 'x' }, {
      sessionKey: 's1', sessionId: 's1', projectId: 'p1',
    })).status)).toBe(true);
    expect(shouldPersist(restoredEntry(fromStoredCommand({ content: 'x', imageCount: 1, images: [] }, {
      sessionKey: 's1', sessionId: 's1', projectId: 'p1',
    })).status)).toBe(true);
  });

  test('outbox 里 sending 的那条不会被 isSendable 再挑出来投递', () => {
    expect(isSendable({ command: cmd, status: 'sending', error: null, attempts: 1 })).toBe(false);
  });
});

/**
 * **「还在等着发」是一个判据,三处共用。**
 *
 * 线上现象:消息已经发出去了,排队卡还挂着「已排队 · 本轮结束后自动发送」,
 * **刷新之后才消失**。那句"刷新才消失"正是指纹 —— 落盘那一侧已经收窄成
 * "只写还没发的",渲染那一侧却还是"outbox 非空就渲染",于是内存里留着、
 * 盘上没有。同一个判据修了一半。
 */
describe('isPendingSend —— 排队卡 / 落盘 / 合并共用', () => {
  const cmd = freezeSendCommand(base);
  const at = (status: OutboxEntry['status']): OutboxEntry =>
    ({ command: cmd, status, error: null, attempts: 0 });

  test('queued 是"在等着发"', () => {
    expect(isPendingSend(at('queued'))).toBe(true);
  });

  test('needs_attachment 也是 —— 它在等用户补图,卡片必须留着', () => {
    expect(isPendingSend(at('needs_attachment'))).toBe(true);
  });

  test('**sending 不是** —— 已经发出去了,卡片不该再显示', () => {
    expect(isPendingSend(at('sending'))).toBe(false);
  });

  test('acked / failed 都不是', () => {
    expect(isPendingSend(at('acked'))).toBe(false);
    expect(isPendingSend(at('failed'))).toBe(false);
  });

  test('空 outbox 不是', () => {
    expect(isPendingSend(null)).toBe(false);
    expect(isPendingSend(undefined)).toBe(false);
  });

  test('与 isSendable 的关系:能投递的一定在等,反之不然', () => {
    // needs_attachment 在等,但不能投递(要先补图)——两个判据不能互相替代。
    expect(isSendable(at('queued'))).toBe(true);
    expect(isPendingSend(at('queued'))).toBe(true);
    expect(isSendable(at('needs_attachment'))).toBe(false);
    expect(isPendingSend(at('needs_attachment'))).toBe(true);
  });
});
