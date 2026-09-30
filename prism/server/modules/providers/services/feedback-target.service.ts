import type { NormalizedMessage } from '@/shared/types.js';

/**
 * hl(09-24 P2-21):反馈接口的**服务端核对**。
 *
 * 此前 `POST /sessions/:id/messages/:messageId/feedback` 只查会话可见性:messageId 随便填、
 * `skill_hint` 由客户端自报 —— 能看到会话的人可以给任意技能伪造任意多条评价(每个假
 * messageId 一行),污染技能优化的训练数据。这里从显示日志反查两件事:
 *   1. 这条 messageId 是不是这个会话里的一条**助手回答**;
 *   2. 这一轮(上一条用户消息到这条回答之间)调过哪个 Skill —— 取第一帧。
 * 客户端传的 skill 只在服务端查不到时才用(老会话显示日志被裁过、或工具帧没落库)。
 */
export type FeedbackTarget = {
  /** 显示日志里有这条助手回答 */
  found: boolean;
  /** 这一轮的 Skill 工具帧解出的技能名;没调过 / 没找到消息时 null */
  skill: string | null;
};

export function resolveFeedbackTarget(messages: readonly NormalizedMessage[], messageId: string): FeedbackTarget {
  let turnSkill: string | null = null;
  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'user') {
      turnSkill = null;
      continue;
    }
    if (message.kind === 'tool_use' && message.toolName === 'Skill') {
      const input = message.toolInput as { skill?: unknown } | null | undefined;
      const skill = typeof input?.skill === 'string' ? input.skill.trim() : '';
      if (skill && !turnSkill) turnSkill = skill;
      continue;
    }
    if (message.id === messageId) {
      // 只认助手侧的行:给自己的提问点 👎 没有训练意义,也不该占一行。
      const assistantSide = message.role === 'assistant' || message.role === undefined;
      return { found: assistantSide, skill: assistantSide ? turnSkill : null };
    }
  }
  return { found: false, skill: null };
}
