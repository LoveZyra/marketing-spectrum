import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { routeOrphanMessage, setOrphanTurnHook } from '../claude-sdk.js';

/**
 * gf:**子代理的帧不许掉进主代理的会话流。**
 *
 * ## 线上现象(用户原话)
 *
 * >「我感觉你在胡说,我看你说的是主 agent 的会话流程,其实是子 agent 的。
 * >  你是不是把二者混在一起了。」
 *
 * 他是对的,而且是 gb 那一包写出来的。
 *
 * ## 病根
 *
 * `sessionsService.normalizeMessage`(claude-sessions.provider.ts)**从来不设**
 * `parentToolUseId` —— 它只认 SDK 帧内容块里的东西,父 id 挂在 SDK 的**外层信封**
 * (`parent_tool_use_id`)上。所以每一条流式链路都必须在归一化**之后**自己拷一次:
 *
 *   - 一次性路径      claude-sdk.js:1447
 *   - 常驻回合路径    claude-sdk.js:2865
 *   - **无主帧路径    claude-sdk.js:2323 ← gb 漏了这一处**
 *
 * 丢了这个字段的后果是确定的:前端 `normalizedToChatMessages` 第一句就是
 * 「带 `parentToolUseId` 的 tool_use/tool_result/text/thinking 不出顶层」。
 * 字段没了 → 判据不成立 → 子代理内部的每一步都当成主代理的活动行平铺到主轴上,
 * 而它对应的那张子代理卡还停在「2 步」。**"主 agent 会话流里混进子 agent"就是这么来的。**
 *
 * ## 这份测试为什么要走真链路
 *
 * 这一轮已经在同一个形状上栽过好几次:判据写对、单测全绿,而真实链路喂给它的
 * 根本不是那个值。所以这里**不手搓归一化结果**,而是把一条真 SDK 形状的帧
 * 灌进 `routeOrphanMessage`,让它自己跑一遍 `transformMessage` + 真的
 * `normalizeMessage`,再看钩子收到的东西上有没有父 id。
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
