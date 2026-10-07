/**
 * 启动链里的一步:同步抛、异步 reject 都在这里接住并记日志,永不向外抛。
 *
 * `server.listen` 回调里的各段(会话监听、营销诊断、SkillWhet serve、夜训、作业清理等)
 * 互不连坐:每段自己包一层,失败只影响它自己那块功能。写成一条直链的话,前面一段 reject
 * 后面就全部不启动,而 unhandledRejection 只记日志不退出进程,这种"半启动"很难被发现。
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
