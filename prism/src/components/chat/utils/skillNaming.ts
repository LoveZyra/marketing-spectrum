/**
 * 技能调用的纯识别逻辑(do)。徽标(MessageComponent)和会话命名
 * (useChatComposerState)共用,零依赖,方便单测。
 */

/** 技能目录一条:useSkillsCatalog 拉回来的形状。 */
export interface SkillCatalogEntry {
  /** 呼出命令,形如 `/echo-probe` 或 `/plugin:name`。 */
  command: string;
  name: string;
  description: string;
}

/**
 * 一条用户消息是不是显式技能调用:首个词就是某个技能命令(允许后随参数)。
 */
export function matchSkillInvocation(
  content: string,
  entries: readonly SkillCatalogEntry[],
): SkillCatalogEntry | null {
  const trimmed = (content || '').trimStart();
  if (!trimmed.startsWith('/')) return null;
  const firstToken = trimmed.split(/\s/, 1)[0];
  return entries.find((entry) => entry.command === firstToken) ?? null;
}

/** 命令菜单里一条命令的最小结构 —— 只取命名要用的字段。 */
export interface SkillCommandLike {
  name: string;
  description?: string;
  namespace?: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

const isSkillEntry = (command: SkillCommandLike): boolean =>
  command.type === 'skill' ||
  command.namespace === 'skill' ||
  command.metadata?.type === 'skill';

/**
 * 会话命名对技能调用友好:首条消息是 `/echo-probe 参数…` 时,侧栏别挂一行
 * 斜杠黑话 —— 换成「技能名:参数」;没带参数就用技能描述(再退回技能名)。
 * 不是技能调用时原样返回,命名行为与从前一致。
 */
export function describeSkillInvocationInput(
  rawInput: string,
  commands: readonly SkillCommandLike[],
): string {
  const trimmed = (rawInput || '').trimStart();
  if (!trimmed.startsWith('/')) return rawInput;
  const firstToken = trimmed.split(/\s/, 1)[0];
  const matched = commands.find(
    (command) => command.name === firstToken && isSkillEntry(command),
  );
  if (!matched) return rawInput;

  const metadataSkillName = matched.metadata?.skillName;
  const skillName =
    typeof metadataSkillName === 'string' && metadataSkillName.trim()
      ? metadataSkillName.trim()
      : firstToken.replace(/^\//, '');
  const args = trimmed.slice(firstToken.length).trim();
  if (args) return `${skillName}:${args}`;

  const description = typeof matched.description === 'string' ? matched.description.trim() : '';
  return description || skillName;
}
