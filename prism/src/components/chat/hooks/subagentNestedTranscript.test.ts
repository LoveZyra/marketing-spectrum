import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

/**
 * ge:**子代理卡里那条嵌套时间轴。**
 *
 * SDK 的 `Options.forwardSubagentText` 原话:
 *
 * > By default, only tool_use/tool_result blocks from subagents are emitted
 * > (enough for a heartbeat counter). When true, the full subagent conversation
 * > is forwarded **so consumers can render a nested transcript**.
 *
 * Prism 此前把它钉成 `false`,理由是"子代理的 prompt 会以 user 帧发过来,
 * 聊天里凭空冒出用户消息"。那个理由现在不成立了 —— 两道判据各自都挡得住,
 * 而这一份测试就是那两道判据的反证:
 *
 *   1. 子代理的正文/思考**不出顶层**(尤其不许变成用户气泡);
 *   2. 它们要归进父卡的 `childTools`,按到达顺序和工具步骤串成一条时间轴。
 */
let seq = 0;
const msg = (overrides: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage => {
  seq += 1;
  return {
    id: `n_${seq}`,
    sessionId: 's1',
    timestamp: `2026-09-10T01:00:${String(seq).padStart(2, '0')}.000Z`,
    provider: 'claude',
    ...overrides,
  } as NormalizedMessage;
};

const PARENT = 'toolu_parent';
const container = () => msg({ kind: 'tool_use', toolName: 'Task', toolId: PARENT, toolInput: { description: '审计:滚动与折叠' } });

describe('forwardSubagentText 打开之后', () => {
  it('子代理的正文与思考**归进卡片**,不出顶层', () => {
    const rows = normalizedToChatMessages([
      container(),
      msg({ kind: 'thinking', parentToolUseId: PARENT, content: '先看看滚动控制器' }),
      msg({ kind: 'tool_use', parentToolUseId: PARENT, toolId: 'c1', toolName: 'Read', toolInput: { file_path: '/a.ts' } }),
      msg({ kind: 'tool_result', parentToolUseId: PARENT, toolId: 'c1', content: 'ok' }),
      msg({ kind: 'text', parentToolUseId: PARENT, role: 'assistant', content: '锚点这一段有问题' }),
    ]);

    // 顶层只有那张卡
    expect(rows).toHaveLength(1);
    const children = rows[0].subagentState?.childTools ?? [];
    expect(children.map((child) => child.kind)).toEqual(['thinking', 'tool', 'text']);
    expect(children[0].content).toBe('先看看滚动控制器');
    expect(children[2].content).toBe('锚点这一段有问题');
    expect(children[1].toolName).toBe('Read');
    expect(children[1].toolResult?.content).toBe('ok');
  });

  it('**绝不许变成用户气泡** —— 这正是当初关掉它的那个 bug', () => {
    const rows = normalizedToChatMessages([
      container(),
      // 子代理被派活时的那句 prompt,历史上就是它冒充过用户发言
      msg({ kind: 'text', parentToolUseId: PARENT, role: 'user', content: 'Reply with exactly the text AGENT_OK' }),
    ]);
    expect(rows.filter((row) => row.type === 'user')).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it('空白正文不占一步(CLI 偶尔发空块)', () => {
    const rows = normalizedToChatMessages([
      container(),
      msg({ kind: 'text', parentToolUseId: PARENT, content: '   ' }),
      msg({ kind: 'tool_use', parentToolUseId: PARENT, toolId: 'c9', toolName: 'Bash', toolInput: { command: 'ls' } }),
    ]);
    const children = rows[0].subagentState?.childTools ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].kind).toBe('tool');
  });

  it('步数 = 工具 + 正文 + 思考,按到达顺序串起来', () => {
    const rows = normalizedToChatMessages([
      container(),
      msg({ kind: 'thinking', parentToolUseId: PARENT, content: 'a' }),
      msg({ kind: 'text', parentToolUseId: PARENT, content: 'b' }),
      msg({ kind: 'tool_use', parentToolUseId: PARENT, toolId: 'c2', toolName: 'Grep', toolInput: {} }),
      msg({ kind: 'thinking', parentToolUseId: PARENT, content: 'c' }),
    ]);
    expect(rows[0].subagentState?.childTools).toHaveLength(4);
  });

  it('不带 parentToolUseId 的正文照旧是主线的行(判据没有放宽)', () => {
    const rows = normalizedToChatMessages([
      container(),
      msg({ kind: 'text', role: 'assistant', content: '主模型自己说的' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].content).toBe('主模型自己说的');
  });
});

/**
 * ge:**SDK 选项真的打开了没有。**
 *
 * 上面那几条证明"打开之后前端处理得对",但只要 `claude-sdk.js` 里还钉着
 * `forwardSubagentText = false`,子代理的正文与思考就一帧都不会来 ——
 * "判据写对了、数据到不了它"的又一种形状。读源码钉住。
 */
describe('SDK 选项的接线', () => {
  it('forwardSubagentText 打开(两条路径都要)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sdk = readFileSync(
      fileURLToPath(new URL('../../../../server/claude-sdk.js', import.meta.url)),
      'utf8',
    );
    expect(sdk.match(/sdkOptions\.forwardSubagentText = true;/g) ?? []).toHaveLength(2);
    expect(sdk).not.toMatch(/sdkOptions\.forwardSubagentText = false;/);
  });

  it('agentProgressSummaries 打开 —— 卡片上那行"它现在在干什么"靠它', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const sdk = readFileSync(
      fileURLToPath(new URL('../../../../server/claude-sdk.js', import.meta.url)),
      'utf8',
    );
    expect(sdk.match(/sdkOptions\.agentProgressSummaries = true;/g) ?? []).toHaveLength(2);
  });
});
