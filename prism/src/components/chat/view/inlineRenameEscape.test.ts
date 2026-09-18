/**
 * 行内改名时按 Esc,**不能顺带把正在跑的那一轮也中止掉**。
 *
 * gq:`ChatInterface` 的全局 Esc 挂在 document 的 **capture 阶段**,比输入框自己的
 * `onKeyDown`(React 的冒泡阶段)先跑。它原本只放行 dialog / 交互面板 / 查找条 ——
 * 侧栏改项目名、改会话名、文件树改文件名这三处都不在其中,于是 `canAbortSession`
 * 为真时,按 Esc 取消改名会**同时**把这一轮 run 中止掉。
 *
 * 判据钉两头:放行的判据是**事件源**(closest,不是 querySelector ——
 * 别处开着改名框不该影响你在输入框外按 Esc 中止本轮),
 * 以及全仓每一个行内改名输入框都真的带上了这个标记。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoSrc = path.resolve(here, '../../..');

const chatInterface = readFileSync(path.join(here, 'ChatInterface.tsx'), 'utf8');

/** 全局 Esc 那个 handler 的函数体。 */
const handler = (() => {
  const at = chatInterface.indexOf('const handleGlobalEscape');
  expect(at, '找不到全局 Esc').toBeGreaterThan(-1);
  const end = chatInterface.indexOf("document.addEventListener('keydown', handleGlobalEscape", at);
  return chatInterface.slice(at, end);
})();

/** 带行内改名输入框的文件 —— 少一个都是一处会误中止的入口。 */
const RENAME_INPUT_FILES = [
  'components/sidebar/view/subcomponents/SidebarSessionItem.tsx',
  'components/sidebar/view/subcomponents/SidebarProjectItem.tsx',
  'components/file-tree/view/FileTreeNode.tsx',
];

describe('行内改名的 Esc 不中止本轮', () => {
  it('全局 Esc 按事件源放行', () => {
    expect(handler).toContain('data-inline-rename="true"');
    expect(handler, '要的是事件源,不是"在不在场"').toContain('closest');
    expect(handler).not.toMatch(/querySelector\([^)]*data-inline-rename/);
  });

  it('放行是 return,不是 preventDefault 之后才退', () => {
    const at = handler.indexOf('data-inline-rename');
    const after = handler.slice(at, at + 200);
    expect(after).toContain('return;');
    expect(after.slice(0, after.indexOf('return;'))).not.toContain('handleAbortSession');
  });

  it('原来那三类放行(dialog / 交互面板 / 查找条)一条没丢', () => {
    expect(handler).toContain('[role="dialog"]');
    expect(handler).toContain('[data-interactive-prompt="true"]');
    expect(handler).toContain('[data-find-bar-open="true"]');
  });

  it('全仓每个行内改名输入框都带这个标记', () => {
    for (const rel of RENAME_INPUT_FILES) {
      const source = readFileSync(path.join(repoSrc, rel), 'utf8');
      expect(source, `${rel} 少了行内改名标记`).toContain('data-inline-rename="true"');
    }
  });
});
