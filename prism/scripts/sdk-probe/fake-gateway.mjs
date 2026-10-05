/**
 * hm(A7):升级探针用的假网关 —— Anthropic Messages 兼容,只在容器里跑,不进构建产物。
 *
 * - `/v1/messages`(流式与非流式)、`/v1/messages/count_tokens`、`/v1/models`;
 * - 每个请求都记下来(`requests`),探针据此断言"发了什么";
 * - `script(body)` 可按请求内容决定回什么(文字 / 工具调用 / 400),默认回一句 `ok`;
 * - `limits[model]` 模拟网关按模型的最大输入:估算输入超了就回 400(与生产网关同一句话)。
 */
import http from 'node:http';

const estimateTokens = (body) => Math.ceil(JSON.stringify(body?.messages ?? []).length / 4)
  + Math.ceil(JSON.stringify(body?.system ?? '').length / 4)
  + Math.ceil(JSON.stringify(body?.tools ?? []).length / 4);

export function startFakeGateway({ models = [], limits = {}, script = null, usageFor = null } = {}) {
  const requests = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: url.pathname, body, headers: req.headers, at: Date.now() };
      requests.push(entry);

      if (url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: models.map((id) => ({ id, type: 'model', display_name: id })), has_more: false }));
        return;
      }
      if (url.pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
        return;
      }
      if (url.pathname !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${url.pathname}` } }));
        return;
      }

      const model = body?.model ?? 'unknown';
      const inputTokens = usageFor ? usageFor(body) : estimateTokens(body);
      const limit = limits[model];
      if (limit && inputTokens > limit) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${inputTokens} tokens > ${limit} maximum` } }));
        return;
      }
      const plan = (script && script(body, entry)) || { text: 'ok' };
      if (plan.status) {
        res.writeHead(plan.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: plan.message ?? 'rejected' } }));
        return;
      }
      const id = `msg_fake_${++seq}`;
      const blocks = plan.toolUse
        ? [{ type: 'tool_use', id: `toolu_fake_${seq}`, name: plan.toolUse.name, input: plan.toolUse.input ?? {} }]
        : [{ type: 'text', text: plan.text ?? 'ok' }];
      const stopReason = plan.toolUse ? 'tool_use' : 'end_turn';
      const usage = { input_tokens: inputTokens, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

      if (!body?.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      blocks.forEach((block, index) => {
        if (block.type === 'text') {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
        } else {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }
        send('content_block_stop', { type: 'content_block_stop', index });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
