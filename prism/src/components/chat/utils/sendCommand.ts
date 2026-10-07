/**
 * 一次发送是一个在提交那一刻冻结的命令。
 *
 * ## 为什么需要它
 *
 * 发送要用到的东西 —— 分叉点、隐藏上下文、排队正文、附图、输入框正文、按输入框算出的
 * options —— 在发送过程中全都可能变:上传图片、建会话都是网络等待,用户在等待期间照样
 * 打字、切会话、再点一次发送。没有一个"这一次发送"的对象,每个环节都只能去现场再读一次,
 * 于是会出现:
 *
 * - 回合结束后自动续发时,用户此刻正在打的下一句被一起发出去,options 也是按当前输入框
 *   重建的,不是排队时那一份;
 * - "发出去了"只代表本地 `socket.send` 没抛异常。网络抖动重发就是真的发两遍,
 *   服务端没有幂等键可以去重;
 * - 分叉点与隐藏上下文不按会话隔离,在确认发出去之前就被消费掉;
 * - 排队的图片是 `File[]`,进不了 localStorage,刷新后恢复成没有图,
 *   后台自动发送就不带图地把消息发了出去,用户毫不知情。
 *
 * ## 这个模块的边界
 *
 * 纯数据 + 纯函数,不碰 React、不碰 DOM、不碰网络。冻结在 `freezeSendCommand`,
 * 状态流转在 `reduceOutbox`,持久化的形状转换在 `toStoredCommand` /
 * `fromStoredCommand`。副作用留在 hook 里。
 */

import type { QueuedSendOptions, StoredQueuedMessage } from './chatStorage';
import { composerText } from './composerText';

export interface SendCommandFork {
  providerSessionId: string;
  resumeSessionAt: string | null;
}

/**
 * 已上传图片的引用。
 *
 * 是描述符,不是 `File`:`File` 进不了 localStorage,而这个形状是纯 JSON,
 * 刷新之后原样读回来还能用。服务端(`server/shared/image-attachments.ts`)
 * 接受的也正是这个形状。
 */
export interface SendCommandImage {
  path: string;
  name?: string;
  mimeType?: string;
}

/**
 * 提交那一刻冻结下来的一次发送。创建之后不再改。
 *
 * 唯一允许后补的字段是 `sessionId`:新会话是在发送过程中由服务端分配的,
 * 补上用 `withSessionId`(返回新对象,不原地改)。
 */
export interface SendCommand {
  /**
   * 幂等键。服务端按它去重 —— 同一个 id 的第二次投递不产生第二条消息。
   *
   * 它必须跟着命令一起持久化:刷新之后恢复出来的那条如果换了新 id,
   * 幂等就白做了(服务端看到的是两条不同的命令)。
   */
  clientMessageId: string;
  /** 归属会话(草稿键口径:新会话页是项目键)。落地判据一律用它,不看当前视图。 */
  sessionKey: string | null;
  /** 目标会话 id。新会话在提交时还没有,由 `withSessionId` 补。 */
  sessionId: string | null;
  projectId: string | null;
  /** 真正发出去的正文(已含附件块)。 */
  text: string;
  /**
   * 只用于会话命名的那一份正文(不含附件块)。
   *
   * 传含附件的那份会把会话名落成「总结一下 <attached-document name=…>」这种带标签尾巴的东西,
   * 还与前端乐观显示的名字不一致。
   */
  namingText: string;
  /** 已上传图片的引用 —— 不是 File,所以能持久化、能跨刷新恢复。 */
  images: SendCommandImage[];
  /** 冻结的发送选项(模型、权限档位、effort……)。 */
  options: QueuedSendOptions;
  /** 冻结的分叉点。发送失败不消费(见 `reduceOutbox`)。 */
  forkFrom: SendCommandFork | null;
  /** 冻结的隐藏上下文。只搭这一班车。 */
  hiddenContext: string | null;
  createdAt: number;
}

export type OutboxStatus =
  /** 已提交、等着发(回合在跑 / 断网 / 等着被别的标签页认领)。 */
  | 'queued'
  /** 正在发(上传、建会话、socket.send 这一段)。 */
  | 'sending'
  /** 服务端确认收到(按 clientMessageId)。到这一步才允许清草稿。 */
  | 'acked'
  /** 发送失败,可重试。 */
  | 'failed'
  /**
   * 附件恢复不回来 —— 暂停发送,等用户重新添加。
   *
   * 比"照旧发一条没有图的消息"诚实:那条消息发出去就收不回了,而模型看到的
   * 是一段引用了不存在图片的话。
   */
  | 'needs_attachment';

export interface OutboxEntry {
  command: SendCommand;
  status: OutboxStatus;
  /** 失败原因,给界面显示用。 */
  error: string | null;
  /** 已经投递过几次(重试计数;幂等键保证服务端只收一条)。 */
  attempts: number;
}

