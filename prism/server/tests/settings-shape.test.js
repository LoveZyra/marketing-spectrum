import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, test } from 'vitest';

/**
 * **把"这个字段该写在哪"钉在 SDK 的类型定义上。**
 *
 * gt 里我把自动压缩的两个旋钮写成了 `sdkOptions.autoCompactEnabled` /
 * `sdkOptions.autoCompactWindow` —— 而它们属于 **`Settings`**,不属于 `Options`。
 * SDK **静默忽略**了它们:`PRISM_AUTO_COMPACT=0` 什么也不关,
 * `PRISM_AUTO_COMPACT_WINDOW=30000` 也压不出来。测试环境上"触发不出压缩"就是它。
 *
 * 为什么没被任何门禁拦住:`server/claude-sdk.js` 是 **.js**,`sdkOptions` 是纯对象 ——
 * 多写一个不存在的字段,typecheck / eslint / 2100 条测试**一条都不会红**。
 * 这类错只能靠"对着 SDK 的 .d.ts 断言"来拦。
 *
 * 这里同时钉两头:
 *   ① 我们写的代码把旋钮放进了 `options.settings`;
 *   ② SDK 的 .d.ts 里这两个字段确实在 `Settings` 上、且 `Options.settings` 收得下它。
 * SDK 换版把字段挪了位置,②就变红 —— 比"跑起来发现旋钮是死的"早得多。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const source = readFileSync(path.join(here, '..', 'claude-sdk.js'), 'utf8');
const sdkTypes = readFileSync(
  path.join(repoRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts'),
  'utf8'
);

/** 挖掉注释 —— 上面那段说明里就写着这几个名字。 */
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

/** 某个字段声明在哪个 `export declare type/interface` 里。 */
const ownerOf = (declaration) => {
  const at = sdkTypes.indexOf(declaration);
  if (at < 0) return null;
  const before = sdkTypes.slice(0, at);
  const decls = [...before.matchAll(/export declare (?:type|interface) (\w+)/g)];
  return decls.length > 0 ? decls[decls.length - 1][1] : null;
};

describe('SDK 选项的写入位置', () => {
  test('**关键**:自动压缩的旋钮写进 options.settings,不是 options 顶层', () => {
    assert.match(codeOnly, /sdkOptions\.settings\s*=\s*\{[\s\S]{0,80}compactSettings/);
    assert.equal(
      /sdkOptions\.autoCompactEnabled/.test(codeOnly),
      false,
      'autoCompactEnabled 不在 Options 上,写顶层会被 SDK 静默忽略'
    );
    assert.equal(
      /sdkOptions\.autoCompactWindow/.test(codeOnly),
      false,
      'autoCompactWindow 不在 Options 上,写顶层会被 SDK 静默忽略'
    );
  });

  test('SDK 的 .d.ts 里,这两个字段确实属于 Settings', () => {
    assert.equal(ownerOf('autoCompactEnabled?: boolean'), 'Settings');
    assert.equal(ownerOf('autoCompactWindow?: number'), 'Settings');
  });

  test('Options.settings 收得下一个 Settings 对象', () => {
    assert.equal(ownerOf('settings?: string | Settings;'), 'Options');
  });

  test('settings 是路径字符串时不硬覆盖,只警告', () => {
    const block = codeOnly.slice(codeOnly.indexOf('const compactSettings'));
    assert.match(block.slice(0, 900), /typeof sdkOptions\.settings === 'string'/);
    assert.match(block.slice(0, 900), /log\.warn/);
  });
});
