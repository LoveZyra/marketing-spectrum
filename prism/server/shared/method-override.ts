import type { NextFunction, Request, Response } from 'express';

/**
 * ea:HTTP 方法隧道 —— 让 PATCH / PUT / DELETE 能穿过只放行 GET/POST 的代理。
 *
 * 症状(用户实测):同一个账号、同一台服务器、同一个页面,定时任务详情里的
 * 「启用/暂停」开关在 Mac 上能点,在公司的 Windows 机器上点了毫无反应。
 * 这个开关发的是 `PATCH /api/tasks/:id`;而 Prism 线上是明文 HTTP,企业代理 /
 * 上网行为管理设备能看见每个请求并按方法过滤 —— 只认 GET/POST 是这类设备
 * 相当常见的默认策略(PATCH 在 RFC 5789 才定义,老规则集根本不认识它)。
 * Mac 走的是别的网络,所以没事。同一台 Windows 机器上传截图也失败过(0 字节),
 * 与"这条网络对请求挑三拣四"的判断互相印证。
 *
 * 做法是业界老办法(Rails `_method`、Express `method-override`):前端把
 * PATCH / PUT / DELETE 一律改成 **POST** 发出,真实方法放在
 * `X-HTTP-Method-Override` 头里;服务端在**路由之前**把 `req.method` 改回去,
 * 后面的路由、代理转发、审计日志看到的都是真实方法,一行不用改。
 *
 * 只认这三个方法、只接受从 POST 发起的改写:GET 改写成 DELETE 之类的花样
 * 一概不理 —— 那不是隧道,是绕过。鉴权是 Bearer 令牌(无 cookie),不存在
 * CSRF 面,所以隧道不会把"POST 表单能打到的地方"变宽。
 */
export const METHOD_OVERRIDE_HEADER = 'x-http-method-override';
/**
 * ea+:查询串里的同义写法(`?_method=PATCH`,Rails / Laravel 的老约定)。
 *
 * 上线 ea 后用户实测仍 404,且响应体不是 JSON —— 即 POST 到了服务端却没被改写:
 * 安全型代理 / WAF 会**剥掉** `X-HTTP-Method-Override` 头(它是已知的方法限制
 * 绕过手法,ModSecurity 一类规则集专门盯它)。查询串不会被剥。前端两样都带,
 * 服务端两样都认,谁活着听谁的。
 */
export const METHOD_OVERRIDE_QUERY = '_method';

const TUNNELED_METHODS: ReadonlySet<string> = new Set(['PATCH', 'PUT', 'DELETE']);

function normalizeWanted(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/**
 * 纯函数:这条请求该被改写成什么方法。不该改写时返回 null。
 * 头与查询串任一命中即可;两个都给且不一致时以头为准(它更不容易被误写)。
 * 导出供单测 —— 中间件本身只是在它外面套一层 req/next。
 */
export function resolveOverriddenMethod(method: string, headerValue: unknown, queryValue?: unknown): string | null {
  if (method !== 'POST') return null;
  const fromHeader = normalizeWanted(headerValue);
  if (TUNNELED_METHODS.has(fromHeader)) return fromHeader;
  const fromQuery = normalizeWanted(queryValue);
  return TUNNELED_METHODS.has(fromQuery) ? fromQuery : null;
}

/** 前端要不要给这个方法走隧道。与服务端认的集合是同一份。 */
export function isTunneledMethod(method: string | undefined): boolean {
  return typeof method === 'string' && TUNNELED_METHODS.has(method.toUpperCase());
}

export function methodOverrideMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const query = req.query as Record<string, unknown>;
    const overridden = resolveOverriddenMethod(req.method, req.headers[METHOD_OVERRIDE_HEADER], query?.[METHOD_OVERRIDE_QUERY]);
    if (overridden) {
      (req as Request & { originalMethod?: string }).originalMethod = req.method;
      req.method = overridden;
    }
    // 消费掉查询串里的 _method,别让它漏进路由的 req.query(有的路由会把
    // 整个 query 原样转发给上游代理)。路由匹配看的是 req.path,不受影响。
    if (query && Object.prototype.hasOwnProperty.call(query, METHOD_OVERRIDE_QUERY)) {
      delete query[METHOD_OVERRIDE_QUERY];
    }
    next();
  };
}
