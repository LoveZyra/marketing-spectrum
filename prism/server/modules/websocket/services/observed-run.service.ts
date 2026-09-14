/**
 * gb:**接住 CLI 自己发起的那一轮。**
 *
 * ## 病根(线上实证)
 *
 * 后台子代理完成、会话内定时任务(模型自己用 CronCreate 建的)触发时,
 * 消息是 **Claude Code 自己的队列**投递的:transcript 里是
 * `queue-operation enqueue → dequeue → user 帧`,投递时机在**回合边界**
 * (实测上一轮 result 之后 105ms)。整条链路不经过 Prism 的任何入口。
 *
 * 而 Prism 的常驻读循环是按 `runtime.turn` 路由的:没有 turn 就
 * `continue // stray events between turns`。`runtime.turn` 只在
 * `runPersistentTurn` 里赋值,也就是**只有 Prism 自己发起的回合才有**。于是
 * CLI 自发的那一整轮:
 *
 * - 不广播 → 正看着这条会话的人**当场看不到**;
 * - 不落显示日志(`ChatSessionWriter.forward` 是唯一收口)→ **刷新也看不到**,
 *   而且 seed 只在日志为空时抄一次,**永不补抄**。
 *
 * 内容其实都在磁盘的 transcript 里 —— 丢的是"Prism 这一侧对这一类回合的可见性"。
 * 用户观感:让模型开几个后台子 agent,界面永远停在「✅ 已启动」,而模型在
 * 下一句话里说"刚才两个都跑完了"。
 *
 * ## 不变式
 *
 * **runtime 上的每一轮都要有一个承接者。** Prism 发起的 → `runtime.turn`;
 * CLI 自己发起的 → 这里的观测回合。
 *
 * ## 三条刻意的取舍
 *
 * 1. **不碰 `runtime.turn`。** `runPersistentTurn` 第一行是
 *    `if (runtime.turn) throw`,观测回合要是占了它,那一轮的 `result` 只要不来
 *    (CLI 侧异常、注入轮被吃掉),这条会话就**永久忙** —— 比原 bug 更严重。
 * 2. **不阻塞用户发送**(见 `chatRunRegistry.startRun` 的抢占分支)。
 *    今天本来就不挡(CLI 自发回合期间 `runtime.turn` 是 null),让路 = 与现状一致。
 * 3. **白名单转发**。只转 `text / thinking / tool_use / tool_result` 与流式增量,
 *    其余(system init、压缩边界、token 预算……)一律不转 —— 与显示日志那张
 *    durable 白名单同一条道理:漏加只会少显示一样东西,默认放行则可能把
 *    压缩过程之类的东西泼到聊天里。
 */

import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { createLogger } from '@/shared/logger.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

const log = createLogger('observed-run');

/** 多久没有新帧就认为这一轮不会再有了(CLI 侧异常、注入轮被吃掉)。 */
export const OBSERVED_IDLE_MS = 60_000;
/** 绝对上限:再长也收尾,不留永远转着的幽灵回合。 */
export const OBSERVED_MAX_MS = 15 * 60_000;

/**
 * 转发白名单。
 *
 * 与 `DURABLE_KINDS` 是两张表、两件事:那张管"落不落库",这张管"这一轮里
 * 哪些帧值得接住"。流式增量在这里放行、在那张表里不放行,正好 ——
 * 直播看得见,而每 token 一条的洪流不会进库。
 */
const OBSERVABLE_KINDS: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'stream_delta',
  'stream_end',
  // SDK 的任务生命周期行(见 claude-sdk 的 taskLifecycleMessage)。
  // 它本身就是"这一轮为什么会发生"的说明,所以带着它的那一批不再另加来源标记。
  'task_notification',
  // gd:后台任务进展。直播可见、**不落库**(不在 DURABLE_KINDS 里),归卡片。
  'task_progress',
]);

export type ObservedTrigger = 'task-notification' | 'unknown';

type ObservedEntry = {
  appSessionId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  absoluteTimer: ReturnType<typeof setTimeout> | null;
};

const entries = new Map<string, ObservedEntry>();

/**
 * gc:**刚刚合流进 CLI 的那条用户消息。**
 *
 * 合流之后模型的回复有两种落法:被 CLI 当场并进这一轮(那就走 `runtime.turn`,
 * 与这里无关),或者等到回合边界才投递 —— 后者对 Prism 来说就是一轮**无主帧**,
 * 会被观测回合接住。可它并不是"CLI 自己发起的",是**用户发起的**:
 * 再盖一枚「📬 这一轮由 Claude Code 自己发起」的标记就是睁眼说瞎话
 * (用户的气泡就在上面几行)。
 *
 * 所以合流时记一笔,观测回合开的时候查一下:是用户的就不盖标记。
 *
 * 带过期时间:当场并进这一轮时根本不会有无主帧,这一笔没人来消费,
 * 挂着不清就会让**下一次**真的后台通知丢掉标记。过期只影响一枚标记,
 * 不影响内容,所以取值宽松一点没关系。
 */
const MERGED_SEND_TTL_MS = 10 * 60_000;
const mergedSends = new Map<string, number>();

export function noteMergedSend(appSessionId: string): void {
  if (!appSessionId) return;
  mergedSends.set(appSessionId, Date.now());
}

/** 取走(并清掉)"这一轮其实是用户合流进来的"这一笔。 */
function takeMergedSend(appSessionId: string): boolean {
  const at = mergedSends.get(appSessionId);
  if (at === undefined) return false;
  mergedSends.delete(appSessionId);
  return Date.now() - at <= MERGED_SEND_TTL_MS;
}

