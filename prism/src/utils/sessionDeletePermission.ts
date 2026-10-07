/**
 * 「这条会话我能不能永久删除」:客户端这一侧的判据。
 *
 * 永久删除只给项目负责人与 root,服务端会拦(403 `SESSION_DELETE_FORBIDDEN`)。界面也要按
 * 同一条规则决定画不画那枚红色主按钮「永久删除」:给用户一个必然失败的主按钮比不给还糟,
 * 它把"这事你做不了"藏在了一次失败之后。
 *
 * 服务端仍然是权威:这里算的是要不要把按钮画出来,不是要不要放行;放行永远由服务端的
 * `canViewerManageSession` 说了算(客户端的项目 owner 可能是旧数据)。两边的规则必须一致,
 * 下面逐条对着服务端那份写,改一边就得改另一边。
 *
 * 服务端(`session-visibility.ts` / `project-permissions.service.ts`)的三条:
 *   1. root 全放行;
 *   2. 项目 owner 放行;
 *   3. 无主项目(`owner_user_id IS NULL`)没有"负责人"这一档,回落到可见性:看得见就能删。
 *      公共目录扫进来的项目都属于这一档,不这样的话普通用户连自己的会话都删不掉。
 */

export type SessionDeletePermissionInput = {
  /** 当前用户是不是 root。 */
  isRoot?: boolean | null;
  /** 当前用户 id(没登录 / 拿不到就是 null)。 */
  viewerUserId?: number | string | null;
  /**
   * 这条会话所属项目的 owner。
   *
   * `null` / `undefined` 都当作"无主"处理 —— 与服务端一致。注意:调用方
   * 拿不到项目(比如列表还没加载)时不要瞎传 null,那会把按钮放出来;
   * 这种情况下别传这个字段,让 `canPermanentlyDeleteSession` 回到保守的
   * "先画出来、由服务端拦"(见下面的 `projectKnown`)。
   */
  projectOwnerUserId?: number | string | null;
  /**
   * 项目信息到底拿到了没有。false = 没拿到,这时一律返回 true(维持老行为:
   * 画出来,由服务端 403 兜底),免得因为一次加载时序把按钮藏错。
   */
  projectKnown?: boolean;
};

const sameUser = (a: number | string | null | undefined, b: number | string | null | undefined): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
};

export function canPermanentlyDeleteSession(input: SessionDeletePermissionInput): boolean {
  const { isRoot, viewerUserId, projectOwnerUserId, projectKnown = true } = input;
  if (isRoot) return true;
  // 项目还没拿到手:不敢下结论,按老行为画出来,服务端仍然会拦。
  if (!projectKnown) return true;
  // 无主项目:没有"负责人"这一档,看得见就能删(能走到这里就说明看得见)。
  if (projectOwnerUserId === null || projectOwnerUserId === undefined) return true;
  return sameUser(projectOwnerUserId, viewerUserId);
}

/**
 * 归档或永久删除一个项目:与上面那条同一条规则,只差无主项目(项目级只给 root,见函数体)。
 *
 * 归档一个项目,它会从所有人的活跃侧栏里消失,所以不能"看得见就能做";服务端按
 * `canArchiveProject === canDeleteProject` 收紧,界面按同一条算,不该做的就不画那两枚按钮。
 *
 * (会话级归档不受影响:那只影响归档的人自己看到的列表。)
 */
export function canArchiveOrDeleteProject(input: SessionDeletePermissionInput): boolean {
  const { isRoot, viewerUserId, projectOwnerUserId, projectKnown = true } = input;
  if (isRoot) return true;
  if (!projectKnown) return true;
  // 项目级没有无主回落:公共目录下的无主项目,归档 / 永久删只给 root
  // (服务端 canDeleteProject === canManageProject)。会话级的判定(上面)仍按可见性回落。
  if (projectOwnerUserId === null || projectOwnerUserId === undefined) return false;
  return sameUser(projectOwnerUserId, viewerUserId);
}