export type OutboxEvent =
  | { type: 'enqueue'; command: SendCommand }
  | { type: 'sending' }
  | { type: 'acked' }
  | { type: 'failed'; error: string }
  | { type: 'needs_attachment'; error: string }
  | { type: 'retry' }
  | { type: 'discard' };

const CLIENT_MESSAGE_ID_PREFIX = 'cmd_';

/** 幂等键。时间戳只为可读性,唯一性靠随机段。 */
export function newClientMessageId(
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  return `${CLIENT_MESSAGE_ID_PREFIX}${now.toString(36)}_${random().toString(36).slice(2, 10)}`;
}

export function isClientMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(CLIENT_MESSAGE_ID_PREFIX) && value.length > CLIENT_MESSAGE_ID_PREFIX.length;
}

export interface FreezeSendCommandInput {
  sessionKey: string | null;
  sessionId: string | null;
  projectId: string | null;
  text: string;
  namingText?: string;
  images?: SendCommandImage[];
  options: QueuedSendOptions;
  forkFrom?: SendCommandFork | null;
  hiddenContext?: string | null;
  clientMessageId?: string;
  now?: number;
}

/**
 * 把"这一次发送"冻结成一个对象。
 *
 * 之后无论经过多少次 await、用户在输入框里打了什么、切到了哪条会话,
 * 发出去的都是这里冻结的这一份。
 */
export function freezeSendCommand(input: FreezeSendCommandInput): SendCommand {
  const now = input.now ?? Date.now();
  return Object.freeze({
    clientMessageId: input.clientMessageId ?? newClientMessageId(now),
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    projectId: input.projectId,
    text: input.text,
    namingText: input.namingText ?? input.text,
    images: Object.freeze([...(input.images ?? [])]) as SendCommandImage[],
    options: input.options,
    forkFrom: input.forkFrom ?? null,
    hiddenContext: input.hiddenContext ?? null,
    createdAt: now,
  });
}

/** 补上服务端分配的会话 id。返回新对象 —— 命令本身不可变。 */
export function withSessionId(command: SendCommand, sessionId: string): SendCommand {
  if (command.sessionId === sessionId) return command;
  return Object.freeze({ ...command, sessionId });
}

/**
 * outbox 的状态流转。
 *
 * 收成一个 reducer,让"什么时候能清草稿""失败要不要保留分叉点"这类判断只有一份。
 */
export function reduceOutbox(entry: OutboxEntry | null, event: OutboxEvent): OutboxEntry | null {
  switch (event.type) {
    case 'enqueue':
      return { command: event.command, status: 'queued', error: null, attempts: 0 };

    case 'discard':
      return null;

    default:
      break;
  }

  if (!entry) return null;

  switch (event.type) {
    case 'sending':
      // 已确认的不再重发 —— 幂等键在服务端也拦得住,但客户端不该主动去撞。
      if (entry.status === 'acked') return entry;
      return { ...entry, status: 'sending', error: null, attempts: entry.attempts + 1 };

    case 'acked':
      return { ...entry, status: 'acked', error: null };

    case 'failed':
      return { ...entry, status: 'failed', error: event.error };

    case 'needs_attachment':
      return { ...entry, status: 'needs_attachment', error: event.error };

    case 'retry':
      // 附件缺失时"重试"没有意义 —— 要先补附件,由界面引导用户重新添加。
      if (entry.status === 'needs_attachment') return entry;
      if (entry.status === 'acked') return entry;
      return { ...entry, status: 'queued', error: null };

    default:
      return entry;
  }
}

/** 这条命令现在该不该被投递。 */
export function isSendable(entry: OutboxEntry | null): entry is OutboxEntry {
  return Boolean(entry) && entry!.status === 'queued';
}

/**
 * 这条命令还"在等着发"吗:排队卡该不该显示、要不要落盘,都看它。
 *
 * `markCommandSent` 之后条目停在 `sending` 等 ACK,此时消息已经发出去了,排队卡不能再挂着
 * 「已排队 · 本轮结束后自动发送」(ACK 没到时会永远挂着),盘上也不该再有它。
 * 渲染与落盘两处必须共用这一个判据,否则会出现"内存里还留着、盘上已经没有"
 * (刷新后卡片消失)这种不一致。
 *
 * `needs_attachment` 也算在内:它确实还没发出去,只是在等用户补图,卡片必须留着。
 */
export function isPendingSend(entry: OutboxEntry | null | undefined): boolean {
  return entry?.status === 'queued' || entry?.status === 'needs_attachment';
}

/**
 * 草稿什么时候能清 —— 收到 ACK 之后,不是 `socket.send` 返回 true 之后。
 *
 * 本地 send 成功不代表服务端收到了。断网重连后会带着同一个 `clientMessageId`
 * 重投,服务端按它去重。
 */
export function canClearDraft(entry: OutboxEntry | null): boolean {
  return entry?.status === 'acked';
}

