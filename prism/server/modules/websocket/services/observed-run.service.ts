/**
 * 接住 CLI 自己发起的那一轮。
 *
 * 后台子代理完成、会话内定时任务(模型自己用 CronCreate 建的)触发时,消息由 Claude Code
 * 自己的队列投递:transcript 里是 `queue-operation enqueue → dequeue → user 帧`,投递时机在
 * 回合边界,整条链路不经过 Prism 的任何入口。而常驻读循环按 `runtime.turn` 路由,
 * `runtime.turn` 只在 `runPersistentTurn` 里赋值(只有 Prism 自己发起的回合才有)。
 * 不接住的话,CLI 自发的那一整轮既不广播(正看着的人看不到),也不落显示日志
 * (`ChatSessionWriter.forward` 是唯一收口;seed 只在日志为空时抄一次,不会补抄),刷新也看不到。
 *
 * 不变式:runtime 上的每一轮都要有一个承接者。Prism 发起的 → `runtime.turn`;
 * CLI 自己发起的 → 这里的观测回合。
 *
 * 三条刻意的取舍:
 * 1. 不碰 `runtime.turn`。`runPersistentTurn` 第一行是 `if (runtime.turn) throw`,
 *    观测回合要是占了它,那一轮的 `result` 只要不来(CLI 侧异常、注入轮被吃掉),
 *    这条会话就永久忙。
 * 2. 不阻塞用户发送(见 `chatRunRegistry.startRun` 的抢占分支):CLI 自发回合期间
 *    `runtime.turn` 本来就是 null,观测回合让路即可。
 * 3. 白名单转发。只转 `text / thinking / tool_use / tool_result`、流式增量与任务行,
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
  // SDK 的任务生命周期行(见 claude-sdk 的 taskLifecycleMessage),本身就说明了"这一轮为什么会发生"。
  'task_notification',
  // 后台任务进展:直播可见、不落库(不在 DURABLE_KINDS 里),归到任务卡片。
  'task_progress',
]);

/**
 * `merged` = 这一轮回答的是用户合流进去的消息(按 `user_message_uuid` 判,见 claude-sdk 的
 * frameAnswersMerged)。trigger 只进日志。
 */
export type ObservedTrigger = 'task-notification' | 'merged' | 'unknown';

type ObservedEntry = {
  appSessionId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  absoluteTimer: ReturnType<typeof setTimeout> | null;
  /** 最近一批帧到达时,CLI 那边还有没有工具在跑(含子代理的)。到点时只续不杀。 */
  toolsInFlight: boolean;
  /** 因"工具在途"续过几次硬顶 —— 有上限,免得真僵死的回合永远收不掉。 */
  maxExtensions: number;
};

const entries = new Map<string, ObservedEntry>();

/** 开过的观测回合数(可观测性;与 claude-sdk 那一侧的无主帧计数配对看)。 */
let observedTurnsOpened = 0;

function clearTimers(entry: ObservedEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (entry.absoluteTimer) clearTimeout(entry.absoluteTimer);
  entry.idleTimer = null;
  entry.absoluteTimer = null;
}

/** 硬顶最多因"工具在途"续这么多次(15 分钟 × 8 = 2 小时,与定时任务的单次上限同量级)。 */
const OBSERVED_MAX_EXTENSIONS = 8;

/**
 * 收尾。
 *
 * `reason` 只进日志 —— 三种收尾方式(result / 静默超时 / 硬顶)在生产上要分得清:
 * 后两种反复出现就说明 CLI 那侧的回合边界与我们的判据对不上。
 */
