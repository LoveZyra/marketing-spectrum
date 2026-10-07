import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 观测回合的接线。
 *
 * 观测回合靠三根线,断任何一根功能都会悄悄失效,而纯函数那侧的测试照样是绿的,所以这里用源码把接线钉住:
 *
 *  1. 读循环的 `if (!turn)` 分支要真的调 `routeOrphanMessage`,而不是只 `continue`;
 *  2. 组合根要把钩子接上(`setOrphanTurnHook`),否则 claude-sdk 那边只计数不转发;
 *  3. 任务生命周期通道在有回合时也要送(前台起的后台任务就在那一轮里报)。
 */
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('无主帧路由的接线', () => {
  const sdk = read('../claude-sdk.js');

  it('`if (!turn)` 分支调了 routeOrphanMessage,不再是一句光秃秃的 continue', () => {
    // 读循环里那一处(文件里还有别的 `const turn = runtime.turn;`,取带早退的那个)
    const at = sdk.indexOf('const turn = runtime.turn;\n      if (!turn) {');
    expect(at).toBeGreaterThan(0);
    const branch = sdk.slice(at, at + 1800);
    // 还要带上「这一帧回答的是不是合流消息」
    expect(branch).toMatch(/routeOrphanMessage\(runtime, message, \{ answersMerged \}\);/);
    // 只 continue 的那一行不能出现在代码里(按行首匹配,注释里提到它不算)
    expect(sdk).not.toMatch(/^\s*continue; \/\/ stray events between turns/m);
  });

  it('任务生命周期通道在回合内也送(前台转后台的任务就在那一轮里报)', () => {
    expect(sdk).toMatch(/const taskRowInTurn = taskLifecycleMessage\(message, runtime\.sessionId \|\| null\);/);
    // 没有 `internal` 维护回合,回合内一律直接送。
    expect(sdk).toMatch(/^\s*turn\.ws\.send\(taskRowInTurn\);/m);
  });

  it('钩子没接线时行为退回改动前 —— 只计数、不转发(这是总开关)', () => {
    expect(sdk).toMatch(/if \(!orphanTurnHook \|\| !appSessionId\) return;/);
    // 记账要发生在 return 之前,否则"丢了多少"永远是 0。
    // 心跳分支(tool_progress)在记账之前就有自己的早退:它不是内容帧,不记账。
    // 这里看的是内容帧那条路:记账那句之后的第一个早退。
    const fn = sdk.slice(sdk.indexOf('function routeOrphanMessage'));
    const accountAt = fn.indexOf('orphanStats.frames += 1;');
    expect(accountAt).toBeGreaterThan(0);
    expect(fn.indexOf('if (!orphanTurnHook || !appSessionId) return;', accountAt)).toBeGreaterThan(accountAt);
  });

  it('判据是"Prism 有没有为这一轮建 run",不是帧上的 origin', () => {
    // CLI 自己注入的帧可以完全不带 origin 字段,按 origin 判会漏掉。
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
