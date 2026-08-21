export type VisibilityMarkKey = 'public' | 'rootOnly' | 'shared' | 'sharedOut';

export type VisibilityMarkInput = {
  /** 无主且落在公共目录下 —— 所有人可见。 */
  isPublic: boolean;
  /** 无主且不在公共目录下 —— 只有 root 收得到。 */
  isRootOnly: boolean;
  /** 别人通过「指定用户」授权给当前用户的项目。 */
  isSharedToViewer: boolean;
  /** 这个项目被授权给了几个人(接收方视角下恒为 0)。 */
  sharedOutCount: number;
};

/**
 * 项目行上该画哪几个可见性图标。
 *
 * 规则只有一句:**只画当前实际生效的那个最宽可见范围。**
 *
 * 这里的坑是"每个判断单看都为真,合起来才是错的",踩过两次:
 *
 * 1. 无主项目共享出去之后,锁(「仅 root 可见」)和「已共享给 1 人」并排挂着 ——
 *    既然分出去了就不是只有 root 看得见,用户读到的是"我明明分出去了,怎么还锁着"。
 * 2. **公共项目还挂「已共享给 N 人」** —— 公共本来就是所有人可见,
 *    再标几个人反而让人读成"只有这几个人能看"。
 *
 * 两次都是同一个毛病:把"底层数据里确实有这么些授权行"当成了"这个状态值得显示"。
 * 所以按范围从宽到窄取第一个:
 *
 *   公共(所有人) > 已共享给 N 人 > 仅 root
 *
 * 宽的那个一旦成立,窄的就被它包含了,不必也不该再画。
 * (「他人共享给你」是另一个维度 —— 它说的是"这个项目是谁给你的",
 *  不是"谁能看见",所以独立判断。)
 *
 * 返回的是有序的 key 列表,顺序即渲染顺序。
 */
export function planVisibilityMarks({
  isPublic,
  isRootOnly,
  isSharedToViewer,
  sharedOutCount,
}: VisibilityMarkInput): VisibilityMarkKey[] {
  const marks: VisibilityMarkKey[] = [];

  if (isPublic) {
    // 所有人可见 —— 底下那两档都被它包含,一个都不再画。
    marks.push('public');
  } else if (sharedOutCount > 0) {
    marks.push('sharedOut');
  } else if (isRootOnly) {
    marks.push('rootOnly');
  }

  // 另一个维度:这个项目是别人开放给你的。和上面的范围标可以并存。
  if (isSharedToViewer) marks.push('shared');

  return marks;
}
