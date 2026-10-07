/**
 * 侧栏会话「改名」那一行的版面:编辑态的输入框顶替整行,而不是浮在标题行上面;
 * 两者同时渲染的话,输入框左边会露出半截旧名字。
 *
 * 这是 class 与 JSX 结构的事,跑起来才发现就太晚了,所以对源码断言。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'SidebarSessionItem.tsx'), 'utf8');

/** 桌面端那一块:`hidden md:block` 开始,到组件结束。 */
const desktopBlock = (() => {
  const at = source.indexOf('<div className="hidden md:block">');
  expect(at, '找不到桌面端那一块').toBeGreaterThan(-1);
  return source.slice(at);
})();

/** 编辑态分支:`{isEditing ? (` 到 `) : (` 为止。 */
const editingBranch = (() => {
  const at = desktopBlock.indexOf('{isEditing ? (');
  expect(at, '桌面端那一块里找不到 isEditing 分支').toBeGreaterThan(-1);
  const end = desktopBlock.indexOf('\n        ) : (', at);
  expect(end, 'isEditing 分支没有收尾').toBeGreaterThan(at);
  return desktopBlock.slice(at, end);
})();

/** 非编辑分支:`) : (` 之后。 */
const idleBranch = desktopBlock.slice(desktopBlock.indexOf('\n        ) : ('));

describe('侧栏会话改名:输入框顶替整行', () => {
  it('编辑态里没有那条标题 <a>', () => {
    // 标题与输入框同时渲染,旧名字就会露在输入框左边。
    expect(editingBranch).not.toContain('<a');
    expect(editingBranch).not.toContain('sessionView.sessionName');
  });

  it('标题行与三个行内按钮只活在非编辑分支里', () => {
    expect(idleBranch).toContain('<a');
    expect(idleBranch).toContain('{sessionView.sessionName}');
    expect(idleBranch).toContain("t('tooltips.editSessionName')");
    expect(idleBranch).toContain("t('tooltips.exportSession'");
    expect(idleBranch).toContain("t('tooltips.deleteSessionOptions'");
  });

  it('编辑行是整行流式布局,不是绝对定位的浮层', () => {
    expect(editingBranch).not.toContain('absolute');
    expect(editingBranch).toContain('w-full');
    // 输入框吃掉剩余宽度,两枚按钮不被压扁
    expect(editingBranch).toMatch(/className="h-6 min-w-0 flex-1[^"]*"/);
    expect((editingBranch.match(/h-6 w-6 flex-none/g) ?? []).length).toBe(2);
  });

  it('行高与未编辑时一致,列表不跳', () => {
    // 未编辑:py-[7px] + leading-[17px] = 31px
    expect(idleBranch).toContain('py-[7px]');
    expect(idleBranch).toContain('leading-[17px]');
    expect(editingBranch).toContain('h-[31px]');
    // 左内边距也要对齐,否则输入框比标题往里缩一截
    expect(editingBranch).toContain('px-2.5');
    expect(idleBranch).toContain('px-2.5');
  });

  it('保存 / 取消两枚按钮还在,点外面仍然能关', () => {
    expect(editingBranch).toContain("t('tooltips.save')");
    expect(editingBranch).toContain("t('tooltips.cancel')");
    // 外点关闭靠这个 ref,挪了位置不能把它丢了
    expect(editingBranch).toContain('ref={editingContainerRef}');
  });

  it('输入框有无障碍名字', () => {
    expect(editingBranch).toMatch(/aria-label=\{t\('tooltips\.editSessionName'\)\}/);
  });
});
