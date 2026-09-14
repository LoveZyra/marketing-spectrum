import type { MessageKind } from './types.js';

/**
 * 分叉锚点 —— 「从这条消息往回,能落在哪个原生 assistant uuid 上」。
 *
 * ## 为什么需要它
 *
 * 「编辑重跑」要把 SDK 的 `resumeSessionAt` 指到一个**原生 assistant uuid**
 * (SDK 文档原话:*The message ID should be from `SDKAssistantMessage.uuid`*)。
 * 而前端手里只有一条**用户气泡**的 app 消息 id,那条 id 有三种形状:
 *
 * | 形状 | 来源 | 能不能反推 uuid |
 * |---|---|---|
 * | `<uuid>` / `<uuid>_text` / `<uuid>_tr_<id>` | transcript 规范化 | ✅ 前缀就是 uuid |
 * | `user_<随机 uuid>` | 网关写用户气泡(`generateMessageId('user')`) | ❌ 前缀是字面量 `user` |
 * | `local_<时间戳>_<随机>` | 前端乐观回声,还没被服务端那份替换 | ❌ |
 *
 * 后两种占了**实时对话里绝大多数**的用户气泡 —— fp 之前它们会静默退化成
 * "从头重跑整段历史",fp 改成明确 409,但仍然**做不成**。
 *
 * 根子在于:**用户说的那句话从来没有对应的出站 SDK 帧**,所以写用户气泡那一刻
 * 手里根本没有 uuid(CLI 事后自己往 jsonl 里写)。既然拿不到"这一条"的 uuid,
 * 就换个问法 —— 端点真正要的本来就是"**这条之前最后一个 assistant uuid**"。
 * 那个 uuid 在 assistant 帧到达时是**现成的**。
 *
 * 于是做法是:每条 assistant 侧的显示日志行,落库时顺手记下它自己的原生 uuid;
 * 端点按显示日志的顺序往回找第一条非空的即可,不再解析目标消息的 id 形状,
 * 也不用扫 jsonl。
 */

/** uuid 里不含下划线,所以第一个下划线之前那段就是它(如果它确实是 uuid)。 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 从 app 消息 id 里反推原生 uuid;反推不出来返回 null。
 *
 * **一处定义**:落库(算锚点)与端点(老会话的兜底路径)共用这一个。
 */
export function nativeUuidFromMessageId(messageId: unknown): string | null {
  const head = typeof messageId === 'string' ? messageId.split('_')[0] : '';
  return UUID_SHAPE.test(head) ? head : null;
}

/**
 * 这条显示日志行在原生 transcript 里是不是一条 **assistant 记录**。
 *
 * 判据要和 jsonl 里的 `type === 'assistant'` 对齐,而不是和"看起来像模型说的"
 * 对齐 —— 尤其 `tool_result`:它在界面上挂在工具行下面,但在 jsonl 里是一条
 * **user** 记录,拿它的 uuid 去 `resumeSessionAt` 会被 SDK 拒掉。
 */
export function isAssistantSideRow(message: { kind?: unknown; role?: unknown }): boolean {
  const kind = message?.kind as MessageKind | undefined;
  if (kind === 'thinking' || kind === 'tool_use') return true;
  return kind === 'text' && message?.role === 'assistant';
}

/**
 * 这一行自己的分叉锚点:是 assistant 侧且 id 里带得出原生 uuid 才有,否则 null。
 *
 * 只给 assistant 侧的行落值,是为了让列的含义**唯一**:非空 = 可以拿去
 * `resumeSessionAt`。若把 user 侧的 uuid 也塞进来,查询就得再带一个"是不是
 * assistant"的条件,而那正是"同一个判据分两处写"的开头。
 */
export function forkAnchorUuid(message: { id?: unknown; kind?: unknown; role?: unknown }): string | null {
  if (!isAssistantSideRow(message)) return null;
  return nativeUuidFromMessageId(message?.id);
}
