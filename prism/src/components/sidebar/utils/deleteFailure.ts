/**
 * gk:从删除接口的错误回包里取出给人看的原因;取不出就用默认文案。
 *
 * 403(只有项目负责人或管理员可以永久删除)、409(正在跑 / 终端接管中 / 有排队消息)
 * 这几种"重试也没用"的原因,此前一律被翻成「删除会话失败,请重试」。
 */
export function describeDeleteFailure(errorText: string, fallback: string): string {
  try {
    const payload = JSON.parse(errorText) as { error?: unknown; message?: unknown };
    const reason = typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : '';
    return reason.trim() ? reason : fallback;
  } catch {
    return fallback;
  }
}
