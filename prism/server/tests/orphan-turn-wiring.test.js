import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * gb:**接线钉死。**
 *
 * 观测回合这件事有三根线,断任何一根,功能就悄悄退回改动前(而且不会有测试变红,
 * 因为纯函数那侧照样是绿的)——这一轮已经在这个形状上付过太多次代价:
 *
 *  1. 读循环的 `if (!turn)` 分支要真的调 `routeOrphanMessage`,而不是只 `continue`;
 *  2. 组合根要把钩子接上(`setOrphanTurnHook`),否则 claude-sdk 那边只计数不转发;
 *  3. 任务生命周期通道在**有回合**时也要送(前台起的后台任务就在那一轮里报)。
 */
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('无主帧路由的接线', () => {
  const sdk = read('../claude-sdk.js');

  it('`if (!turn)` 分支调了 routeOrphanMessage,不再是一句光秃秃的 continue', () => {
    // 读循环里那一处(文件里还有别的 `const turn = runtime.turn;`,取带早退的那个)
    const at = sdk.indexOf('const turn = runtime.turn;\n      if (!turn) {');
    expect(at).toBeGreaterThan(0);
    const branch = sdk.slice(at, at + 1800);
    expect(branch).toMatch(/routeOrphanMessage\(runtime, message\);/);
    // 旧代码那一行必须已经不在**代码**里(注释里引用它是为了记住这条教训)
    expect(sdk).not.toMatch(/^\s*continue; \/\/ stray events between turns/m);
  });

  it('任务生命周期通道在回合内也送(前台转后台的任务就在那一轮里报)', () => {
    expect(sdk).toMatch(/const taskRowInTurn = taskLifecycleMessage\(message, runtime\.sessionId \|\| null\);/);
    expect(sdk).toMatch(/if \(!turn\.internal\) turn\.ws\.send\(taskRowInTurn\);/);
  });

  it('钩子没接线时行为退回改动前 —— 只计数、不转发(这是总开关)', () => {
    expect(sdk).toMatch(/if \(!orphanTurnHook \|\| !appSessionId\) return;/);
    // 记账要发生在 return 之前,否则"丢了多少"永远是 0
    const fn = sdk.slice(sdk.indexOf('function routeOrphanMessage'));
    expect(fn.indexOf('orphanStats.frames += 1;'))
      .toBeLessThan(fn.indexOf('if (!orphanTurnHook || !appSessionId) return;'));
  });

  it('判据是"Prism 有没有为这一轮建 run",**不是帧上的 origin**', () => {
    // 实测 09-09 那两条注入帧完全没有 origin 字段,按 origin 判会漏掉。
    const fn = sdk.slice(sdk.indexOf('function routeOrphanMessage'), sdk.indexOf('function looksLikeTaskNotification'));
    expect(fn).not.toMatch(/\borigin\b/);
  });

  it('组合根把钩子接上了', () => {
    const root = read('../index.js');
    expect(root).toMatch(/setOrphanTurnHook\(observeOrphanFrames\);/);
    expect(root).toMatch(/observeOrphanFrames/);
  });

  it('用户消息带上 priority —— SDK 的 streamInput 原样透传这个字段', () => {
    const at = sdk.indexOf('runtime.input.push({');
    expect(at).toBeGreaterThan(0);
    expect(sdk.slice(at, at + 1600)).toMatch(/priority: 'now',/);
  });
});
