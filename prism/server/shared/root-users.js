/**
 * root(管理员)身份的唯一判定来源。
 *
 * 刻意**不落库**:root 由 env `PRISM_ROOT_USERS` 指定(逗号分隔),每次现算。
 * 落库会引入一种没人想要的状态 —— 库里标着 is_root 但 env 里已经没有这个人,
 * 或者反过来;两份真相就得有人去对账。env 单一来源换人只改配置,重启即生效。
 *
 * 大小写不敏感、自动去空白:配置里写 " Tianji.Chang , alice " 与
 * "tianji.chang,alice" 等价 —— 这类配置很容易被手抄出空格,不该因此鉴权失败。
 */

const parseRootUsers = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((name) => name.trim().toLowerCase())
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
  return parseRootUsers(env.PRISM_ROOT_USERS).has(username.trim().toLowerCase());
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
 * 审批闸门是否生效。`PRISM_APPROVAL_REQUIRED=0` 是逃生开关 —— 审批逻辑万一写错,
 * 用它一键退回改动前的行为,不必回滚代码。默认开启。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isApprovalRequired(env = process.env) {
  return String(env.PRISM_APPROVAL_REQUIRED ?? '1').trim() !== '0';
}
