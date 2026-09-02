/**
 * X-Refreshed-Token 的接收侧闸门(dj)。
 *
 * 背景:服务端对"过半寿命"的 JWT 会在响应头里静默续一张新令牌,客户端此前
 * 无条件写入 localStorage。而 /api 响应长期没有 Cache-Control 却带 ETag,
 * 浏览器磁盘缓存会把响应头连同这张续期令牌一起存下;后续同 URL 命中 304 时,
 * 按 RFC 7234 缓存里的旧头会被合并回响应 —— 于是 A 账号时代缓存下来的续期头,
 * 能在 B 账号登录后"复活",把存储的令牌整个换成 A 的。线上表现:退出 root 后
 * 无论登谁,最终都跳回 root;且网络面板只显示 304,看不到这个头,极难排查。
 *
 * 服务端已同轮加 no-store 断毒源;这里是接收侧的独立防线:**续期令牌只有与
 * 当前存储令牌属于同一个 userId 才接受**。这同时挡住另一族竞态 —— 切换账号的
 * 瞬间,旧账号的在途响应晚到,同样不允许它把新账号的令牌盖掉。
 *
 * 解码只读 payload、不验签名 —— 验签是服务端的事;客户端拿它只回答"这两张
 * 令牌是不是同一个人",伪造的令牌发到服务端也过不了验签。
 */

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** 三段 base64url 的形状检查(不验签)。 */
export const hasJwtShape = (token: unknown): token is string =>
  typeof token === 'string' && JWT_SHAPE.test(token);

/** 解出 JWT payload;任何一步失败返回 null。走 TextDecoder 的 UTF-8,中文用户名不乱码。 */
export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (!hasJwtShape(token)) return null;
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(base64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 续期令牌是否可接受:形状合法、两边都解得开、userId 是数字且一致。
 * 当前没有存储令牌(已登出)时一律拒绝 —— 登出后的会话不允许被晚到的头复活。
 */
export function shouldAcceptRefreshedToken(currentToken: unknown, refreshedToken: unknown): boolean {
  const current = decodeJwtPayload(currentToken);
  const refreshed = decodeJwtPayload(refreshedToken);
  if (!current || !refreshed) return false;
  return typeof refreshed.userId === 'number' && refreshed.userId === current.userId;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/**
 * 三个接收点(fetch 封装 + 两处上传 XHR)共用的落盘入口。
 * 键名与 api.js / ws-auth.ts 一致,刻意硬编码 'auth-token'。
 * 拒收"形状合法但与当前会话不匹配"的令牌时打一条 warn —— 这正是缓存重放 /
 * 跨账号竞态的指纹,值得在控制台留痕。
 */
export function installRefreshedToken(
  refreshedToken: string | null,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage || !hasJwtShape(refreshedToken)) return false;
  const current = storage.getItem('auth-token');
  if (!shouldAcceptRefreshedToken(current, refreshedToken)) {
    console.warn('[Auth] 丢弃一张与当前会话不匹配的续期令牌(已登出,或疑似缓存重放/跨账号竞态)。');
    return false;
  }
  storage.setItem('auth-token', refreshedToken);
  return true;
}
