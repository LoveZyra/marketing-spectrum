import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { describe, test } from 'vitest';

import { watchClientDisconnect } from '../agent.js';

/**
 * 外部 Agent API 同步回合的「客户端断开就中止」。
 *
 * 路由跑到开回合那一步时,请求体早被 body parser 读完,Node 22 的 IncomingMessage 读完即 autoDestroy、
 * `req` 的 'close' 已经发过,这时再 `req.once('close')` 永远不会触发:SSE 调用方超时、反代掐断、
 * 用户关页之后回合照跑到底,CLI 子进程继续几十分钟,运行位一直占着。断开要听 `res` 的 'close'。
 *
 * 这里起一个真的 express 服务(express.json 读完请求体,再隔一段时间才开始盯断开,模拟路由里
 * 建项目 / 克隆那几段 await),由客户端主动断开。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {(req: import('express').Request, res: import('express').Response, events: string[]) => void} handler
 *   在请求体读完、隔 50ms 之后调用
 */
async function withServer(handler, runClient) {
  const events = [];
  const app = express();
  app.post('/', express.json(), (req, res) => {
    setTimeout(() => handler(req, res, events), 50);
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await runClient(port, events);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  return events;
}

function postJson(port, body) {
  const request = http.request({
    host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' },
  });
  request.on('error', () => {});
  const response = new Promise((resolve) => {
    request.on('response', (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(text));
      res.on('error', () => resolve(text));
    });
  });
  request.end(JSON.stringify(body));
  return { request, response };
}

describe('watchClientDisconnect', () => {
  test('流式回合中途客户端断开 → 回调一次', async () => {
    const events = await withServer((req, res, log) => {
      watchClientDisconnect(res, () => log.push('disconnect'));
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: hi\n\n');
    }, async (port, log) => {
      const { request } = postJson(port, { message: 'x' });
      await sleep(200);
      request.destroy();
      await sleep(100);
      assert.deepEqual(log, ['disconnect']);
    });
    assert.deepEqual(events, ['disconnect']);
  });

  test('对照:请求体读完之后才注册的 req "close" 不会再触发', async () => {
    await withServer((req, res, log) => {
      assert.equal(req.closed, true, '路由跑到这里时 req 早已 closed');
      req.once('close', () => log.push('req-close'));
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: hi\n\n');
    }, async (port, log) => {
      const { request } = postJson(port, { message: 'x' });
      await sleep(200);
      request.destroy();
      await sleep(100);
      assert.deepEqual(log, [], '这就是只听 req 时「断开就中止」从不生效的原因');
    });
  });

  test('正常收尾(响应写完)不算断开', async () => {
    await withServer((req, res, log) => {
      watchClientDisconnect(res, () => log.push('disconnect'));
      res.json({ ok: true });
    }, async (port, log) => {
      const { response } = postJson(port, { message: 'x' });
      assert.equal(await response, '{"ok":true}');
      await sleep(100);
      assert.deepEqual(log, []);
    });
  });

  test('开始盯之前客户端就已经走了 → 也回调(异步,开回合那一步之后)', async () => {
    const events = [];
    const app = express();
    let arm;
    const armed = new Promise((resolve) => { arm = resolve; });
    app.post('/', express.json(), (req, res) => {
      // 等客户端断开之后再开始盯
      setTimeout(() => {
        events.push(`destroyed=${res.destroyed}`);
        watchClientDisconnect(res, () => events.push('disconnect'));
        events.push('armed');
        arm();
      }, 250);
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { request } = postJson(server.address().port, { message: 'x' });
      await sleep(100);
      request.destroy();
      await armed;
      await sleep(50);
      assert.deepEqual(events, ['destroyed=true', 'armed', 'disconnect'], '回调晚于 watchClientDisconnect 返回');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('解除之后再断开不回调(回合跑完后同一会话可能已经开了下一轮)', async () => {
    await withServer((req, res, log) => {
      const stop = watchClientDisconnect(res, () => log.push('disconnect'));
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: hi\n\n');
      stop();
    }, async (port, log) => {
      const { request } = postJson(port, { message: 'x' });
      await sleep(200);
      request.destroy();
      await sleep(100);
      assert.deepEqual(log, []);
    });
  });
});

/**
 * 路由接线:同步回合在开跑前盯上断开、回合一结束就解除。读源码,整句钉住。
 *
 * 解除要放在回合的 finally 里:回合跑完之后 finally 会续发网页上排队的那条消息,那一轮登记在同一个
 * runId(app 会话 id)下;这时调用方再断开,按 runId 中止就会把网页那一轮停掉。
 */
describe('POST /api/agent 同步回合的断开中止接线', () => {
  const source = readFileSync(fileURLToPath(new URL('../agent.js', import.meta.url)), 'utf8');

  test('不再听 req 的 close', () => {
    assert.doesNotMatch(source, /req\.once\('close'/);
    assert.doesNotMatch(source, /req\.on\('close'/);
  });

  test('占了运行位的同步回合在 queryClaudeSDK 之前盯上断开,finally 里第一件事是解除', () => {
    const armAt = source.indexOf('const stopWatchingDisconnect = syncRun');
    const callAt = source.indexOf('turnOutcome = await queryClaudeSDK(message.trim(), {');
    assert.ok(armAt > 0, '没有盯断开');
    assert.ok(callAt > armAt, '要在开回合之前盯上');
    const between = source.slice(armAt, callAt);
    assert.doesNotMatch(between, /\bawait\b/, '盯上与开回合之间不能有 await(否则断开回调可能早于回合登记)');
    const finallyAt = source.indexOf('} finally {', callAt);
    assert.match(source.slice(finallyAt, finallyAt + 200), /\} finally \{\s*\n\s*stopWatchingDisconnect\?\.\(\);/);
    assert.match(between, /abortClaudeSDKSession\('', \{ runId: appSessionId \}\)/);
  });
});
