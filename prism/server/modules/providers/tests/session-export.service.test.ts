import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  renderHtmlExport,
  renderMarkdownExport,
  selectExportMessages,
} from '../services/session-export.service.js';

const MESSAGES = [
  { kind: 'text', role: 'user' as const, content: '帮我看下这个报错', timestamp: '2026-08-18T10:00:00Z' },
  { kind: 'thinking', role: 'assistant' as const, content: '内心戏', timestamp: '2026-08-18T10:00:01Z' },
  { kind: 'tool_use', content: 'Bash(...)', timestamp: '2026-08-18T10:00:02Z' },
  { kind: 'text', role: 'assistant' as const, content: '是 <null> 解引用', timestamp: '2026-08-18T10:00:03Z', model: 'kimi-k3' },
  { kind: 'text', role: 'assistant' as const, content: '   ', timestamp: '2026-08-18T10:00:04Z' },
];

const INPUT = {
  title: '排查会话',
  sessionId: 'abcd1234-x',
  exportedAt: '2026-08-18T12:00:00Z',
  messages: MESSAGES,
};

describe('selectExportMessages', () => {
  test('只留 user/assistant 的非空 text;thinking/tool/空白剔除', () => {
    const selected = selectExportMessages(MESSAGES);
    assert.equal(selected.length, 2);
    assert.equal(selected[0].role, 'user');
    assert.equal(selected[1].model, 'kimi-k3');
  });
});

describe('renderMarkdownExport', () => {
  test('含标题、双方标头与模型标', () => {
    const md = renderMarkdownExport(INPUT);
    assert.ok(md.startsWith('# 排查会话'));
    assert.ok(md.includes('## 用户'));
    assert.ok(md.includes('kimi-k3'));
    assert.ok(md.includes('帮我看下这个报错'));
    assert.ok(!md.includes('内心戏'), 'thinking 不进导出');
  });
});

describe('renderHtmlExport', () => {
  test('独立 html,正文转义(消息里的标签不当 html 执行)', () => {
    const html = renderHtmlExport(INPUT);
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('&lt;null&gt;'), '尖括号必须转义');
    assert.ok(!html.includes('是 <null> 解引用'), '原始未转义文本不得出现');
    assert.ok(html.includes('class="msg user"'));
  });
});
