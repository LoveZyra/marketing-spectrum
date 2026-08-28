import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { activityIconKey, compactCommand, summarizeActivityRun, summarizeToolRow, toolDuration, toolMetric, toolRowLabel, toolTarget } from './toolRowSummary';

const at = (iso: string) => new Date(iso);

function toolMessage(partial: Partial<ChatMessage>): ChatMessage {
  return {
    type: 'assistant',
    timestamp: at('2026-08-19T10:00:00.000Z'),
    isToolUse: true,
    ...partial,
  } as ChatMessage;
}

describe('toolTarget', () => {
  it('prefers file_path, then command, then pattern', () => {
    expect(toolTarget('Read', { file_path: 'server/a.js' })).toBe('server/a.js');
    expect(toolTarget('Bash', { command: 'npm test -- audience' })).toBe('npm test -- audience');
    expect(toolTarget('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO');
  });

  it('accepts a JSON string input and falls back to the raw string', () => {
    expect(toolTarget('Read', '{"file_path":"a/b.ts"}')).toBe('a/b.ts');
    expect(toolTarget('Unknown', 'just text')).toBe('just text');
  });
});

describe('toolMetric', () => {
  it('counts +added −removed for write tools', () => {
    const metric = toolMetric('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc\nd' }, null);
    expect(metric).toEqual({ text: '+4 −2', isWrite: true });
  });

  it('marks write tools even when no diff can be derived', () => {
    expect(toolMetric('Write', {}, null)).toEqual({ text: '', isWrite: true });
  });

  it('reads line counts for Read and hit counts for search tools', () => {
    expect(toolMetric('Read', { file_path: 'a' }, { content: 'x\ny\nz' })).toEqual({ text: '3 行', isWrite: false });
    expect(toolMetric('Grep', { pattern: 'x' }, { toolUseResult: { numFiles: 6 } })).toEqual({ text: '6 处', isWrite: false });
  });

  it('returns nothing when the result carries no measurable output', () => {
    expect(toolMetric('Bash', { command: 'ls' }, { content: '' })).toEqual({ text: '', isWrite: false });
  });
});

describe('toolDuration', () => {
  it('formats sub-minute durations with one decimal', () => {
    expect(toolDuration(at('2026-08-19T10:00:00.000Z'), { timestamp: at('2026-08-19T10:00:00.400Z') })).toBe('0.4s');
    expect(toolDuration(at('2026-08-19T10:00:00.000Z'), { timestamp: at('2026-08-19T10:00:05.900Z') })).toBe('5.9s');
  });

  it('formats minutes and seconds past a minute', () => {
    expect(toolDuration(at('2026-08-19T10:00:00.000Z'), { timestamp: at('2026-08-19T10:02:14.000Z') })).toBe('2m 14s');
  });

  it('returns an empty string when the tool has not finished', () => {
    expect(toolDuration(at('2026-08-19T10:00:00.000Z'), null)).toBe('');
    expect(toolDuration(at('2026-08-19T10:00:00.000Z'), { content: 'x' })).toBe('');
  });
});

