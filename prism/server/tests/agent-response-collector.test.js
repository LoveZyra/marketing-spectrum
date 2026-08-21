import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { ResponseCollector } from '../routes/agent.js';

/**
 * 非流式 `/api/agent` 的响应体里,`messages` 和 `tokens` 长期是空的。
 *
 * 原因不是"没内容",是**认错了格式**:收集器只认 `type: 'claude-response'` 的
 * 字符串帧(老 CLI 线格式),而走 SDK 之后推过来的一律是规范化对象
 * (`{ kind: 'text' | 'status' | … }`)。两个条件一个都不成立,于是循环里
 * 一条都不匹配,响应恒为 `messages: []` + 全 0 用量 —— 静默,没有任何报错。
 *
 * 这几条用例把两种格式都钉住,免得再退回去。
 */

const text = (content, over = {}) => ({
  kind: 'text', role: 'assistant', content,
  id: 'm1', model: 'claude-sonnet-5', timestamp: '2026-08-20T11:00:00.000Z',
  provider: 'claude', ...over,
});

const budget = (over) => ({
  kind: 'status', text: 'token_budget', provider: 'claude',
  tokenBudget: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...over },
});

describe('ResponseCollector —— 挑出回答', () => {
  test('规范化的 text 帧就是回答', () => {
    const c = new ResponseCollector(1);
    c.send({ type: 'status', message: 'Session started' });
    c.send(text('收到'));
    assert.deepEqual(c.getAssistantMessages().map((m) => m.content), ['收到']);
  });

  test('工具调用与瞬时状态不算回答', () => {
    const c = new ResponseCollector(1);
    c.send({ kind: 'tool_use', toolName: 'Read', provider: 'claude' });
    c.send({ kind: 'tool_result', provider: 'claude' });
    c.send(budget({ outputTokens: 3 }));
    c.send({ kind: 'complete', provider: 'claude' });
    assert.deepEqual(c.getAssistantMessages(), []);
  });

  test('空内容的 text 帧不占一条', () => {
    const c = new ResponseCollector(1);
    c.send(text(''));
    assert.deepEqual(c.getAssistantMessages(), []);
  });

  test('老 CLI 线格式仍然认', () => {
    const c = new ResponseCollector(1);
    c.send(JSON.stringify({ type: 'claude-response', data: { type: 'assistant', legacy: true } }));
    assert.deepEqual(c.getAssistantMessages(), [{ type: 'assistant', legacy: true }]);
  });

  test('坏 JSON 不会把整段收集带崩', () => {
    const c = new ResponseCollector(1);
    c.send('{ 这不是 JSON');
    c.send(text('还在'));
    assert.deepEqual(c.getAssistantMessages().map((m) => m.content), ['还在']);
  });
});

describe('ResponseCollector —— 累加用量', () => {
  test('逐条累加 token_budget,缓存不被算两遍', () => {
    const c = new ResponseCollector(1);
    // inputTokens 里已经含了两种缓存(见 extractTokenBudget)。
    c.send(budget({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900, cacheCreationTokens: 50 }));
    c.send(budget({ inputTokens: 200, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 }));

    const tokens = c.getTotalTokens();
    // 直入 = (1000-950) + (200-100) = 150;缓存读 = 1000;缓存写 = 50
    assert.equal(tokens.cacheReadTokens, 1000);
    assert.equal(tokens.cacheCreationTokens, 50);
    assert.equal(tokens.inputTokens, 150 + 1000 + 50);
    assert.equal(tokens.outputTokens, 15);
    assert.equal(tokens.totalTokens, 150 + 1000 + 50 + 15);
  });

  test('什么都没有时是一组 0,而不是 NaN', () => {
    assert.deepEqual(new ResponseCollector(1).getTotalTokens(), {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0,
    });
  });
});
