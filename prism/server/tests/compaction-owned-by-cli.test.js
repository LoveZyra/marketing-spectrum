import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * **gt:压缩归 CLI —— 这些断言是防止它被塞回来的。**
 *
 * 2026-09-15 生产上的机理:Prism 自己推 `/compact`,跑在 `internal: true` 的维护
 * 回合里,而那种回合的看门狗是 idle 90s。可 `includePartialMessages = false` 意味着
 * **整个压缩期间流上一帧都不会有** —— 那 90s 名义上是 idle,实际是压缩的总预算。
 * CLI 内部遇到 "prompt too long" 还会丢消息重试,每次都是一整次模型调用。
 * 于是必然超时;超时后占比没降,下一回合结束又来一次 ——
 * **每答完一条就白等 90 秒,还压不成**。
 *
 * 判据全部对源码断言:这些是"有没有写某段代码"的事,跑起来才发现就太晚了
 * (那意味着又在生产上转 90 秒)。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'claude-sdk.js'), 'utf8');

/** 把注释整段挖掉再断言 —— 否则"注释里提到 /compact"会被当成代码。 */
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('压缩归 CLI(gt)', () => {
  test('**关键**:Prism 不再有任何地方主动推 /compact', () => {
    // 手打 /compact 走的是普通用户回合(command 原样传下去),不在这里出现。
    assert.equal(
      codeOnly.includes("command: '/compact'"),
      false,
      'Prism 又开始自己推 /compact 了 —— 那会重新引入 internal 回合与 90s 超时'
    );
  });

  test('**关键**:没有任何回合再传 internal: true', () => {
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
     * gu 更正:这一条原来断言的是 `sdkOptions.autoCompactEnabled = false` ——
     * **那正是 gt 里的错**。这两个字段属于 `Settings` 不属于 `Options`,
     * 写在顶层会被 SDK 静默忽略,两个旋钮都是死的。
     * 一条钉错了位置的测试给的是**假的信心**,这次就是它把错误一起绿了过去。
     * 位置本身的判据挪到 `settings-shape.test.js`,对着 SDK 的 .d.ts 断言。
     */
    assert.match(codeOnly, /compactSettings\.autoCompactEnabled\s*=\s*false/);
    assert.match(codeOnly, /compactSettings\.autoCompactWindow\s*=\s*AUTO_COMPACT_WINDOW/);
    assert.match(codeOnly, /sdkOptions\.settings\s*=/);
    // Prism 侧那条 0.8 的判据不该再存在
    assert.equal(codeOnly.includes('AUTO_COMPACT_RATIO'), false);
  });

  test('CLI 报的压缩帧照旧要读 —— 界面进度全靠它', () => {
    assert.match(codeOnly, /message\.status === 'compacting'/);
    assert.match(codeOnly, /message\.compact_result/);
    assert.match(codeOnly, /subtype === 'compact_boundary'/);
    // 手打 /compact 仍然点亮进度
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