function finish(appSessionId: string, reason: 'result' | 'idle' | 'max'): void {
  const entry = entries.get(appSessionId);
  if (!entry) return;
  /**
   * 工具还在跑就不收。
   *
   * 静默看门狗的 60 秒是按"模型在想"设计的;一条跑 90 秒的后台命令期间没有任何帧,
   * 到点收掉就会被判成失败(exitCode:1,转圈消失),下一帧又开一个新回合,界面一闪一闪。
   * 调用方每一批帧都带着"CLI 还有没有工具在途",到点只续不杀。
   */
  if (reason !== 'result' && entry.toolsInFlight) {
    if (reason === 'idle') {
      armTimers(entry);
      return;
    }
    if (entry.maxExtensions < OBSERVED_MAX_EXTENSIONS) {
      entry.maxExtensions += 1;
      entry.absoluteTimer = setTimeout(() => finish(entry.appSessionId, 'max'), OBSERVED_MAX_MS);
      entry.absoluteTimer.unref?.();
      return;
    }
  }
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
 * 返回 true 表示这一批真的被接住了(交给了观测回合或正在跑的真回合),供调用方记账。
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
  /** CLI 那边此刻还有没有工具在跑(含子代理)。看门狗到点时只续不杀。 */
  toolsInFlight?: boolean;
}): boolean {
  const { appSessionId } = input;
  if (!appSessionId) return false;

  const forwardable = input.messages.filter((message) => OBSERVABLE_KINDS.has(String(message.kind)));
  let entry = entries.get(appSessionId);

  /**
   * 回合被换掉了,这一批也不能扔。
   *
   * 观测回合被用户的真回合抢占、或被「停止」标成完成之后,紧接着到达的那一批帧要是既不广播
   * 也不落库,就再也不会出现在界面上(显示日志一旦有行就是权威来源)。分三种情况:
   *   - 用户的真回合正在跑(抢占窗口):交给它的 writer,界面与日志都是同一条会话;
   *   - 只是一个空 result(比如刚被中止):什么都不用显示,清账即可;
   *   - 其余:当作新的一轮重新接住(走下面 `!entry` 那条路)。
   */
  if (entry) {
    const current = chatRunRegistry.getRun(appSessionId);
    if (!current || !current.observed || current.status !== 'running') {
      entries.delete(appSessionId);
      clearTimers(entry);
      entry = undefined;
      if (current && !current.observed && current.status === 'running') {
        for (const message of forwardable) current.writer.send(message);
        return forwardable.length > 0;
      }
      if (forwardable.length === 0) return false;
    }
  }

  if (!entry) {
    // 没有内容就不开回合 —— 只有 result 到达(空转)时不该凭空冒出一段。
    if (forwardable.length === 0) return false;
    /**
     * 会话行没了(被删 / 被并)就别接:`startRun` 之后的每一步(落库、可见性)
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
    // 被别的回合占着(用户的真回合正在跑)—— 交给它的 writer,不能丢(见上)。
    if (!run) {
      const busy = chatRunRegistry.getRun(appSessionId);
      if (busy && !busy.observed && busy.status === 'running') {
        for (const message of forwardable) busy.writer.send(message);
        return true;
      }
      return false;
    }
    entry = { appSessionId, idleTimer: null, absoluteTimer: null, toolsInFlight: false, maxExtensions: 0 };
    entries.set(appSessionId, entry);
    observedTurnsOpened += 1;
    log.info(`[observed] 接住 ${appSessionId} 的一轮无主回合(trigger=${input.trigger})`);
    /**
     * 不给观测回合盖来源标记(如一句「这一轮由 Claude Code 自己发起」):那会在本该连贯的
     * 时间轴里插一句旁白。后台任务的完成与失败已经归到它自己那一行上
     * (见 useChatMessages 的 backgroundByToolId),比笼统的旁白准确。
     * 合流消息的那一轮由调用方按 uuid 标成 `trigger: 'merged'`,只进日志。
     */
  }

  const run = chatRunRegistry.getRun(appSessionId);
  if (!run || !run.observed || run.status !== 'running') {
    // 刚开的回合当场就没了(极端竞态)—— 收摊,下一批再来。
    entries.delete(appSessionId);
    clearTimers(entry);
    return false;
  }

  for (const message of forwardable) run.writer.send(message);
  entry.toolsInFlight = Boolean(input.toolsInFlight);
  armTimers(entry);

  if (input.turnEnded) finish(appSessionId, 'result');
  return true;
}

/**
 * 会话被删 / 运行时被丢弃时清账。
 *
 * runtime 被丢弃时由 claude-sdk 经 runtimeDisposedHook 调用(换窗口的重建也会走到这里)。
 * runtime 没了,它开着的观测回合不会再有帧,要就地收掉:否则要等静默看门狗,
 * 而"工具在途"时它只续不杀,最长能挂 2 小时,界面一直转圈。
 */
export function forgetObservedRun(appSessionId: string): void {
  const entry = entries.get(appSessionId);
  if (!entry) return;
  entries.delete(appSessionId);
  clearTimers(entry);
  const run = chatRunRegistry.getRun(appSessionId);
  if (run?.observed && run.status === 'running') {
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    log.info(`[observed] ${appSessionId} 的 runtime 被丢弃,观测回合就地收尾`);
  }
}

/** 观测统计 —— 与"无主帧丢弃计数"配对看:接住的多了,丢弃的就该少。 */
export function observedRunStats(): { open: number; opened: number } {
  return { open: entries.size, opened: observedTurnsOpened };
}

/** 测试用。 */
export function resetObservedRunsForTest(): void {
  for (const entry of entries.values()) clearTimers(entry);
  entries.clear();
  observedTurnsOpened = 0;
}
