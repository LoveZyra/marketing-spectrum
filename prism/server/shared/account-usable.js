import { isApprovalRequired, isRootUser } from './root-users.js';

/**
 * 「这个账号现在还能不能用」的统一判定。凭据换用户的入口(API key、SSE / 下载 / 预览 / 任务票、
 * Jupyter 会话等)都要过这一道,否则被停用或驳回的人仍能凭手里的凭据访问。
 *
 * 规则与登录接口的审批闸门一致:停用即不可用;root 不受审批约束;`PRISM_APPROVAL_REQUIRED=0` 时不查审批。
 * 传了 tokenVersion 时还要与账号当前的 token_version 相等(停用 / 驳回 / 改密码 / 退出所有设备都会递增它)。
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
