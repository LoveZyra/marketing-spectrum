import { isApprovalRequired, isRootUser } from './root-users.js';

/**
 * hj(审计 P1-2):「这个账号**现在**还能不能用」的唯一判定。
 *
 * JWT 与 WS 票据早就查了 is_active + token_version(停用 / 驳回 / 改密码 / 退出所有设备都会
 * bump token_version),但另外几条凭据各查各的、或者干脆不查:
 * - 用户自己的 API key 只看 `u.is_active`,**不看审批状态** —— 驳回一个已批准的人,他的 key 照用;
 * - 下载票 / 预览票 / 搜索票 / 任务票消费时不查账号状态,也不认 token_version;
 * - Jupyter 的会话 cookie 根本不绑用户。
 * 这里把登录接口的审批闸门原样搬过来(root 不受审批约束;`PRISM_APPROVAL_REQUIRED=0` 整个关掉审批),
 * 再加上可选的 token_version 比对。所有「凭据 → 用户」的入口都应该过这一道。
 *
 * 纯函数、不碰库:调用方自己用 `userDb.getUserById`(它只返回 is_active=1 的行)取行传进来。
 *
 * @param {{ username?: string, is_active?: number, approval_status?: string|null, token_version?: number|null } | null | undefined} user
 * @param {{ tokenVersion?: number | null }} [options] 签发凭据时记下的 token_version;不传 / null 则不比对
 * @returns {boolean}
 */
export function isAccountUsable(user, options = {}) {
  if (!user) return false;
  if (user.is_active === 0 || user.is_active === false) return false;
  if (!isRootUser(user.username) && isApprovalRequired()) {
    const status = user.approval_status ?? 'approved';
    if (status !== 'approved') return false;
  }
  const expected = options.tokenVersion;
  if (typeof expected === 'number' && (user.token_version ?? 0) !== expected) return false;
  return true;
}
