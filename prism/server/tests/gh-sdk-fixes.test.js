import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  collectToolUseDelta,
  collectSubagentToolUseDelta,
  routeOrphanMessage,
  setOrphanTurnHook,
  shouldIgnoreForeignResult,
  taskLifecycleMessage,
} from '../claude-sdk.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const sdk = read('../claude-sdk.js');

/**
 * gh:审计报告(gg 后)里 SDK 层那几条的回归测试。
 *
 * 纯函数的走真函数;读循环里的接线用源码钉住 —— 这一轮出错的地方全在
 * "判据写对了、喂进去的不是那个值"上,所以每条都连调用点一起钉。
 */
describe('#2 子代理的工具不算主 CLI 的在途', () => {
  const subagentFrame = {
    type: 'assistant',
    parent_tool_use_id: 'toolu_parent',
    message: { content: [{ type: 'tool_use', id: 'toolu_child', name: 'Bash', input: {} }] },
  };
  const mainFrame = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_main', name: 'Bash', input: {} }] },
  };

  it('带 parent_tool_use_id 的帧不进 pendingToolUses —— 否则用户一发消息就把后台子代理杀了', () => {
    expect(collectToolUseDelta(subagentFrame)).toEqual({ adds: [], removes: [] });
    expect(collectToolUseDelta(mainFrame)).toEqual({ adds: ['toolu_main'], removes: [] });
  });

  it('子代理的在途另记一张(innerId → parent),只给看门狗用', () => {
    expect(collectSubagentToolUseDelta(subagentFrame)).toEqual({ adds: [{ id: 'toolu_child', parent: 'toolu_parent' }], removes: [] });
    expect(collectSubagentToolUseDelta(mainFrame)).toEqual({ adds: [], removes: [] });
  });

  it('接线:读循环两张表都记;runtimeForSend 的重建判据只看 pendingToolUses', () => {
    expect(sdk).toMatch(/for \(const \{ id, parent \} of subagentDelta\.adds\) runtime\.subagentToolUses\.set\(id, parent\);/);
    expect(sdk).toMatch(/if \(runtime && runtime\.pendingToolUses\.size > 0\) \{/);
    expect(sdk).not.toMatch(/runtime\.subagentToolUses\.size > 0\) \{\s*\n\s*log\.warn/);
  });

  /**
   * gi 自查:子代理被中止时内部工具不会有 tool_result,这张表要能清空,否则看门狗永远"只续不杀"。
   */
  it('父任务收工(顶层 tool_result / task_notification)清掉它名下的子代理在途;中止全清', () => {
    expect(sdk).toMatch(/for \(const parentId of toolDelta\.removes\) settleSubagentTools\(runtime, parentId\);/);
    expect(sdk).toMatch(/subtype === 'task_notification' && message\.tool_use_id\) \{\s*\n\s*settleSubagentTools\(runtime, message\.tool_use_id\);/);
    // 两条中止路径都全清
    expect((sdk.match(/settleSubagentTools\(runtime, null\);/g) || []).length).toBe(2);
    // 中止也要解除"外来 result"的提防,否则用户回合等不到自己的 result
    expect(sdk).toMatch(/function disarmForeignResultGuard\(runtime\) \{\s*\n\s*if \(runtime\?\.turn\) runtime\.turn\.expectForeignResult = false;/);
    expect((sdk.match(/disarmForeignResultGuard\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('#11 CLI 自己那一轮的 result 不算用户回合的结束', () => {
  it('push 时 CLI 的一轮开着、且本回合还没收到任何帧 → 忽略这条 result', () => {
    expect(shouldIgnoreForeignResult({ expectForeignResult: true, sawFrame: false })).toBe(true);
    expect(shouldIgnoreForeignResult({ expectForeignResult: true, sawFrame: true })).toBe(false);
    expect(shouldIgnoreForeignResult({ expectForeignResult: false, sawFrame: false })).toBe(false);
    expect(shouldIgnoreForeignResult(undefined)).toBe(false);
  });

  it('接线:turn 建立时读 runtime.orphanTurnOpen;读循环用这条判据 continue;非 result 帧置 sawFrame', () => {
    expect(sdk).toMatch(/expectForeignResult: Boolean\(runtime\.orphanTurnOpen\),/);
    expect(sdk).toMatch(/if \(shouldIgnoreForeignResult\(turn\)\) \{[\s\S]{0,400}continue;/);
    expect(sdk).toMatch(/\} else \{\s*\n\s*turn\.sawFrame = true;/);
    // 只有**顶层**有内容帧才把 orphanTurnOpen 置真(子代理帧不会带来顶层 result)
    expect(sdk).toMatch(/else if \(isContentfulFrame\(message\) && !message\?\.parent_tool_use_id\) runtime\.orphanTurnOpen = true;/);
    // 回合内处理的顶层 result 也要把这个位清掉,否则它会卡在 true(gh 自查时抓到的)
    expect(sdk).toMatch(/if \(isTurnResult\(message\)\) \{[\s\S]{0,300}runtime\.orphanTurnOpen = false;\s*\n\s*recordTurnUsage\(turn\.usage, message, \{/);
  });
});

describe('#19 子代理帧不刷主上下文环', () => {
  it('常驻与一次性两条路都过滤 parent_tool_use_id', () => {
    const sites = sdk.match(/message\?\.parent_tool_use_id \? null : extractTokenBudget\(message/g) || [];
    expect(sites).toHaveLength(2);
  });
});

describe('#9 一次性路径接任务生命周期通道', () => {
  it('一次性读循环在 normalizeMessage 之前调 taskLifecycleMessage', () => {
    const start = sdk.indexOf('Starting async generator loop for session');
    const oneShot = sdk.slice(start, sdk.indexOf('clearOneShotWatchdog();', start));
    expect(oneShot).toMatch(/const taskRowOneShot = taskLifecycleMessage\(message, sid\);/);
    expect(oneShot).toMatch(/if \(taskRowOneShot\) \{\s*\n\s*ws\.send\(taskRowOneShot\);\s*\n\s*continue;/);
    // 调用点从两处变成三处
    expect((sdk.match(/= taskLifecycleMessage\(message, /g) || []).length).toBe(3);
  });

  it('那条路喂进去的帧形状与常驻路径相同 —— 同一个函数给出同一行', () => {
    const row = taskLifecycleMessage({
      type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_bg',
      status: 'completed', summary: '跑完了', usage: { duration_ms: 3000, tool_uses: 4 },
    }, 'sess');
    expect(row?.kind).toBe('task_notification');
    expect(row?.toolId).toBe('toolu_bg');
  });
});

describe('#3 「停止」要能停掉 CLI 自己发起的那一轮', () => {
  it('abortClaudeSDKRun 在 activeChatRuns 里找不到时按 app 会话 id 找 runtime 并 interrupt', () => {
    const fn = sdk.slice(sdk.indexOf('async function abortClaudeSDKRun(runId)'));
    expect(fn.slice(0, 1600)).toMatch(/const runtime = findRuntimeByAppSessionId\(runId\);/);
    expect(fn.slice(0, 1600)).toMatch(/await interruptWithTimeout\(runtime\.query, `run \$\{runId\} \(observed\)`\);/);
    // 有活跃回合的 runtime 不走这条(那是正常回合,由 activeChatRuns 那条路管)
    expect(fn.slice(0, 1600)).toMatch(/if \(!runtime \|\| runtime\.turn\) return false;/);
  });
});

describe('#12 心跳续期(gi 自查:带 tool_use_id 的 task_progress 不是纯心跳)', () => {
  const runtime = {
    key: 'r', appSessionId: 'app', sessionId: 's', ownerUserId: 1,
    pendingToolUses: new Set(), subagentToolUses: new Map(),
  };
  const capture = () => { const seen = []; setOrphanTurnHook((p) => { seen.push(p); return true; }); return seen; };

  it('带 tool_use_id 的 task_progress 仍然变成卡片的进展行(走真的 routeOrphanMessage)', () => {
    const seen = capture();
    routeOrphanMessage(runtime, {
      type: 'system', subtype: 'task_progress', task_id: 't', tool_use_id: 'toolu_bg',
      usage: { tool_uses: 12, duration_ms: 5000 }, last_tool_name: 'Bash',
    });
    setOrphanTurnHook(null);
    expect(seen).toHaveLength(1);
    expect(seen[0].messages.map((m) => m.kind)).toEqual(['task_progress']);
    expect(seen[0].messages[0].toolId).toBe('toolu_bg');
    expect(seen[0].toolsInFlight).toBe(false);
  });

  it('没有 tool_use_id 的 task_progress 与 tool_progress 只当心跳(空批,带 toolsInFlight)', () => {
    const seen = capture();
    runtime.subagentToolUses.set('inner', 'toolu_parent');
    routeOrphanMessage(runtime, { type: 'system', subtype: 'task_progress', task_id: 't2', usage: { tool_uses: 1 } });
    routeOrphanMessage(runtime, { type: 'tool_progress', tool_use_id: 'toolu_x' });
    runtime.subagentToolUses.clear();
    setOrphanTurnHook(null);
    expect(seen).toHaveLength(2);
    for (const p of seen) {
      expect(p.messages).toEqual([]);
      expect(p.toolsInFlight).toBe(true);
    }
  });

  it('routeOrphanMessage 把 tool_progress / task_progress 当活动送给钩子(空批 + toolsInFlight)', () => {
    const fn = sdk.slice(sdk.indexOf('export function routeOrphanMessage'), sdk.indexOf('function looksLikeTaskNotification'));
    expect(fn).toMatch(/const heartbeat = isActivityHeartbeat\(message\);/);
    expect(fn).toMatch(/messages: \[\],\s*\n\s*trigger: 'unknown',\s*\n\s*turnEnded: false,\s*\n\s*toolsInFlight:/);
    // 内容帧那一批也带 toolsInFlight
    expect((fn.match(/toolsInFlight: runtime\.pendingToolUses\.size \+ \(runtime\.subagentToolUses\?\.size \?\? 0\) > 0/g) || []).length).toBe(2);
  });
});
