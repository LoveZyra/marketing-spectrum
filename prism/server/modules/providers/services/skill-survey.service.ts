import { createHash } from 'node:crypto';

import type { NormalizedMessage } from '@/shared/types.js';

/**
 * gy:「这次 <skill> 处理得怎么样?」—— 调过 skill 的回合结束后,按抽样弹给发起人的
 * 效果调查卡。这里只算**该不该弹、弹哪几张**,不碰 IO;路由把显示日志、反馈行和
 * 用户开关喂进来。
 *
 * 判据(《方案》6.2b):
 *   1. 这一轮真的调了 skill —— 显示日志里有 `tool_use` 且 `toolName === 'Skill'`,
 *      `toolInput.skill` 就是技能名(产出卡认 Write 帧、harvest 认 Skill 帧,同一条路);
 *   2. 回合正常结束 —— 显示日志不落 `complete` 帧,这里以"这一轮有最终助手正文"为准,
 *      中断的回合往往没有正文;
 *   3. 抽中 —— `sha256(anchorId) % 100 < rate * 100`,**按回合确定性抽样,刷新不重掷**。
 *
 * 三道不打扰的闸:只给发起这一轮的人(`senderUserId`);同一人对同一 skill 冷却期内不再问;
 * 定时任务 / API 的回合(`origin !== 'web'`)一律不问。已经 👍/👎 或答过 / 跳过的不再弹
 * —— 那两条由路由按反馈行过滤。
 */
export type SkillSurveyCandidate = {
  /** 这一轮最后一条助手正文的消息 id —— 卡挂在它下面,反馈也记在它名下 */
  messageId: string;
  skill: string;
  timestamp: string | null;
};

export type SkillSurveyOptions = {
  viewerUserId: number | string | null | undefined;
  /** 0–1;0 = 关闭 */
  rate: number;
  cooldownMs: number;
  /** 当前用户对本会话各消息已有的反馈(message_id 集合) */
  answeredMessageIds: ReadonlySet<string>;
  /** 当前用户对某 skill 最近一次被问的时间(ISO / SQLite 时间串),路由从 message_feedback 取 */
  lastSurveyAt: (skill: string) => string | null;
  /** 用户在「我的账号」里关掉了询问 */
  enabled: boolean;
  now?: number;
};

export function surveySampled(messageId: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  const digest = createHash('sha256').update(messageId).digest();
  const bucket = digest.readUInt16BE(0) % 100;
  return bucket < Math.round(rate * 100);
}

const sameUser = (a: unknown, b: unknown): boolean => a != null && b != null && String(a) === String(b);

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  // SQLite 的 CURRENT_TIMESTAMP 是 'YYYY-MM-DD HH:MM:SS'(UTC,无时区);补成 ISO 再解析。
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 从显示日志里找出"调过 skill 且由 viewer 发起的网页回合",每轮一个候选(挂在最后一条
 * 助手正文上)。不做抽样与冷却 —— 那两步在 `decideSkillSurveys`。
 */
export function collectSkillSurveyCandidates(
  messages: readonly NormalizedMessage[],
  viewerUserId: number | string | null | undefined,
): SkillSurveyCandidate[] {
  const out: SkillSurveyCandidate[] = [];
  let turn: { mine: boolean; skill: string; anchorId: string; anchorTs: string | null } | null = null;
  const flush = () => {
    if (turn && turn.mine && turn.skill && turn.anchorId) {
      out.push({ messageId: turn.anchorId, skill: turn.skill, timestamp: turn.anchorTs });
    }
    turn = null;
  };
  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'user') {
      flush();
      const mine = message.origin === 'web' && sameUser(message.senderUserId, viewerUserId);
      turn = { mine, skill: '', anchorId: '', anchorTs: null };
      continue;
    }
    if (!turn) continue;
    if (message.kind === 'tool_use' && message.toolName === 'Skill') {
      const input = message.toolInput as { skill?: unknown } | null | undefined;
      const skill = typeof input?.skill === 'string' ? input.skill.trim() : '';
      if (skill && !turn.skill) turn.skill = skill;
      continue;
    }
    if (message.kind === 'text' && message.role === 'assistant') {
      const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
      if (hasContent && typeof message.id === 'string' && message.id) {
        turn.anchorId = message.id;
        turn.anchorTs = typeof message.timestamp === 'string' ? message.timestamp : null;
      }
    }
  }
  flush();
  return out;
}

/** 抽样 + 三道闸 → 这次响应里要画的卡。 */
export function decideSkillSurveys(
  candidates: readonly SkillSurveyCandidate[],
  options: SkillSurveyOptions,
): SkillSurveyCandidate[] {
  if (!options.enabled || !(options.rate > 0) || options.viewerUserId == null) return [];
  const now = options.now ?? Date.now();
  const lastAskedBySkill = new Map<string, number>();
  const out: SkillSurveyCandidate[] = [];
  for (const candidate of candidates) {
    if (options.answeredMessageIds.has(candidate.messageId)) {
      // 已经答过 / 跳过 / 投过票:不弹,但它算这个 skill 的一次"问过",冷却从它起算。
      const t = parseTime(candidate.timestamp);
      if (t !== null) lastAskedBySkill.set(candidate.skill, Math.max(lastAskedBySkill.get(candidate.skill) ?? 0, t));
      continue;
    }
    if (!surveySampled(candidate.messageId, options.rate)) continue;
    const candidateTime = parseTime(candidate.timestamp) ?? now;
    const fromDb = parseTime(options.lastSurveyAt(candidate.skill));
    const lastAsked = Math.max(fromDb ?? 0, lastAskedBySkill.get(candidate.skill) ?? 0);
    if (lastAsked > 0 && candidateTime - lastAsked < options.cooldownMs && candidateTime >= lastAsked) continue;
    out.push(candidate);
    lastAskedBySkill.set(candidate.skill, Math.max(lastAskedBySkill.get(candidate.skill) ?? 0, candidateTime));
  }
  return out;
}

/** `.env` → 数值;配错就当默认。 */
export function readSurveyConfig(env: NodeJS.ProcessEnv = process.env): { rate: number; cooldownMs: number } {
  const rawRate = Number.parseFloat(String(env.PRISM_SKILL_SURVEY_RATE ?? ''));
  const rate = Number.isFinite(rawRate) ? Math.min(1, Math.max(0, rawRate)) : 0.5;
  const rawCooldown = Number.parseInt(String(env.PRISM_SKILL_SURVEY_COOLDOWN_MIN ?? ''), 10);
  const cooldownMin = Number.isFinite(rawCooldown) && rawCooldown >= 0 ? rawCooldown : 60;
  return { rate, cooldownMs: cooldownMin * 60_000 };
}
