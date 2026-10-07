/**
 * root(管理员)身份的唯一判定来源。
 *
 * 刻意不落库:root 由 env `PRISM_ROOT_USERS` 指定(逗号分隔),每次现算。
 * 落库会引入一种没人想要的状态 —— 库里标着 is_root 但 env 里已经没有这个人,
 * 或者反过来;两份真相就得有人去对账。env 单一来源换人只改配置,重启即生效。
 *
 * 大小写不敏感、自动去空白:配置里写 " Tianji.Chang , alice " 与
 * "tianji.chang,alice" 等价 —— 这类配置很容易被手抄出空格,不该因此鉴权失败。
 */

/**
 * 用户名的比对键 —— 去首尾空白,只把 ASCII 的 A–Z 折成小写。
 *
 * 为什么不用 `toLowerCase()`:它按 Unicode 折叠,`"\u212Aate"`(开尔文符号 K)会变成
 * `"kate"`;而库里 `users.username` 的 `COLLATE NOCASE` 只折叠 ASCII,认为这两者
 * 是不同的名字、都能注册。若用它,有人注册一个视觉上相同的 `Kate` 就会被 `isRootUser` 判成 root。
 * 比对口径必须与唯一性口径逐字相同 —— 这里就是 SQLite NOCASE 的定义。
 */
export function usernameKey(name) {
  return String(name ?? '').trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

const parseRootUsers = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((name) => usernameKey(name))
      .filter(Boolean),
  );
};

/**
 * @param {string|undefined} username
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isRootUser(username, env = process.env) {
  if (typeof username !== 'string' || !username.trim()) return false;
  return parseRootUsers(env.PRISM_ROOT_USERS).has(usernameKey(username));
}

/**
 * 配置里列出的 root 用户名(已归一化)。启动时回填项目归属要用它去库里找 user id。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function listRootUsernames(env = process.env) {
  return [...parseRootUsers(env.PRISM_ROOT_USERS)];
}

/**
 * 审批闸门是否生效。默认开启;`PRISM_APPROVAL_REQUIRED=0` 是逃生开关 —— 审批逻辑
 * 万一出错,用它一键关掉审批,不必回滚代码。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isApprovalRequired(env = process.env) {
  return String(env.PRISM_APPROVAL_REQUIRED ?? '1').trim() !== '0';
}

/** 新注册用户名的长度上限。不设上限时 MB 级的用户名也能注册成功,会拖垮审批页。 */
export const USERNAME_MAX_LENGTH = 64;

const unicodeFold = (name) => String(name ?? '').trim().normalize('NFKC').toLowerCase();

/**
 * 新注册用户名的校验。返回错误文案,合法则返回 null。
 *
 * 只管新注册,已有账号一个不动。三条:
 * 1. 长度 3–64;
 * 2. 不许有空白与控制字符(中文等 Unicode 字母照常允许);
 * 3. 不许用「兼容字符」(NFKC 规范化后会变样的写法:开尔文符号 K、全角字母、上标数字……),
 *    也不许与 root / bypass 名单里的名字在 Unicode 折叠后撞上 —— 这两类都是长得一样、
 *    库里却算两个人的冒名写法。`usernameKey` 已经让它们判不成 root,这里再从源头不让注册。
 */
export function validateNewUsername(username, env = process.env) {
  const name = String(username ?? '');
  if (name.length < 3) return 'Username must be at least 3 characters';
  if (name.length > USERNAME_MAX_LENGTH) return `Username must be at most ${USERNAME_MAX_LENGTH} characters`;
  if (/[\s\p{C}]/u.test(name)) return 'Username must not contain spaces or control characters';
  if (name.normalize('NFKC') !== name) return 'Username contains look-alike characters; please use plain letters';
  const reserved = [
    ...parseRootUsers(env.PRISM_ROOT_USERS),
    ...String(env.PRISM_ALLOW_BYPASS_USERS ?? '').split(',').map((n) => usernameKey(n)).filter(Boolean),
  ];
  const folded = unicodeFold(name);
  const mine = usernameKey(name);
  if (reserved.some((r) => unicodeFold(r) === folded && r !== mine)) {
    return 'Username is too similar to a reserved account name';
  }
  return null;
}
