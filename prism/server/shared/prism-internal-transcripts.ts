import path from 'node:path';

/**
 * Prism 自己起 CLI 时用的 cwd 标记 —— 带这些标记的 transcript **不是用户的会话**,
 * 不能进项目列表。
 *
 * cwd 会被编码进 `~/.claude/projects` 的目录名(分隔符换成连字符),所以标记在
 * 编码后仍然可辨认。
 *
 * - `prism-model-probe`:/models 弹窗「实测真实模型」留下的。不忽略的话每次探测
 *   都会往所有人的侧栏里广播一个幽灵项目 —— 这正是 `getSupportedModels()` 被禁用的原因。
 *
 * ⚠️ 以后再加"Prism 自己跑 CLI"的入口时先想清楚:**只加进这张表不够**,
 * 全量同步(ClaudeSessionSynchronizer.synchronize)走的是另一条路,它也要用同一条
 * 判据(`isPrismInternalTranscript`);而**已经落进 `projects` 表的行**这两条都挡不住,
 * 那些要靠 `pruneInternalProjects` 按真实路径清账。
 *
 * ## 为什么这些东西住在 shared/ 而不是 watcher 里
 *
 * 用它的有两处:watcher(`sessions-watcher.service`)和**全量同步的 provider**。
 * 判据原本写在 watcher 里,provider 反向 import 它 —— 而 watcher 依赖
 * session-synchronizer → provider.registry → provider 本身,于是形成一圈:
 * provider 的类字段初始化时 `ClaudeSessionSynchronizer` 还是 undefined,
 * 报 `is not a constructor`,整个 provider 层起不来(类型检查看不出来)。
 *
 * 所以判据落在一个**谁也不依赖**的叶子模块上。两边都往下引,不互相引。
 */
export const PRISM_INTERNAL_CWD_MARKERS = ['prism-model-probe'] as const;

/**
 * 比较前把下划线抹平成连字符。
 *
 * 同一个目录有两种写法要认:磁盘上的真实路径可能带下划线,而
 * `~/.claude/projects` 下的编码目录名把分隔符统一换成了连字符。
 */
const normalizeSeparators = (value: string): string => value.replace(/_/g, '-');

/**
 * 这条 transcript 是不是 Prism 自己跑出来的(而不是用户的会话)。
 *
 * **watcher 与全量同步共用这一条** —— 分成两份判据就会出现「运行时不进列表、
 * 重启后全都进来了」这种最难查的不一致。
 */
export function isPrismInternalTranscript(filePath: string): boolean {
  return path.normalize(filePath).split(path.sep).some((segment) => {
    const normalized = normalizeSeparators(segment);
    return PRISM_INTERNAL_CWD_MARKERS.some((marker) => normalized.includes(marker));
  });
}

/**
 * 这个**项目路径**(不是 transcript 路径)是不是 Prism 自己的工作目录。
 *
 * ## 为什么名字标记不够,还要一条按路径的
 *
 * 标记判据看的是 `~/.claude/projects/<cwd 编码>` 那个编码后的目录名。它挡住了
 * transcript 进列表 —— 但**挡不住已经进去的**:项目一旦在 `projects` 表里落了行,
 * 列表就直接从库里读,watcher 判不判都一样。所以清理存量要按**真实 cwd** 判,
 * 而 cwd 就是 `projects.project_path`。
 *
 * 宁可漏判不可错判 —— 判错一个就是删掉用户真实的项目行,所以只认这一种形状,
 * 不做模糊匹配。
 */
export function isPrismInternalProjectPath(projectPath: string): boolean {
  if (!projectPath) return false;
  const normalized = path.normalize(projectPath).replace(/\\/g, '/');
  return normalized.split('/').some(
    (segment) => normalizeSeparators(segment).includes('prism-model-probe'),
  );
}
