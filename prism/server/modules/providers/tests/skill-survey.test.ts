import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types.js';

import {
  collectSkillSurveyCandidates, decideSkillSurveys, readSurveyConfig, surveySampled,
} from '../services/skill-survey.service.js';

/**
 * gy:效果调查卡的判定 —— 纯函数,不碰库。
 *
 * 钉住《方案》6.2b 的每一条:只对调过 Skill 的网页回合、只给发起人、按回合确定性抽样、
 * 同 skill 冷却、已答过的不再弹、关掉开关不弹。
 */
const msg = (partial: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'x', sessionId: 's', timestamp: '2026-09-23T02:00:00.000Z', provider: 'claude', kind: 'text', ...partial,
} as NormalizedMessage);

const user = (id: string, senderUserId?: number, origin: 'web' | 'scheduled' = 'web', ts = '2026-09-23T02:00:00.000Z') =>
  msg({ id, role: 'user', content: '按等长日窗比较', senderUserId, origin, timestamp: ts });
const skill = (id: string, name = 'marketing-audit') =>
  msg({ id, kind: 'tool_use', toolName: 'Skill', toolInput: { skill: name }, toolId: id });
const answer = (id: string, ts = '2026-09-23T02:01:00.000Z', content = '环比 +7.9%') =>
  msg({ id, role: 'assistant', content, timestamp: ts });

const turn = (n: number, senderUserId = 7, origin: 'web' | 'scheduled' = 'web', ts = `2026-09-23T0${n}:00:00.000Z`) => [
  user(`user_${n}`, senderUserId, origin, ts),
  skill(`tool_${n}`),
  answer(`aaaaaaa${n}-0000-4000-8000-000000000000_text`, `2026-09-23T0${n}:05:00.000Z`),
];

describe('collectSkillSurveyCandidates', () => {
  test('调过 Skill 且由我发起的网页回合 → 一个候选,挂在最后一条助手正文上', () => {
    const messages = [
      ...turn(1),
      answer('bbbbbbbb-0000-4000-8000-000000000000_text', '2026-09-23T01:06:00.000Z', '补充:明细已写入'),
    ];
    const got = collectSkillSurveyCandidates(messages, 7);
    assert.deepEqual(got, [{ messageId: 'bbbbbbbb-0000-4000-8000-000000000000_text', skill: 'marketing-audit', timestamp: '2026-09-23T01:06:00.000Z' }]);
  });

  test('没调 Skill、旁观者、定时任务、没有正文的回合都不是候选', () => {
    const noSkill = [user('u1', 7), answer('a1')];
    const bystander = turn(1, 9);
    const scheduled = turn(2, 7, 'scheduled');
    const noAnswer = [user('u3', 7), skill('t3')];
    const legacy = [msg({ id: 'u4', role: 'user', content: 'old' }), skill('t4'), answer('a4')];
    for (const messages of [noSkill, bystander, scheduled, noAnswer, legacy]) {
      assert.deepEqual(collectSkillSurveyCandidates(messages, 7), []);
    }
    // 中间正文不是锚点:CLI 自己发起的回合(没有用户气泡)也不是
    assert.deepEqual(collectSkillSurveyCandidates([skill('t5'), answer('a5')], 7), []);
  });

  test('多轮各自独立;用户 id 数字 / 字符串都能对上', () => {
    const messages = [...turn(1), ...turn(2, 8), ...turn(3)];
    assert.equal(collectSkillSurveyCandidates(messages, '7').length, 2);
    assert.equal(collectSkillSurveyCandidates(messages, 8).length, 1);
  });
});

describe('surveySampled', () => {
  test('确定性:同一 id 多次结果一致;rate 0 永不、rate 1 必中;约半数命中', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000000_text';
    const first = surveySampled(id, 0.5);
    for (let i = 0; i < 10; i += 1) assert.equal(surveySampled(id, 0.5), first);
    assert.equal(surveySampled(id, 0), false);
    assert.equal(surveySampled(id, 1), true);
    let hits = 0;
    for (let i = 0; i < 1000; i += 1) if (surveySampled(`m-${i}`, 0.5)) hits += 1;
    assert.ok(hits > 400 && hits < 600, `1000 个里命中 ${hits},不像 50%`);
  });
});

describe('decideSkillSurveys', () => {
  const base = {
    viewerUserId: 7, rate: 1, cooldownMs: 60 * 60_000,
    answeredMessageIds: new Set<string>(), lastSurveyAt: () => null, enabled: true,
  };
  const c = (n: number, s = 'marketing-audit', hour = n) =>
    ({ messageId: `m${n}`, skill: s, timestamp: `2026-09-23T${String(hour).padStart(2, '0')}:00:00.000Z` });

  test('关掉开关 / rate 0 / 未登录 → 空', () => {
    assert.deepEqual(decideSkillSurveys([c(1)], { ...base, enabled: false }), []);
    assert.deepEqual(decideSkillSurveys([c(1)], { ...base, rate: 0 }), []);
    assert.deepEqual(decideSkillSurveys([c(1)], { ...base, viewerUserId: null }), []);
  });

  test('已答过的不再弹,但它把冷却时钟拨到那一刻', () => {
    const got = decideSkillSurveys([c(1, 'a', 1), c(2, 'a', 1)], { ...base, answeredMessageIds: new Set(['m1']) });
    assert.deepEqual(got.map((x) => x.messageId), [], '同一小时内的第二轮在冷却期内');
    const later = decideSkillSurveys([c(1, 'a', 1), c(2, 'a', 3)], { ...base, answeredMessageIds: new Set(['m1']) });
    assert.deepEqual(later.map((x) => x.messageId), ['m2']);
  });

  test('同 skill 冷却:一小时内只弹一张;不同 skill 互不影响;库里的上次询问也算', () => {
    const got = decideSkillSurveys([c(1, 'a', 1), c(2, 'a', 1), c(3, 'b', 1), c(4, 'a', 5)], base);
    assert.deepEqual(got.map((x) => x.messageId), ['m1', 'm3', 'm4']);
    const fromDb = decideSkillSurveys([c(1, 'a', 1)], { ...base, lastSurveyAt: () => '2026-09-23 00:30:00' });
    assert.deepEqual(fromDb, [], 'SQLite 时间串也要能解析进冷却');
  });
});

describe('readSurveyConfig', () => {
  test('默认 0.5 / 60 分钟;越界与乱填回落默认', () => {
    assert.deepEqual(readSurveyConfig({}), { rate: 0.5, cooldownMs: 3_600_000 });
    assert.deepEqual(readSurveyConfig({ PRISM_SKILL_SURVEY_RATE: '0', PRISM_SKILL_SURVEY_COOLDOWN_MIN: '5' }), { rate: 0, cooldownMs: 300_000 });
    assert.deepEqual(readSurveyConfig({ PRISM_SKILL_SURVEY_RATE: '9', PRISM_SKILL_SURVEY_COOLDOWN_MIN: 'x' }), { rate: 1, cooldownMs: 3_600_000 });
  });
});