/* ------------------------------------------------------------------ */
/*  持久化形状                                                        */
/* ------------------------------------------------------------------ */

/**
 * 存进 localStorage 的形状。
 *
 * 与旧的 `StoredQueuedMessage` 向后兼容:老记录没有 `clientMessageId` /
 * `imageAssetIds`,读出来时按"没有幂等键、没有附件"处理(见 `fromStoredCommand`),
 * 不会因为多了字段就把用户排着的那条丢掉。
 */
export interface StoredSendCommand extends StoredQueuedMessage {
  clientMessageId?: string;
  images?: SendCommandImage[];
  namingText?: string;
  forkFrom?: SendCommandFork | null;
  hiddenContext?: string | null;
  /** 排队时曾经有几张图:用来识别"图丢了"(见 fromStoredCommand)。 */
  imageCount?: number;
}

export function toStoredCommand(command: SendCommand): StoredSendCommand {
  return {
    content: command.text,
    options: command.options,
    clientMessageId: command.clientMessageId,
    images: [...command.images],
    imageCount: command.images.length,
    namingText: command.namingText,
    forkFrom: command.forkFrom,
    hiddenContext: command.hiddenContext,
  };
}

export interface RestoredCommand {
  command: SendCommand;
  /**
   * 排队时有图、恢复出来却没有(或描述符坏了):这条不能直接发。
   * 没记 `imageCount` 的记录按恢复出来的张数算,不会标成丢失。
   */
  attachmentsLost: boolean;
}

export function fromStoredCommand(
  stored: StoredSendCommand,
  context: { sessionKey: string | null; sessionId: string | null; projectId: string | null },
  now: number = Date.now(),
): RestoredCommand {
  const images = Array.isArray(stored.images)
    ? stored.images.filter((img): img is SendCommandImage => (
      Boolean(img) && typeof (img as SendCommandImage).path === 'string' && (img as SendCommandImage).path.length > 0
    ))
    : [];
  const expected = typeof stored.imageCount === 'number' ? stored.imageCount : images.length;

  return {
    command: freezeSendCommand({
      // 老记录没有幂等键 —— 补一个新的。它没法追溯地保护刷新前的那次投递
      //(那次本来就没带 id),但从现在起这条命令是幂等的。
      clientMessageId: isClientMessageId(stored.clientMessageId) ? stored.clientMessageId : undefined,
      sessionKey: context.sessionKey,
      /**
       * 带分叉点的命令不能钉回原会话。
       *
       * 落盘不存 sessionId,恢复时若用 context.sessionId(= 原会话)填回去,服务端一看目标会话有
       * 原生 id 就会把 forkFrom 丢掉,编辑后的内容会追加进原对话。与提交那一刻同一条规则:
       * 有 forkFrom 就 sessionId 为空,由投递路径新开一支。
       */
      sessionId: stored.forkFrom ? null : context.sessionId,
      projectId: context.projectId,
      text: stored.content,
      namingText: typeof stored.namingText === 'string' ? stored.namingText : stored.content,
      images,
      options: stored.options ?? {},
      forkFrom: stored.forkFrom ?? null,
      hiddenContext: stored.hiddenContext ?? null,
      now,
    }),
    attachmentsLost: expected > images.length,
  };
}

/** 恢复出来的那条该以什么状态进 outbox。 */
export function restoredEntry(restored: RestoredCommand): OutboxEntry {
  if (restored.attachmentsLost) {
    return {
      command: restored.command,
      status: 'needs_attachment',
      error: composerText('queuedImagesNotRestored', '排队时附带的图片没能恢复,请重新添加后再发送。'),
      attempts: 0,
    };
  }
  return { command: restored.command, status: 'queued', error: null, attempts: 0 };
}


/**
 * 这一拍能不能动这条会话在盘上的那份排队记录。
 *
 * 落盘 effect 声明在恢复 effect 之前,依赖里都有 `sessionKey`:换会话那一拍落盘先跑,
 * 此时 `sessionKey` 已经是新会话、`outbox` 还是旧会话的(旧会话没排队时就是 `null`)。
 * 不加判断的话,落盘里那句"没有条目就清理"清掉的是新会话盘上那份,紧接着恢复去读,读到空;
 * 排队消息就活不过一次刷新,也活不过切走再切回。
 *
 * 判据两条,缺一不可:
 *
 * 1. 恢复得先认领这条会话:换会话那一拍它还指着旧 key;
 * 2. 有条目时,条目自己记的那条会话得对得上。
 */
export function mayPersistQueuedCommand(
  restoredForKey: string | null,
  sessionKey: string | null,
  outboxSessionKey: string | null | undefined,
): boolean {
  if (!sessionKey) return false;
  if (restoredForKey !== sessionKey) return false;
  if (outboxSessionKey && outboxSessionKey !== sessionKey) return false;
  return true;
}
