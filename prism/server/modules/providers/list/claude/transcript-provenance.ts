import type { AnyRecord } from '@/shared/types.js';

/**
 * 一条 `role: 'user'` 的记录,到底是不是「人在输入框里敲进来的」。
 *
 * 这个模块只回答这一个问题,但它是整条链路上唯一回答它的地方 —— 实时 SDK 流
 * 与历史 JSONL 回放最终都汇进 `normalizeMessage`,所以这里判错一次,聊天里就会
 * 凭空多出一条"用户消息"。
 *
 * ## 为什么会有"假用户消息"
 *
 * Claude 的协议里,`role: 'user'` 并不等于"用户说的"。至少这些东西也走 user 帧:
 *
 * - **工具结果**(`tool_result` 块)—— 正常且必要,单独成 `tool_result` 消息;
 * - **子代理(Task/Agent)的对话** —— 子代理自己的 prompt 与回复,带
 *   `parent_tool_use_id`(实时流)或 `isSidechain: true`(写进 transcript 时);
 * - **CLI/SDK 的机器耳语** —— 空响应重试、坏工具调用重试、压缩续接、
 *   `<system-reminder>`、Skill 说明书注入、本地命令占位……
 *
 * ## 优先按结构判,内容前缀只当兜底
 *
 * 前缀清单是**内容级**的,改一个字就失效;而 `sourceToolUseID` / `turnCompanion` /
 * `isMeta` 这些是**结构级**的,CLI 造这条行的时候就带上了。所以同一类注入
 * (比如技能正文)尽量在结构上判掉,前缀留着只是多一道保险 —— 实时 SDK 流上
 * 没有这些 transcript 字段,那时前缀就是唯一防线。
 *
 * 界面上出现过的就是第二类:子代理被派活时的那句 prompt
 * (「Reply with exactly the text AGENT_OK…」)被当成用户发言渲染成了气泡。
 *
 * ## 判定原则:反证,不是求证
 *
 * 只在**拿到"这不是人发的"确凿证据**时才拦。
 * 反过来做(只放行 `origin.kind === 'human'`)会把老版本 CLI 写的历史整段吃掉 ——
 * `origin` 是后加的字段,老 transcript 里真正的用户消息同样没有它。
 * 宁可漏拦一条陌生的新式注入,也不能把用户自己说过的话吞掉。
 */

/** 整条消息以这些开头就是注入,不是用户发言。 */
export const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '<local-command-caveat>',
  'Invalid API key',
  '[Request interrupted',
  // Skill 被调用时,CLI 把整份 SKILL.md 连同"Base directory for this skill: …"
  // 前缀注入成一条 user 消息喂给模型 —— 那是给模型看的说明书,不是用户发言。
  'Base directory for this skill:',
  // SDK 的自动重试提示:模型给了空响应 / 吐了解析不了的工具调用时,CLI 会以
  // user 身份注入这两句催它重来。是机器对机器的耳语,不是用户发言。
  '[Your previous response had no visible output',
  'Your tool call was malformed',
  // 压缩续接(耗尽上下文后 CLI 注入的"本会话接续自…"+全文摘要)与跨机续接。
  'This session is being continued',
  // 本地命令执行后 CLI 注入的"不用回应"占位。
  'No response requested.',
  // 工具调用被打断/移除时的占位说明。
  '[Tool use interrupted]',
  '[Tool use removed]',
] as const;

/**
 * 成对出现、可以整块摘掉的注入标记。
 *
 * 这些块**不一定在开头** —— CLI 经常把提醒追加在用户原话后面。只做
 * `startsWith` 的话,一条"用户原话 + 一大段 system-reminder"会原样渲染出来,
 * 提醒那段就明晃晃地混在用户气泡里。
 */
const INJECTED_BLOCK_TAGS = ['system-reminder', 'local-command-caveat'] as const;

const INJECTED_BLOCK_PATTERNS = INJECTED_BLOCK_TAGS.map(
  (tag) => new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'),
);

/**
 * 摘掉可整块识别的注入片段,返回真正属于用户的部分。
 *
 * 只摘成对闭合的块;没闭合的残片留着交给 `isInternalContent` 的前缀清单判断,
 * 避免正则在畸形输入上吃掉过多内容。
 */
