/**
 * 启动链里的一步:同步抛、异步 reject 都在这里接住并记日志,**永不向外抛**。
 *
 * hl 复核(P3):`server.listen` 回调里原来是一条直链 —— `await initializeSessionsWatcher()`
 * 一旦 reject,后面的营销诊断、SkillWhet serve、夜训、作业清理全部不会启动,日志里只剩一行
 * `[UNHANDLED]`(hl 起 unhandledRejection 不再退出进程,这种"半启动"更不容易被发现)。
 * 各段互不连坐:每段自己包一层,失败只影响它自己那块功能。
 *
 * @param {string} label  日志里的名字
 * @param {() => unknown} fn  这一步;可返回 promise
 * @param {{ error: (...args: unknown[]) => void }} logger
 * @returns {Promise<boolean>} 成功 true,失败 false
 */
export async function runStartupStep(label, fn, logger) {
  try {
    await fn();
    return true;
  } catch (error) {
    logger.error(`[Startup] ${label} 失败(其余启动步骤照常):`, error?.message || error);
    return false;
  }
}
