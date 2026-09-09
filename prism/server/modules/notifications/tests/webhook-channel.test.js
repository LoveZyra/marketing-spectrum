import assert from 'node:assert/strict';
import http from 'node:http';

import { afterEach, describe, test } from 'vitest';

import { webhookChannel, __testing } from '../services/webhook-channel.service.js';

/**
 * Webhook 通道 —— 服务端**唯一**的通知出口。
 *
 * 在它之前 `notificationChannels` 是个空数组,也就是说服务端一条通知都发不出去,
 * 而编排管线(偏好闸、去重、payload)还完整跑着。最直接的后果是
 * **定时任务失败没有任何人会知道** —— 而无人值守正是定时任务存在的理由。
 *
 * 这里钉三件事:
 *   1. 启用与否只看"配没配地址"(没配时编排要能按零通道早退,省掉几十次白算的查询);
 *   2. 请求体同时给 `text` 和 `content`,群机器人认哪个都行;
 *   3. **内网地址一律拒发**。
 *
 * 第 3 条最要紧:地址虽然来自运维配置而不是用户输入,但配错一个
 * `http://127.0.0.1:9200` 就会让通知系统变成一台按事件触发的内网探针。
 * 而且哪天有人把地址改成用户可填(这是很自然的下一步),这条测试就是那道防线 ——
 * 到那时它防的是教科书级的 SSRF,而不只是配置手滑。
 */

const PREV = process.env.PRISM_NOTIFY_WEBHOOK_URL;

afterEach(() => {
  if (PREV === undefined) delete process.env.PRISM_NOTIFY_WEBHOOK_URL;
  else process.env.PRISM_NOTIFY_WEBHOOK_URL = PREV;
});

const sampleEvent = {
  code: 'run.failed', kind: 'error', severity: 'error', provider: 'system', sessionId: 's1',
};
const samplePayload = {
  title: '夜间回归',
  body: 'System: 定时任务「夜间回归」执行失败:超时',
  data: { sessionName: '夜间回归' },
};

describe('webhook 通知通道', () => {
  test('没配地址就不启用 —— 编排据此按零通道早退', () => {
    delete process.env.PRISM_NOTIFY_WEBHOOK_URL;
    assert.equal(webhookChannel.isEnabled(), false);
    process.env.PRISM_NOTIFY_WEBHOOK_URL = '   ';
    assert.equal(webhookChannel.isEnabled(), false, '空白串应当等同于没配');
    process.env.PRISM_NOTIFY_WEBHOOK_URL = 'https://example.invalid/hook';
    assert.equal(webhookChannel.isEnabled(), true);
  });

  test('请求体同时给 text 与 content,完整事件放 prism 下', () => {
    const body = __testing.toWebhookBody({ userId: 7, event: sampleEvent, payload: samplePayload });
    // 企业微信认 content,Slack/Discord 认 text —— 两个都给,不认识的会被忽略
    assert.ok(body.text.includes('夜间回归'));
    assert.equal(body.content, body.text);
    assert.equal(body.prism.code, 'run.failed');
    assert.equal(body.prism.userId, 7);
    assert.equal(body.prism.sessionName, '夜间回归');
    assert.ok(body.prism.at, '缺少时间戳,接收端无法排序');
  });

  test('内网地址一律拒发(IP 字面量)', async () => {
    for (const url of [
      'http://127.0.0.1:9200/hook',
      'http://10.0.0.5/hook',
      'http://192.168.1.1/hook',
      'http://169.254.169.254/latest/meta-data/',   // 云元数据服务,SSRF 的经典目标
      'http://[::1]:8080/hook',
    ]) {
      await assert.rejects(
        () => __testing.assertPublicDestination(url),
        /内网/,
        `${url} 没有被挡下`,
      );
    }
  });

  test('公网 IP 字面量放行', async () => {
    await __testing.assertPublicDestination('https://93.184.216.34/hook');
  });

  test('非 http(s) 协议拒绝', async () => {
    await assert.rejects(() => __testing.assertPublicDestination('file:///etc/passwd'), /协议/);
    await assert.rejects(() => __testing.assertPublicDestination('gopher://x/hook'), /协议/);
  });

  test('send 到内网地址时**不会真的发出请求**', async () => {
    // 起一个真的本地接收端:如果守卫失效,它会收到请求 —— 用"收到几条"来判,
    // 比断言抛错更硬(抛错也可能是别的原因抛的)。
    const received = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => { received.push(raw); res.writeHead(200); res.end('ok'); });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    process.env.PRISM_NOTIFY_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
    try {
      await assert.rejects(
        () => webhookChannel.send({ userId: 7, event: sampleEvent, payload: samplePayload }),
        /内网/,
      );
      assert.deepEqual(received, [], '守卫失效:请求真的发到内网去了');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
