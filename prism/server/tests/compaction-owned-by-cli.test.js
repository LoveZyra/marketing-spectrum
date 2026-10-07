import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * 压缩归 CLI:这些断言防止 Prism 再自己发起压缩。
 *
 * Prism 自己推 `/compact` 就得放进 `internal: true` 的维护回合,那种回合的看门狗是 idle 90s;
 * 而 `includePartialMessages = false` 时整个压缩期间流上一帧都没有,90s 的 idle 实际成了压缩的总预算。
 * CLI 遇到 "prompt too long" 还会丢消息重试,每次都是一整次模型调用,于是必然超时;
 * 占比没降,下一回合结束又来一次,每答完一条都白等 90 秒,还压不成。
 *
 * 判据全部对源码断言:这是"有没有写某段代码"的事,等跑起来才发现就晚了。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'claude-sdk.js'), 'utf8');

/** 把注释整段挖掉再断言 —— 否则"注释里提到 /compact"会被当成代码。 */
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('压缩归 CLI', () => {
  test('Prism 没有任何地方主动推 /compact', () => {
    // 手打 /compact 走的是普通用户回合(command 原样传下去),不在这里出现。
    assert.equal(
      codeOnly.includes("command: '/compact'"),
      false,
      'Prism 又开始自己推 /compact 了 —— 那会重新引入 internal 回合与 90s 超时'
    );
  });

  test('没有任何回合传 internal: true', () => {
    const matches = codeOnly.match(/internal:\s*true/g) ?? [];
    assert.deepEqual(
      matches,
      [],
      'internal 回合用的是 idle 90s 的预算,压缩塞进去必然超时(见文件头)'
    );
  });

  test('维护窗口与发送前兜底两个函数都没了', () => {
    assert.equal(codeOnly.includes('runMaintenanceCompaction'), false);
    assert.equal(codeOnly.includes('shouldAutoCompact'), false);
    assert.equal(codeOnly.includes('compactionDeferred'), false);
  });

  test('开关与窗口透传给 CLI,而不是 Prism 自己判', () => {
    /*
     * autoCompactEnabled / autoCompactWindow 属于 SDK 的 `Settings` 而不是 `Options`,写在 sdkOptions 顶层
     * 会被静默忽略、两个旋钮都失效。所以这里断言它们写进 compactSettings 再挂到 `sdkOptions.settings`;
     * 字段归属本身由 `settings-shape.test.js` 对着 SDK 的 .d.ts 断言。
     */
    assert.match(codeOnly, /compactSettings\.autoCompactEnabled\s*=\s*false/);
    // 窗口 = min(模型目录里的窗口, PRISM_AUTO_COMPACT_WINDOW),两者有其一就写
    assert.match(codeOnly, /\[contextWindow, AUTO_COMPACT_WINDOW\]/);
    assert.match(codeOnly, /compactSettings\.autoCompactWindow\s*=\s*Math\.min\(\.\.\.windows\)/);
    assert.match(codeOnly, /sdkOptions\.settings\s*=/);
    // Prism 侧不按上下文占比自己判断何时压缩
    assert.equal(codeOnly.includes('AUTO_COMPACT_RATIO'), false);
  });

  test('CLI 报的压缩帧照旧要读 —— 界面进度全靠它', () => {
    assert.match(codeOnly, /message\.status === 'compacting'/);
    assert.match(codeOnly, /message\.compact_result/);
    assert.match(codeOnly, /subtype === 'compact_boundary'/);
    // 手打 /compact 也要点亮进度
    assert.match(codeOnly, /isCompactCommand\(command\)\s*\?\s*'manual'/);
  });

  test('压缩的硬数据要落日志(这次查问题时一个都拿不到)', () => {
    const boundary = codeOnly.slice(codeOnly.indexOf("subtype === 'compact_boundary'"));
    assert.match(boundary, /pre_tokens/);
    assert.match(boundary, /post_tokens/);
    assert.match(boundary, /duration_ms/);
    assert.match(boundary.slice(0, 2000), /log\.info/);
  });

  test('getContextUsage 返回的三个字段不再被扔掉', () => {
    assert.match(codeOnly, /isAutoCompactEnabled/);
    assert.match(codeOnly, /autoCompactThreshold/);
    assert.match(codeOnly, /rawMaxTokens/);
  });
});