describe('summarizeToolRow', () => {
  it('is running until a result arrives, then done', () => {
    expect(summarizeToolRow(toolMessage({ toolName: 'Bash', toolInput: { command: 'npm test' } })).status).toBe('running');
    expect(
      summarizeToolRow(toolMessage({ toolName: 'Bash', toolInput: { command: 'npm test' }, toolResult: { content: 'ok' } })).status,
    ).toBe('done');
  });

  it('reports an error result as error', () => {
    const row = summarizeToolRow(toolMessage({ toolName: 'Read', toolInput: { file_path: 'a' }, toolResult: { isError: true } }));
    expect(row.status).toBe('error');
  });

  it('fills the five columns from a finished edit', () => {
    const row = summarizeToolRow(toolMessage({
      toolName: 'Edit',
      toolInput: { file_path: 'audience/branch-rules.ts', old_string: 'a\nb\nc\nd', new_string: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr' },
      toolResult: { timestamp: at('2026-08-19T10:00:00.900Z') },
    }));
    expect(row).toMatchObject({
      status: 'done',
      name: 'Edit',
      target: 'audience/branch-rules.ts',
      metric: '+18 −4',
      metricIsWrite: true,
      duration: '0.9s',
    });
  });
});

describe('toolRowLabel', () => {
  it('prefers the tool own human-readable description', () => {
    expect(toolRowLabel('Bash', { command: 'rg -n TODO src', description: 'Find TODOs in src' }))
      .toMatchObject({ description: 'Find TODOs in src' });
  });

  it('shortens a path target to its file name and a URL to its host', () => {
    expect(toolRowLabel('Read', { file_path: 'server/services/scene-audience.js' }))
      .toMatchObject({ verb: 'read', target: 'scene-audience.js' });
    expect(toolRowLabel('WebFetch', { url: 'https://docs.example.com/a/b?q=1' }))
      .toMatchObject({ verb: 'fetch', target: 'docs.example.com' });
  });

  it('keeps a command with spaces intact instead of slicing it as a path', () => {
    expect(toolRowLabel('Bash', { command: 'npm test -- audience/branch-rules' }))
      .toMatchObject({ verb: 'bash', target: 'npm test -- audience/branch-rules' });
  });

  it('falls back to the bare tool name for unknown tools and strips the mcp prefix', () => {
    expect(toolRowLabel('SomethingElse', { path: 'a/b' }))
      .toMatchObject({ verb: 'generic', toolLabel: 'SomethingElse' });
    expect(toolRowLabel('mcp__jira__create_issue', {}))
      .toMatchObject({ verb: 'generic', toolLabel: 'create_issue' });
  });

  it('drops the target for TodoWrite — the label is the whole story', () => {
    expect(toolRowLabel('TodoWrite', { todos: [] })).toMatchObject({ verb: 'todo', target: '' });
  });
});

describe('activityIconKey', () => {
  it('maps tools to icon families and mcp tools to the plug', () => {
    expect(activityIconKey('Read')).toBe('read');
    expect(activityIconKey('MultiEdit')).toBe('edit');
    expect(activityIconKey('Bash')).toBe('bash');
    expect(activityIconKey('mcp__jira__create_issue')).toBe('mcp');
    expect(activityIconKey('WhoKnows')).toBe('tool');
  });
});

describe('compactCommand', () => {
  it('drops the leading cd and stops at the first pipe', () => {
    expect(compactCommand('cd /tmp/prism && npx eslint src --ext .ts,.tsx 2>&1 | tail -3'))
      .toBe('npx eslint src --ext .ts,.tsx …');
  });

  it('keeps a single simple command whole', () => {
    expect(compactCommand('npm run build:client')).toBe('npm run build:client');
  });

  it('flattens a multi-line heredoc down to its first line', () => {
    expect(compactCommand("cd /a/b && python3 - <<'PY'\nimport json\nPY")).toBe('python3 - …');
  });
});

describe('summarizeActivityRun', () => {
  it('counts by icon family in a fixed order and drops empty families', () => {
    expect(summarizeActivityRun([
      { toolName: 'Bash' }, { toolName: 'Bash' },
      { toolName: 'Write' },
      { isThinking: true },
      { toolName: 'Read' },
    ])).toEqual([
      { key: 'bash', count: 2 },
      { key: 'write', count: 1 },
      { key: 'read', count: 1 },
      { key: 'thinking', count: 1 },
    ]);
  });

  it('folds every unknown tool into the generic bucket', () => {
    expect(summarizeActivityRun([{ toolName: 'WhoKnows' }, { toolName: 'mcp__x__y' }]))
      .toEqual([{ key: 'mcp', count: 1 }, { key: 'tool', count: 1 }]);
  });
});

/**
 * db:会话闲下来之后,没有结果的工具行不能再显示「运行中」。
 *
 * 回合被中止/超时收掉时,那条 tool_result 永远不会到 —— 卡片会一直转下去。
 * 线上就是这个画面:界面显示"正在压缩",旁边一张 Bash 卡片转个不停。
 * 会话都已经不在跑了还说"运行中",是在骗人。
 */
describe('会话闲下来后的工具行', () => {
  const running = () => toolMessage({ toolName: 'Bash', toolInput: { command: 'sleep 999' } });

  it('会话还在跑 = 运行中(老行为不变)', () => {
    expect(summarizeToolRow(running(), true).status).toBe('running');
  });

  it('会话已经不在跑但仍没有结果 = 已中断,而不是永远转下去', () => {
    expect(summarizeToolRow(running(), false).status).toBe('interrupted');
  });

  it('不传第二个参数时保持老行为', () => {
    expect(summarizeToolRow(running()).status).toBe('running');
  });

  it('已经有结果的行不受影响 —— 迟到的结果照样能把卡片收掉', () => {
    const done = toolMessage({
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      toolResult: { content: 'hi' },
    });
    expect(summarizeToolRow(done, false).status).toBe('done');
  });
});
