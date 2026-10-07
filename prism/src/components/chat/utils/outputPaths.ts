/**
 * 产出文件是否在项目目录内。
 *
 * agent 操作的是本机真实文件系统:计划文件常落在 `~/.claude/plans/`、临时脚本落在 `/tmp`。
 * 项目文件接口只服务项目根以内的路径(其余一律 403),所以产出区对项目外的文件
 * 走「这段会话的产出」通道(只读 + 下载)。
 *
 * 不知道项目根(拿不到 project.fullPath)时返回 true,按项目内文件处理,不贸然把请求改道。
 */
export function isInsideProject(filePath: string, projectPath?: string | null): boolean {
  if (!projectPath) return true;
  const normalized = filePath.replace(/\\/g, '/');
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return true;
  return normalized === root || normalized.startsWith(`${root}/`);
}
