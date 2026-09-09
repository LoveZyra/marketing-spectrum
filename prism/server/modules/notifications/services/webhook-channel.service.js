import dns from 'node:dns/promises';
import net from 'node:net';

import { isPrivateIp } from '@/shared/ip-guard.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('notify');

/**
 * Webhook 通知通道。
 *
 * ## 为什么先做这一个
 *
 * 编排管线(偏好闸、去重窗口、payload 构造)一直是完整的,`notificationChannels`
 * 却是个**空数组** —— Web Push / Electron 两个通道在 web-only 重构时被删掉,
 * 之后一条服务端通知都发不出去。
 *
 * 最直接的后果:**定时任务失败没有任何人会知道。** 周一早六点的批量回归连炸三次,
 * 团队十点打开页面才发现。而这恰恰是"定时任务"这个功能存在的理由 ——
 * 无人值守。无人值守而没有告警,等于把失败藏起来。
 *
 * Webhook 是投入产出最高的一个:企业微信 / 飞书 / Slack 群机器人都收 POST JSON,
 * 不需要证书、不需要客户端注册、不需要用户在浏览器里点允许。
 *
 * ## 为什么地址只从环境变量来,不做成用户可填
 *
 * 用户可填的 URL 是**教科书级的 SSRF**:任何登录用户填一个
 * `http://169.254.169.254/latest/meta-data/` 就能让服务端替他去打内网。
 * 这个仓库为此专门有 `shared/ip-guard.js`(文档抓取用),但那条路是有意的对外抓取,
 * 而通知地址一旦可填就成了持久化的、每次事件都会被触发的 SSRF。
 *
 * 所以地址由**运维在 .env 里配**,和反代目标、数据库路径同一个信任级别。
 * 即便如此仍然过一遍 ip-guard —— 配错(比如误填 localhost 上的管理端口)
 * 也不该让通知系统变成内网探针。
 *
 * 哪天真要做成用户可填,必须配套:管理员维护白名单域名 + 每次发送前重新解析校验
 * (DNS rebinding),而不是只在保存时校验一次。
 *
 * ## 失败只记日志,不重试
 *
 * 通知是**尽力而为**的旁路。重试要维护队列和退避,而通知本身的时效性很短 ——
 * 一条五分钟前的"任务失败"重试成功了也没什么用。更要紧的是:通知投递失败绝不能
 * 反过来影响它在通知的那件事(回合、任务),所以整条路径既不抛也不 await。
 */

const WEBHOOK_TIMEOUT_MS = 8000;

/**
 * 目标必须是公网地址。
 *
 * 地址虽然来自运维配置(不是用户输入),这一道仍然要有:配错一个
 * `http://127.0.0.1:9200` 之类的内网端口,通知系统就变成了一台按事件触发的内网探针。
 * 判据复用 `shared/ip-guard.js` —— 文档抓取那条路已经在用同一份,不另写一套。
 *
 * 逐个解析出来的地址都要判,而不是只判第一个:一个域名可以同时解析出公网和内网 A 记录。
 */
async function assertPublicDestination(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`webhook 协议不支持:${parsed.protocol}`);
  }
  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('webhook 指向内网地址,拒绝发送');
    return;
  }
  const resolved = await dns.lookup(hostname, { all: true });
  for (const entry of resolved) {
    if (isPrivateIp(entry.address)) throw new Error('webhook 域名解析到内网地址,拒绝发送');
  }
}

const readWebhookUrl = (env = process.env) => {
  const raw = typeof env.PRISM_NOTIFY_WEBHOOK_URL === 'string' ? env.PRISM_NOTIFY_WEBHOOK_URL.trim() : '';
  return raw || null;
};

/**
 * 群机器人的通用形状:大多数(企业微信 / 飞书 / Slack / Discord)都认
 * `{ text }` 或 `{ content }`。两个字段都给,收不认识的那个会被忽略;
 * 完整事件放在 `prism` 下,自建接收端可以直接用。
 */
const toWebhookBody = ({ userId, event, payload }) => ({
  text: `${payload.title}\n${payload.body}`,
  content: `${payload.title}\n${payload.body}`,
  prism: {
    userId,
    code: event.code,
    kind: event.kind,
    severity: event.severity ?? 'info',
    provider: event.provider ?? null,
    sessionId: event.sessionId ?? null,
    sessionName: payload.data?.sessionName ?? null,
    title: payload.title,
    body: payload.body,
    at: new Date().toISOString(),
  },
});

export const webhookChannel = {
  id: 'webhook',

  /**
   * 通道级开关只看"配没配地址"。**事件级的开关由编排层的偏好闸负责** ——
   * 那一层已经按 actionRequired / stop / error 三档过滤过了,这里再判一次
   * 就是第二份判据,迟早漂。
   */
  isEnabled() {
    return readWebhookUrl() !== null;
  },

  async send({ userId, event, payload }) {
    const url = readWebhookUrl();
    if (!url) return;
    await assertPublicDestination(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toWebhookBody({ userId, event, payload })),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 只记状态码,不记响应体 —— 群机器人的错误响应里可能带回 webhook token
        log.warn(`[notify] webhook 返回 ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  },
};

export const __testing = { readWebhookUrl, toWebhookBody, assertPublicDestination };
