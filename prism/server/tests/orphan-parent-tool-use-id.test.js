import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { routeOrphanMessage, setOrphanTurnHook } from '../claude-sdk.js';

/**
 * 子代理的帧不许掉进主代理的会话流。
 *
 * `sessionsService.normalizeMessage`(claude-sessions.provider.ts)不设 `parentToolUseId`:它只看 SDK 帧
 * 内容块里的东西,而父 id 挂在 SDK 的外层信封(`parent_tool_use_id`)上。所以每一条流式链路
 * (一次性路径、常驻回合路径、无主帧路径)都必须在归一化之后自己拷一次。
 *
 * 前端 `normalizedToChatMessages` 靠这个字段把 tool_use / tool_result / text / thinking 挡在顶层之外。
 * 字段一丢,子代理内部的每一步都会当成主代理的活动行平铺到主轴上,而对应的子代理卡片停在「2 步」不动。
 *
 * 这份测试走真链路:最容易漏的就是"判据写对、单测全绿,而真实链路喂给它的根本不是那个值"。所以这里
 * 不手搓归一化结果,而是把一条真 SDK 形状的帧灌进 `routeOrphanMessage`,让它自己跑一遍
 * `transformMessage` 和真的 `normalizeMessage`,再看钩子收到的东西上有没有父 id。
 */
describe('无主帧必须保住 parentToolUseId', () => {
  afterEach(() => setOrphanTurnHook(null));

  const runtime = {
    key: 'rt-1',
    appSessionId: 'app-1',
    sessionId: 'sess-1',
    ownerUserId: 7,
    pendingToolUses: new Map(),
  };

  /** 子代理内部的一次工具调用 —— SDK 在信封上挂 parent_tool_use_id。 */
  const subagentFrame = {
    type: 'assistant',
    parent_tool_use_id: 'toolu_parent_abc',
    message: {
      id: 'msg_child',
      role: 'assistant',
      model: 'claude-opus-4',
      content: [
        { type: 'tool_use', id: 'toolu_child_1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      ],
    },
  };

  const capture = () => {
    const seen = [];
    setOrphanTurnHook((payload) => { seen.push(payload); return true; });
    return seen;
  };

  it('归一化之后父 id 还在 —— 走的是真的 normalizeMessage,不是手搓的结果', () => {
    const seen = capture();
    routeOrphanMessage(runtime, subagentFrame);

    expect(seen).toHaveLength(1);
    const messages = seen[0].messages;
    expect(messages.length).toBeGreaterThan(0);
    // 这一帧里每一条归一化结果都得带上父 id,否则它就会平铺到主轴上
    for (const msg of messages) {
      expect(msg.parentToolUseId).toBe('toolu_parent_abc');
    }
  });

  it('主代理自己的帧不会被凭空安上父 id', () => {
    const seen = capture();
    routeOrphanMessage(runtime, {
      type: 'assistant',
      message: {
        id: 'msg_main',
        role: 'assistant',
        content: [{ type: 'text', text: '主代理说的话' }],
      },
    });

    expect(seen).toHaveLength(1);
    for (const msg of seen[0].messages) {
      expect(msg.parentToolUseId).toBeUndefined();
    }
  });

  it('三条流式链路都拷了这个字段 —— 漏任何一条都是同一个 bug 的另一种形状', () => {
    const sdk = readFileSync(fileURLToPath(new URL('../claude-sdk.js', import.meta.url)), 'utf8');
    // 归一化之后紧跟着一次 `!msg.parentToolUseId` 的补写,三处一处不能少
    const copies = sdk.match(/if \((?:transformedMessage|transformed)\.parentToolUseId && !msg\.parentToolUseId\) \{/g) || [];
    expect(copies).toHaveLength(3);
  });
});
