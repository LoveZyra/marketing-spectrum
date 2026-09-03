/**
 * ei:产出文件在不在项目目录里。
 *
 * agent 用的是这台机器上真实的文件系统:计划文件常落在 `~/.claude/plans/`、
 * 临时脚本落在 `/tmp`。项目文件接口只服务项目根以内的路径,对这些一律 403 ——
 * 所以产出区对**项目外**的文件改走「这段会话的产出」通道(只读 + 下载)。
 *
 * 判空的一条约定:不知道项目根(拿不到 project.fullPath)时返回 true,
 * 也就是按老路走 —— 宁可维持原行为,不要平白把请求改道。
 */
export function isInsideProject(filePath: string, projectPath?: string | null): boolean {
  if (!projectPath) return true;
  const normalized = filePath.replace(/\\/g, '/');
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return true;
  return normalized === root || normalized.startsWith(`${root}/`);
}
