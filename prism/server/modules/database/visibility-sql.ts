import path from 'node:path';

/**
 * 可见性判定的 **SQL 侧**唯一出处。
 *
 * 项目列表(`projectsDb.getProjectPaths`)和归档会话列表(E10)都要在 SQL 里
 * 把"谁能看到什么"下推 —— 不下推就得先全表捞回来再逐行 JS 判定,那是 N+1,
 * 也没法分页(分完页才过滤 = 每页条数飘忽)。但同一条规则抄两份 SQL 迟早会漂,
 * 而漂的方向一半是越权。所以这里只留一份,谁要谁传列名。
 *
 * JS 侧对应 `shared/project-visibility.js` 的 `canViewerSeeProject`,
 * `modules/database/tests/visibility-parity.test.ts` 在同一组样本上交叉验证。
 */

/**
 * SQL 片段:某个路径列算不算"公共目录下"。
 *
 * 必须和 JS 侧 `isPublicWorkspacePath` 逐字同义 —— 词法前缀判定:等于公共根,
 * 或以「根 + 分隔符」开头。公共目录未配置时返回恒假(`0`)。
 *
 * LIKE 的通配符(% _)要转义:公共根路径里若含这些字符,不转义会变成通配。
 * 用 `\` 作转义符并在 SQL 里声明 `ESCAPE '\'`。
 */
export function buildPublicPathClause(pathColumn = 'project_path'): { sql: string; params: string[] } {
  const configured = process.env.PRISM_PUBLIC_WORKSPACE;
  if (!configured || !configured.trim()) {
    return { sql: '0', params: [] };
  }
  const root = path.resolve(configured.trim());
  const escaped = root.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return {
    sql: `(${pathColumn} = ? OR ${pathColumn} LIKE ? ESCAPE '\\')`,
    params: [root, `${escaped}${path.sep}%`],
  };
}

/**
 * SQL 片段:一个(可能不存在的)项目行对某个非 root 用户是否可见。
 *
 * 与 `canViewerSeeProject` 逐条对应:
 *   本人 OR 显式 public OR 被 project_shares 指定 OR (无主且在公共目录下)。
 *
 * `pathColumn` 单独传是因为归档会话那条走 LEFT JOIN:项目行可能根本不存在
 * (会话先被索引、项目还没落行),此时 owner 列为 NULL,判定要回落到**会话自己
 * 记的路径**在不在公共目录下 —— 正是 JS 侧 `projectVisibilityInput(null, path)`
 * 的语义。
 */
export function buildProjectVisibilityClause(options: {
  userId: number;
  projectIdColumn?: string;
  ownerColumn?: string;
  visibilityColumn?: string;
  pathColumn?: string;
}): { sql: string; params: unknown[] } {
  const projectIdColumn = options.projectIdColumn ?? 'project_id';
  const ownerColumn = options.ownerColumn ?? 'owner_user_id';
  const visibilityColumn = options.visibilityColumn ?? 'visibility';
  const publicClause = buildPublicPathClause(options.pathColumn ?? 'project_path');

  return {
    sql: `(
      ${ownerColumn} = ?
      OR ${visibilityColumn} = 'public'
      OR ${projectIdColumn} IN (SELECT project_id FROM project_shares WHERE user_id = ?)
      OR (${ownerColumn} IS NULL AND ${publicClause.sql})
    )`,
    params: [options.userId, options.userId, ...publicClause.params],
  };
}

/**
 * 访问者的可见范围:`all` 是 root(不过滤),否则按 userId 过滤。
 *
 * 拿不到数字 id 的访问者(平台模式下 `req.user` 整个缺失)用 `NO_SUCH_USER_ID`
 * 这个谁都不是的 id 走同一条子句 —— 结果正好等于 JS 侧对 `viewerUserId: null`
 * 的判定:只看得到显式 public 的项目,以及无主且在公共目录下的项目。多一种
 * "全挡"分支反而会和 JS 侧漂开。
 */
export const NO_SUCH_USER_ID = -1;

export type VisibilityScope =
  | { kind: 'all' }
  | { kind: 'user'; userId: number };
