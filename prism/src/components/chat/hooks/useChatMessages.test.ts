import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

/**
 * These tests are about object identity, not content.
 *
 * `normalizedToChatMessages` runs over the whole transcript on every store
 * update — which during streaming means once per delta. If it mints fresh
 * ChatMessage objects each pass, every `memo`'d row re-renders on every frame
 * and `ChatMessagesPane`'s key map hands the same logical message a new key
 * after a pagination prepend, remounting the list and jumping the scroll
 * position. So `toBe` (reference equality) is the assertion that matters here;
 * `toEqual` would pass just as happily against the behaviour being prevented.
 *
 * The cache is module-level and shared across these tests, which is harmless
 * because each test builds its own message objects and the cache is keyed on
 * object identity.
 */

let nextId = 0;

function message(overrides: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage {
  nextId += 1;
  return {
    id: `m_${nextId}`,
    sessionId: 'session-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    ...overrides,
  };
}

function userText(content: string): NormalizedMessage {
  return message({ kind: 'text', role: 'user', content });
}

function assistantText(content: string): NormalizedMessage {
  return message({ kind: 'text', role: 'assistant', content });
}

describe('normalizedToChatMessages', () => {
  it('returns the same objects when the input messages are unchanged', () => {
    const messages = [userText('hello'), assistantText('hi there')];

    const first = normalizedToChatMessages(messages);
    const second = normalizedToChatMessages(messages);

    expect(first).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('keeps earlier messages stable when a new one is appended', () => {
    // The streaming case: each delta produces a new array containing the same
    // earlier message objects plus one more.
    const a = userText('hello');
    const b = assistantText('hi');

    const before = normalizedToChatMessages([a, b]);
    const after = normalizedToChatMessages([a, b, assistantText('...and more')]);

    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('keeps later messages stable when older history is prepended', () => {
    // The pagination case that used to remount the whole list.
    const a = userText('recent question');
    const b = assistantText('recent answer');

    const before = normalizedToChatMessages([a, b]);
    const after = normalizedToChatMessages([userText('older question'), a, b]);

    expect(after).toHaveLength(3);
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
  });

  it('produces a new object for a message the store replaced', () => {
    const stable = userText('hello');
    const streaming = message({ id: 'stream', kind: 'stream_delta', content: 'partial' });
    const before = normalizedToChatMessages([stable, streaming]);

    // `updateStreaming` writes a replacement object rather than mutating, which
    // is what makes identity a sound cache key.
    const grown = { ...streaming, content: 'partial text' };
    const after = normalizedToChatMessages([stable, grown]);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].content).toBe('partial text');
  });

  it('reconverts a tool_use when its tool_result arrives', () => {
    const toolUse = message({ kind: 'tool_use', toolName: 'Read', toolInput: { file: 'a.ts' }, toolId: 'tu_1' });

    const pending = normalizedToChatMessages([toolUse]);
    expect(pending).toHaveLength(1);
    expect(pending[0].toolResult).toBeNull();

    const resolved = normalizedToChatMessages([
      toolUse,
      message({ kind: 'tool_result', toolId: 'tu_1', content: 'export const a = 1;' }),
    ]);

    // Same input object, different output — the result is not reachable from the
    // tool_use, so the cache has to track it separately.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).not.toBe(pending[0]);
    // dv:结果帧的 timestamp 现在也带过来 —— 工具行的「耗时」列读的就是它,
    // 此前不传导致真实会话里耗时恒为空(单测因为手搓对象一直是绿的)。
    expect(resolved[0].toolResult).toEqual({
      content: 'export const a = 1;',
      isError: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      toolUseResult: undefined,
    });
  });

  it('keeps a resolved tool_use stable across later passes', () => {
    const toolUse = message({ kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, toolId: 'tu_2' });
    const toolResult = message({ kind: 'tool_result', toolId: 'tu_2', content: 'a.ts\nb.ts' });

    const first = normalizedToChatMessages([toolUse, toolResult]);
    const second = normalizedToChatMessages([toolUse, toolResult, assistantText('done')]);

    expect(second[0]).toBe(first[0]);
  });

  it('keeps both rows of a task notification stable', () => {
    // One input message, two output rows — so the cache entry has to hold an
    // array, and both entries have to survive a later pass.
    const notification = userText(
      [
        '<task-notification>',
        '<status>completed</status>',
        '<summary>Background task finished</summary>',
        '<result>## Findings\n\nAll green.</result>',
        '</task-notification>',
      ].join('\n'),
    );

    const first = normalizedToChatMessages([notification]);
    expect(first).toHaveLength(2);
    expect(first[0].isTaskNotification).toBe(true);
    expect(first[1].content).toContain('## Findings');

    const second = normalizedToChatMessages([notification, assistantText('anything else?')]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('does not render a tool_result whose tool_use has not been paged in yet', () => {
    const orphan = message({ kind: 'tool_result', toolId: 'tu_missing', content: 'raw dump' });

    expect(normalizedToChatMessages([orphan])).toHaveLength(0);
  });

  // ── C1:身份透传(id / seq / rowid)──
  // 修前 convertMessage 不带 id,导致「编辑重跑」按钮(gated 在 message.id)整体
  // 失效,且流式气泡 key 退化到 timestamp+正文、每 100ms 漂移触发重挂载。
  describe('身份透传', () => {
    it('单条消息把 NormalizedMessage.id 盖到 ChatMessage 上', () => {
      const u = message({ id: 'uuid-abc', kind: 'text', role: 'user', content: '问题' });
      const [chat] = normalizedToChatMessages([u]);
      expect(chat.id).toBe('uuid-abc');
    });

    it('流式消息保留稳定的 __streaming_ id(不随正文变化)', () => {
      const s1 = message({ id: '__streaming_sess1', kind: 'stream_delta', content: 'abc' });
      const [c1] = normalizedToChatMessages([s1]);
      const s2 = { ...s1, content: 'abcdef' };
      const [c2] = normalizedToChatMessages([s2]);
      expect(c1.id).toBe('__streaming_sess1');
      expect(c2.id).toBe('__streaming_sess1');
    });

    it('一条 msg 拆成多条时,id 加 #index 后缀防撞', () => {
      // task-notification = 状态行 + 结果正文,两条都从同一个 msg.id 来。
      const notification = message({
        id: 'uuid-multi',
        kind: 'text',
        role: 'user',
        content: [
          '<task-notification>',
          '<summary>done</summary>',
          '<result>',
          '## R',
          '</result>',
          '</task-notification>',
        ].join('\n'),
      });
      const out = normalizedToChatMessages([notification]);
      expect(out).toHaveLength(2);
      expect(out[0].id).toBe('uuid-multi#0');
      expect(out[1].id).toBe('uuid-multi#1');
      expect(out[0].id).not.toBe(out[1].id);
    });

    it('携带 seq / rowid 作为 key 兜底', () => {
      const u = message({ id: 'uuid-x', kind: 'text', role: 'assistant', content: 'hi', seq: 42, rowid: 7 });
      const [chat] = normalizedToChatMessages([u]);
      expect(chat.seq).toBe(42);
      expect(chat.rowid).toBe(7);
    });
  });
});

/**
 * ci 回归:子代理实时子步骤归拢 —— 带 parentToolUseId 的行不出顶层,
 * 塞进父容器(Task/Agent)的 subagentState.childTools。
 */
describe('子代理子步骤归拢', () => {
  const base = { sessionId: 's1', timestamp: '2026-08-26T03:00:00Z', provider: 'claude' as const };

  it('子行折进父卡,顶层只剩父容器', () => {
    const messages = [
      { ...base, id: 'p1', kind: 'tool_use' as const, toolName: 'Agent', toolId: 'toolu_parent', toolInput: '{"description":"读文件"}' },
      { ...base, id: 'c1', kind: 'tool_use' as const, toolName: 'Read', toolId: 'toolu_child', toolInput: '{"file_path":"/a.txt"}', parentToolUseId: 'toolu_parent' },
      { ...base, id: 'c1r', kind: 'tool_result' as const, toolId: 'toolu_child', content: 'hello', parentToolUseId: 'toolu_parent' },
    ];
    const out = normalizedToChatMessages(messages as never);
    expect(out).toHaveLength(1);
    const parent = out[0];
    expect(parent.isSubagentContainer).toBe(true);
    expect(parent.subagentState?.childTools).toHaveLength(1);
    expect(parent.subagentState?.childTools[0].toolName).toBe('Read');
    expect(parent.subagentState?.childTools[0].toolResult?.content).toBe('hello');
  });

  it('子行结果未到:child 无 result(运行中);到了后指纹变化触发重转', () => {
    const parentRow = { ...base, id: 'p2', kind: 'tool_use' as const, toolName: 'Task', toolId: 'toolu_p2', toolInput: '{}' };
    const childRow = { ...base, id: 'c2', kind: 'tool_use' as const, toolName: 'Bash', toolId: 'toolu_c2', toolInput: '{"command":"ls"}', parentToolUseId: 'toolu_p2' };
    const first = normalizedToChatMessages([parentRow, childRow] as never);
    expect(first[0].subagentState?.childTools[0].toolResult).toBeNull();

    const resultRow = { ...base, id: 'c2r', kind: 'tool_result' as const, toolId: 'toolu_c2', content: 'ok', parentToolUseId: 'toolu_p2' };
    const second = normalizedToChatMessages([parentRow, childRow, resultRow] as never);
    expect(second[0].subagentState?.childTools[0].toolResult?.content).toBe('ok');
  });

  it('子代理的文本/思考帧不渲染,不串进主对话', () => {
    const messages = [
      { ...base, id: 'p3', kind: 'tool_use' as const, toolName: 'Agent', toolId: 'toolu_p3', toolInput: '{}' },
      { ...base, id: 't1', kind: 'text' as const, role: 'assistant' as const, content: '子代理内部回复', parentToolUseId: 'toolu_p3' },
      { ...base, id: 'th1', kind: 'thinking' as const, content: '子代理思考', parentToolUseId: 'toolu_p3' },
    ];
    const out = normalizedToChatMessages(messages as never);
    expect(out).toHaveLength(1);
    expect(out[0].isSubagentContainer).toBe(true);
  });

  it('Agent 工具名也认作子代理容器(新版 SDK)', () => {
    const out = normalizedToChatMessages([
      { ...base, id: 'p4', kind: 'tool_use' as const, toolName: 'Agent', toolId: 'toolu_p4', toolInput: '{}' },
    ] as never);
    expect(out[0].isSubagentContainer).toBe(true);
  });
});
