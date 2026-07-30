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
    expect(resolved[0].toolResult).toEqual({
      content: 'export const a = 1;',
      isError: false,
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
});