/** 观测回合的丢弃计数(可观测性,见 noteOrphanFrame 那一侧)。 */
let observedTurnsOpened = 0;

function clearTimers(entry: ObservedEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (entry.absoluteTimer) clearTimeout(entry.absoluteTimer);
  entry.idleTimer = null;
  entry.absoluteTimer = null;
}

/**
 * 收尾。
 *
 * `reason` 只进日志 —— 三种收尾方式(result / 静默超时 / 硬顶)在生产上要分得清:
 * 后两种反复出现就说明 CLI 那侧的回合边界与我们的判据对不上。
 */
function finish(appSessionId: string, reason: 'result' | 'idle' | 'max'): void {
  const entry = entries.get(appSessionId);
  if (!entry) return;
  entries.delete(appSessionId);
  clearTimers(entry);
  const run = chatRunRegistry.getRun(appSessionId);
  // 只收自己开的那一个:期间可能已经被用户的真回合抢占并换掉了。
  if (run?.observed && run.status === 'running') {
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: reason === 'result' ? 0 : 1 });
  }
  if (reason !== 'result') {
    log.warn(`[observed] ${appSessionId} 的观测回合按 ${reason} 收尾 —— CLI 没有给出 result`);
  }
}

function armTimers(entry: ObservedEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => finish(entry.appSessionId, 'idle'), OBSERVED_IDLE_MS);
  entry.idleTimer.unref?.();
  if (!entry.absoluteTimer) {
    entry.absoluteTimer = setTimeout(() => finish(entry.appSessionId, 'max'), OBSERVED_MAX_MS);
    entry.absoluteTimer.unref?.();
  }
}


/**
 * 一批无主帧到了。
 *
 * 调用方(claude-sdk 的读循环)已经把原始消息归一化过了 —— 那一层认识 SDK 的
 * 消息形状,这一层只认 `NormalizedMessage`,模块边界不反过来。
 *
 * 返回 true 表示这一批**真的被接住了**(至少开了观测回合),供上游记账。
 */
export function observeOrphanFrames(input: {
  appSessionId: string;
  providerSessionId: string | null;
  userId: string | number | null;
  provider: LLMProvider;
  messages: NormalizedMessage[];
  trigger: ObservedTrigger;
  /** 这一批里有 `result` —— 这一轮到此为止。 */
  turnEnded: boolean;
}): boolean {
  const { appSessionId } = input;
  if (!appSessionId) return false;

  const forwardable = input.messages.filter((message) => OBSERVABLE_KINDS.has(String(message.kind)));
  let entry = entries.get(appSessionId);

  if (!entry) {
    // 没有内容就不开回合 —— 只有 result 到达(空转)时不该凭空冒出一段。
    if (forwardable.length === 0) return false;
    /**
     * 会话行没了(被删/被并)就别接:`startRun` 之后的每一步(落库、可见性)
     * 都以那一行为准,接住只会写进一个没有归属的会话。
     */
    if (!sessionsDb.getSessionById(appSessionId)) return false;
    const run = chatRunRegistry.startRun({
      appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      connection: null,
      userId: input.userId,
      observed: true,
    });
    // 被别的回合占着(用户的真回合正在跑)—— 那一轮自己会显示,不用我们插手。
    if (!run) return false;
    entry = { appSessionId, idleTimer: null, absoluteTimer: null };
    entries.set(appSessionId, entry);
    observedTurnsOpened += 1;
    log.info(`[observed] 接住 ${appSessionId} 的一轮无主回合(trigger=${input.trigger})`);
    /**
     * ge:**不再盖任何来源标记。**
     *
     * gb 给观测回合开头落了一枚 `task_notification` 说「这一轮由 Claude Code
     * 自己发起」。实机看下来那是**在一条本该连贯的时间轴里插了一句旁白** ——
     * 要的是"一根轴串下来",而不是每隔几行冒出一句解释这一轮从哪儿来的话。
     *
     * 信息没有丢:后台任务的完成与失败已经归到**它自己那一行**上了
     * (见 useChatMessages 的 backgroundByToolId),那比一句笼统的旁白准得多。
     *
     * `takeMergedSend` 仍然要调 —— 它是一次性的记账,不取走会挂到下一轮头上。
     */
    takeMergedSend(appSessionId);
  }

  const run = chatRunRegistry.getRun(appSessionId);
  if (!run || !run.observed || run.status !== 'running') {
    // 期间被抢占换掉了 —— 这一批不再属于我们,收摊。
    entries.delete(appSessionId);
    clearTimers(entry);
    return false;
  }

  for (const message of forwardable) run.writer.send(message);
  armTimers(entry);

  if (input.turnEnded) finish(appSessionId, 'result');
  return true;
}

/** 会话被删/运行时被丢弃时清账。 */
export function forgetObservedRun(appSessionId: string): void {
  const entry = entries.get(appSessionId);
  if (!entry) return;
  entries.delete(appSessionId);
  clearTimers(entry);
}

/** 观测统计 —— 与"无主帧丢弃计数"配对看:接住的多了,丢弃的就该少。 */
export function observedRunStats(): { open: number; opened: number } {
  return { open: entries.size, opened: observedTurnsOpened };
}

/** 测试用。 */
export function resetObservedRunsForTest(): void {
  for (const entry of entries.values()) clearTimers(entry);
  entries.clear();
  mergedSends.clear();
  observedTurnsOpened = 0;
}
