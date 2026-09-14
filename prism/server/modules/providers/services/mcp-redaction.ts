import type { ProviderMcpServer } from '@/shared/types.js';

/**
 * F03:**`user` 作用域的 MCP 配置能看见,但看不见里面的凭据。**
 *
 * ## 事故面
 *
 * `scope: 'user'` 写的是 `~/.claude.json` —— **服务进程的家目录**,对包括 root
 * 在内的每个人生效。它不是"某个项目的配置",是全机配置,而里面的
 * `env`(stdio server 的环境变量)与 `headers`(http/sse server 的请求头)
 * 正是放 API key、bearer token 的地方。
 *
 * 不带 `scope` 的那条列表接口过了项目检查就把 **user / local / project 三组
 * 原样返回** —— 任何登录用户读一次就拿到全机 MCP 配置里的凭据。
 *
 * ## 为什么是"打码"而不是"不给看"
 *
 * fj 把 user 作用域收成了 root-only,但那道门**读写一起挡**,而前端的 MCP 页面
 * 对所有人都会拉一次 `scope=user` —— 于是普通用户打开那个页面就看到一条报错。
 * 而"这台机器上装了哪些 MCP server"本身不是秘密:它决定了你的会话能调用什么,
 * 看不见反而让人困惑。
 *
 * 所以规矩定成:**能读到的 = 能写的**,再加一条"看得见有哪些、看不见里面装了什么"。
 * 键名保留(用户能看出"这个 server 需要一个 GITHUB_TOKEN"),值一律换成占位符。
 *
 * 写入不受影响:普通用户本来就写不了 user 作用域,不存在"读回打码值再写回去
 * 把凭据洗掉"的往返。
 */
export const REDACTED_VALUE = '••••••';

function redactRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return record;
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    out[key] = REDACTED_VALUE;
  }
  return out;
}

/** 打掉一条 server 上的凭据字段,其余原样保留。 */
export function redactMcpSecrets(server: ProviderMcpServer): ProviderMcpServer {
  const hasEnv = server.env !== undefined;
  const hasHeaders = server.headers !== undefined;
  if (!hasEnv && !hasHeaders) return server;
  return {
    ...server,
    ...(hasEnv ? { env: redactRecord(server.env) } : {}),
    ...(hasHeaders ? { headers: redactRecord(server.headers) } : {}),
  };
}

export function redactMcpSecretsInList(servers: ProviderMcpServer[]): ProviderMcpServer[] {
  return servers.map(redactMcpSecrets);
}

/**
 * 这个作用域对这个调用者要不要打码。
 *
 * `user` 是全机配置,只有 root 写得了 —— 也只有 root 看得到里面的值。
 * `project` / `local` 属于调用者已经过了可见性检查的那个项目,照旧原样返回:
 * **能读到的 = 能写的**。
 */
export function shouldRedactScope(scope: string | null | undefined, isRoot: boolean): boolean {
  return scope === 'user' && !isRoot;
}
