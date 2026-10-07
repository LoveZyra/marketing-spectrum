import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, test } from 'vitest';

import { ResponseCollector } from '../agent.js';

/**
 * 非流式 `/api/agent` 的截断标记。
 *
 * ResponseCollector 的缓冲有上限,放不下的帧直接丢(缓冲满了之后,助手正文与用量帧也一样),
 * 所以响应里的 `messages` / `tokens` 可能不全。调用方必须拿得到这件事,否则会把半截结果当成完整结果。
 */
const originalCap = ResponseCollector.MAX_BUFFERED_BYTES;
afterEach(() => {
  ResponseCollector.MAX_BUFFERED_BYTES = originalCap;
});

const text = (content) => ({ kind: 'text', role: 'assistant', content, provider: 'claude' });

describe('ResponseCollector 的截断', () => {
  test('没超上限:wasTruncated 为 false', () => {
    const collector = new ResponseCollector(1);
    collector.send(text('一句'));
    assert.equal(collector.wasTruncated(), false);
  });

  test('放不下的帧丢掉,wasTruncated 为 true;缓冲满了之后连助手正文也收不下', () => {
    ResponseCollector.MAX_BUFFERED_BYTES = 400;
    const collector = new ResponseCollector(1);
    collector.send(text('开头'));
    collector.send({ kind: 'tool_result', provider: 'claude', toolResult: { content: 'x'.repeat(1000) } });
    assert.equal(collector.wasTruncated(), true);
    // 填满缓冲,之后的回答放不下
    collector.send({ kind: 'tool_use', provider: 'claude', toolInput: 'y'.repeat(200) });
    collector.send(text('结尾'.repeat(20)));
    assert.deepEqual(collector.getAssistantMessages().map((message) => message.content), ['开头']);
  });
});

describe('非流式响应带截断标记', () => {
  const source = readFileSync(fileURLToPath(new URL('../agent.js', import.meta.url)), 'utf8');

  test('响应体里有 truncated,取自收集器', () => {
    const start = source.indexOf('const response = {', source.indexOf('// Non-streaming mode: send filtered messages'));
    assert.ok(start > 0);
    const body = source.slice(start, source.indexOf('};', start));
    assert.match(body, /\n\s*tokens: tokenSummary,\n(\s*\/\/[^\n]*\n)?\s*truncated: writer\.wasTruncated\(\),\n/);
  });
});