export function stripInjectedBlocks(content: string): string {
  let result = content;
  for (const pattern of INJECTED_BLOCK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '');
  }
  return result.trim();
}

/** 摘掉注入块之后什么都不剩(或本来就以注入前缀开头)= 这条整条都是注入。 */
export function isInternalContent(content: string): boolean {
  const stripped = stripInjectedBlocks(content);
  if (!stripped) {
    return true;
  }
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => stripped.startsWith(prefix));
}

/** `nonHumanUserTurnReason` 的返回值,只用于日志与测试断言。 */
export type NonHumanReason =
  | 'meta'
  | 'sidechain'
  | 'synthetic'
  | 'transcript-only'
  | 'tool-authored'
  | 'turn-companion'
  | 'subagent-frame'
  | 'subagent-type'
  | 'agent-user-type'
  | `origin:${string}`;

function readOriginKind(origin: unknown): string | null {
  if (typeof origin === 'string') {
    return origin;
  }
  if (origin && typeof origin === 'object') {
    const kind = (origin as AnyRecord).kind;
    return typeof kind === 'string' ? kind : null;
  }
  return null;
}

/**
 * 这条 user 记录不是人发的时,返回原因;是人发的(或无从判断)时返回 `null`。
 *
 * 注意:返回非 null **不代表整条记录要丢掉** —— 里面的 `tool_result` 块该抽还得抽,
 * 子代理的工具调用照样要在时间轴上显示。这个判断只用来决定
 * 「要不要把里面的 text 渲染成一个用户气泡」。
 */
export function nonHumanUserTurnReason(raw: AnyRecord): NonHumanReason | null {
  // CLI 自己标记的"这条是元信息,不是对话"(图片尺寸说明、环境提示等)。
  if (raw.isMeta === true) {
    return 'meta';
  }
  // 子代理的整段对话被写进了主 transcript。
  if (raw.isSidechain === true) {
    return 'sidechain';
  }
  // SDK 自造的续写帧。
  if (raw.isSynthetic === true) {
    return 'synthetic';
  }
  // 只为了让 transcript 完整而写入、并不参与对话的行。
  if (raw.isVisibleInTranscriptOnly === true) {
    return 'transcript-only';
  }
  /**
   * **这一条 user 行是某次工具调用造出来的。**
   *
   * 技能注入就是活例子:调 `Skill` 之后,CLI 会紧接着写一条 user 行,内容是
   * 「Base directory for this skill: …」+ 整份 SKILL.md —— 那是喂给模型的说明书,
   * 不是用户发言。实测那一行同时带 `isMeta` / `sourceToolUseID` / `turnCompanion`,
   * 三重可判。
   *
   * 注意别和 `sourceToolAssistantUUID` 搞混:普通的 tool_result 行带的是**后者**
   * (本次会话 362 行都是),这里判的是**前者**,只此一行,不会误伤工具结果。
   */
  if (typeof raw.sourceToolUseID === 'string' && raw.sourceToolUseID.length > 0) {
    return 'tool-authored';
  }
  // 附在某个回合上的伴随行(图片尺寸说明、技能正文……),本身不是一个回合。
  if (raw.turnCompanion === true) {
    return 'turn-companion';
  }
  // 实时流里子代理的帧:挂在某个 tool_use 之下。
  // 主线程的用户回合这个字段恒为 null,所以这条判据在实时路径上最可靠。
  const parentToolUseId = raw.parent_tool_use_id ?? raw.parentToolUseId;
  if (typeof parentToolUseId === 'string' && parentToolUseId.length > 0) {
    return 'subagent-frame';
  }
  if (typeof raw.subagent_type === 'string' && raw.subagent_type.length > 0) {
    return 'subagent-type';
  }
  if (raw.userType === 'agent') {
    return 'agent-user-type';
  }
  // `origin` 一旦出现就是权威的:SDK 明说 "absent or `human` means keyboard input"。
  // 所以只在它**存在且不是 human** 时才拦 —— 缺失一律按人发的处理。
  const originKind = readOriginKind(raw.origin);
  if (originKind !== null && originKind !== 'human') {
    return `origin:${originKind}`;
  }
  return null;
}
