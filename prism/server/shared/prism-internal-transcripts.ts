import path from 'node:path';

/**
 * Prism 自己起 CLI 时用的 cwd 标记:带这些标记的 transcript 不是用户的会话,
 * 不能进项目列表。
 *
 * cwd 会被编码进 `~/.claude/projects` 的目录名(分隔符换成连字符),所以标记在
 * 编码后仍然可辨认。
 *
 * - `prism-model-probe`:/models 弹窗「实测真实模型」的探测 cwd。CLI 每跑一次都会留下
 *   transcript,不忽略的话每次探测都会往所有人的侧栏里广播一个幽灵项目。
 *
 * 新增"Prism 自己跑 CLI"的入口时,只加进这张表不够:全量同步
 * (ClaudeSessionSynchronizer.synchronize)走的是另一条路,也要用同一条判据
 * (`isPrismInternalTranscript`);已经落进 `projects` 表的行这两条都挡不住,
 * 要靠 `pruneInternalProjects` 按真实路径清理。
 *
 * 判据放在 shared/ 这个谁也不依赖的叶子模块里,watcher(`sessions-watcher.service`)和
 * 全量同步的 provider 都往下引、不互相引:watcher 依赖 session-synchronizer →
 * provider.registry → provider,provider 若从 watcher 引入判据就会成环,类字段初始化时
 * `ClaudeSessionSynchronizer` 还是 undefined,报 `is not a constructor`,整个 provider 层
 * 起不来(类型检查看不出来)。
 */
export const PRISM_INTERNAL_CWD_MARKERS = [
  'prism-model-probe',
  // 技能优化(SkillWhet):`whet serve` 每次调 `claude -p` 都会 mkdtemp 一个 cwd,
  // 形如 `<home>/tmp/prism-skillwhet/<mkdtemp>`,不忽略就会长出幽灵项目。默认 home
  // `~/.prism/skillwhet` 编码后本身也带这个标记。
  'prism-skillwhet',
] as const;

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
 * watcher 与全量同步共用这一条 —— 分成两份判据就会出现「运行时不进列表、
 * 重启后全都进来了」这种最难查的不一致。
 */
export function isPrismInternalTranscript(filePath: string): boolean {
  return path.normalize(filePath).split(path.sep).some((segment) => {
    const normalized = normalizeSeparators(segment);
    return PRISM_INTERNAL_CWD_MARKERS.some((marker) => normalized.includes(marker));
  });
}

/**
 * 这个项目路径(不是 transcript 路径)是不是 Prism 自己的工作目录。
 *
 * ## 为什么名字标记不够,还要一条按路径的
 *
 * 标记判据看的是 `~/.claude/projects/<cwd 编码>` 那个编码后的目录名。它挡住了
 * transcript 进列表,但挡不住已经进去的:项目一旦在 `projects` 表里落了行,
 * 列表就直接从库里读,watcher 判不判都一样。所以清理存量要按真实 cwd 判,
 * 而 cwd 就是 `projects.project_path`。
 *
 * 宁可漏判不可错判 —— 判错一个就是删掉用户真实的项目行,所以只认下面两种确定的形状,
 * 不做模糊匹配。
 */
export function isPrismInternalProjectPath(projectPath: string): boolean {
  if (!projectPath) return false;
  const normalized = path.normalize(projectPath).replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => normalizeSeparators(segment).includes('prism-model-probe'))) return true;
  // 技能优化的临时目录是 `<home>/tmp/prism-skillwhet/<mkdtemp>`,标记必须是一整个目录段,
  // 普通项目里叫 `skillwhet` 的目录不受影响。
  return segments.some((segment) => segment === 'prism-skillwhet');
}
