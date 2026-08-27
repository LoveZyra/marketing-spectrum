import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  renderHtmlExport,
  renderJsonExport,
  renderMarkdownExport,
  renderSessionExport,
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

/**
 * F12:JSON 格式 + 「含工具过程」开关。
 *
 * 两条都是"默认不变、按需打开":默认导出仍然只有正文(多数导出是给人读的),
 * 打开开关才带上过程。这里第一条钉的就是默认没变 —— 否则这不是加了个选项,
 * 而是悄悄改了所有人已有的导出。
 */
const TOOL_MESSAGES = [
  { kind: 'text', role: 'user' as const, content: '删掉临时文件', timestamp: '2026-08-27T10:00:00Z' },
  { kind: 'tool_use', toolName: 'Bash', toolUseId: 'tu_1', toolInput: { command: 'rm -rf /tmp/x' }, timestamp: '2026-08-27T10:00:01Z' },
  { kind: 'tool_result', toolName: 'Bash', toolUseId: 'tu_1', content: 'done', timestamp: '2026-08-27T10:00:02Z' },
  { kind: 'text', role: 'assistant' as const, content: '已删除', timestamp: '2026-08-27T10:00:03Z', model: 'm1' },
];

const TOOL_INPUT = {
  title: '带工具的会话',
  sessionId: 'tool-1',
  exportedAt: '2026-08-27T12:00:00Z',
  messages: TOOL_MESSAGES,
};

describe('F12 · includeTools', () => {
  test('默认不带工具 —— 已有导出的行为一个字都没变', () => {
    assert.equal(selectExportMessages(TOOL_MESSAGES).length, 2);
    const md = renderMarkdownExport(TOOL_INPUT);
    assert.ok(!md.includes('rm -rf'), '默认导出里不该出现工具输入');
  });

  test('打开后工具按**原始顺序**混在正文里 —— 工具的意义全在它发生在哪两句之间', () => {
    const selected = selectExportMessages(TOOL_MESSAGES, { includeTools: true });
    assert.deepEqual(selected.map((m) => m.kind), ['text', 'tool_use', 'tool_result', 'text']);

    const md = renderMarkdownExport(TOOL_INPUT, { includeTools: true });
    assert.ok(md.includes('rm -rf /tmp/x'));
    assert.ok(md.indexOf('删掉临时文件') < md.indexOf('rm -rf'), '工具要排在提问之后');
    assert.ok(md.indexOf('rm -rf') < md.indexOf('已删除'), '工具要排在回答之前');
  });

  test('HTML 同样只在打开时带工具,且做了转义', () => {
    const plain = renderHtmlExport(TOOL_INPUT);
    assert.ok(!plain.includes('rm -rf'));

    const withTools = renderHtmlExport(TOOL_INPUT, { includeTools: true });
    assert.ok(withTools.includes('class="tool"'));
    assert.ok(withTools.includes('rm -rf'));
  });

  test('JSON 是稳定的自解释形状,不是内部结构的原样倒出', () => {
    const payload = JSON.parse(renderJsonExport(TOOL_INPUT, { includeTools: true })) as {
      prismExportVersion: number;
      includesTools: boolean;
      messages: Array<Record<string, unknown>>;
    };

    assert.equal(payload.prismExportVersion, 1);
    assert.equal(payload.includesTools, true);
    assert.deepEqual(payload.messages.map((m) => m.type), ['message', 'tool_call', 'tool_result', 'message']);
    assert.deepEqual(payload.messages[1].input, { command: 'rm -rf /tmp/x' });
    assert.equal(payload.messages[2].output, 'done');
    assert.equal(payload.messages[3].model, 'm1');
  });

  test('JSON 默认同样不含工具,并如实标注 includesTools:false', () => {
    const payload = JSON.parse(renderJsonExport(TOOL_INPUT)) as {
      includesTools: boolean;
      messages: Array<Record<string, unknown>>;
    };
    assert.equal(payload.includesTools, false);
    assert.deepEqual(payload.messages.map((m) => m.type), ['message', 'message']);
  });

  test('renderSessionExport 三种格式各自的 mime 与扩展名', () => {
    assert.equal(renderSessionExport(TOOL_INPUT, 'md').extension, 'md');
    assert.equal(renderSessionExport(TOOL_INPUT, 'html').mime, 'text/html; charset=utf-8');
    const json = renderSessionExport(TOOL_INPUT, 'json');
    assert.equal(json.extension, 'json');
    assert.equal(json.mime, 'application/json; charset=utf-8');
  });

  test('超长工具输出被截断 —— 导出不是日志转储', () => {
    const huge = [{ kind: 'tool_result', toolName: 'Read', content: 'x'.repeat(20_000), timestamp: '2026-08-27T10:00:00Z' }];
    const md = renderMarkdownExport({ ...TOOL_INPUT, messages: huge }, { includeTools: true });
    assert.ok(md.includes('… (truncated)'));
    assert.ok(md.length < 12_000);
  });
});
