/**
 * 侧栏「项目改名」那一行。
 *
 * gq:会话行修完之后回头看项目行 —— **没有**会话行那个"旧名字露在旁边"的病
 * (这里的输入框本来就是顶替标题的,悬停浮层也被 `!isEditing` 关掉了),
 * 但另外三条是真的:
 *
 *  1. **点行外关不掉** —— 只有 Enter / Esc / ✓ / ✕ 四条出路,点到别处那一行
 *     就一直停在编辑态(会话行早就有点外关闭);
 *  2. **点进输入框会把项目折叠/展开一次** —— 整行是个 `<Button>`,桌面端那个
 *     输入框没拦 click,点进去改个错字项目就在脚下动一下;
 *  3. **改名时行高从 36px 涨到 ~70px** —— 编辑分支里输入框下面还挂了一行完整
 *     路径,而这一行的既定设计是"完整路径进 title,不再占第二行"。
 *
 * 版面与事件穿透都是 class / JSX 结构的事,跑起来才发现就太晚了,所以对源码断言。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'SidebarProjectItem.tsx'), 'utf8');

/** 桌面行:`<Button` 到 `</Button>`。 */
const desktopRow = (() => {
  const at = source.indexOf('<Button\n          ref={desktopRowRef}');
  expect(at, '找不到桌面端项目行').toBeGreaterThan(-1);
  const end = source.indexOf('</Button>', at);
  return source.slice(at, end);
})();

/** 桌面行里**名字那一格**的编辑分支:`{isEditing ? (` 到它自己的 `) : (`。 */
const desktopEditing = (() => {
  const at = desktopRow.indexOf('{isEditing ? (');
  expect(at, '桌面行里找不到 isEditing 分支').toBeGreaterThan(-1);
  const end = desktopRow.indexOf(') : (', at);
  expect(end, 'isEditing 分支没有收尾').toBeGreaterThan(at);
  return desktopRow.slice(at, end);
})();

describe('项目改名:点行外关闭', () => {
  it('挂了 mousedown 监听,落在行外就取消', () => {
    expect(source).toContain("document.addEventListener('mousedown', handlePointerDown)");
    expect(source).toContain('onCancelEditingProject();');
    // 只在编辑态挂,且卸载时摘掉
    expect(source).toMatch(/if \(!isEditing\) \{\s*return;\s*\}/);
    expect(source).toContain("document.removeEventListener('mousedown', handlePointerDown)");
  });

  it('手机卡片与桌面行两个容器都算"行内"', () => {
    expect(source).toContain('ref={mobileRowRef}');
    expect(source).toContain('ref={desktopRowRef}');
    expect(source).toContain('mobileRowRef.current?.contains(target)');
    expect(source).toContain('desktopRowRef.current?.contains(target)');
  });

  it('点外面是取消,不是保存', () => {
    const handler = source.slice(
      source.indexOf('const handlePointerDown'),
      source.indexOf("document.addEventListener('mousedown'"),
    );
    expect(handler).toContain('onCancelEditingProject()');
    expect(handler, '误点一下就改名,比丢几个字糟得多').not.toContain('saveProjectName');
  });
});

describe('项目改名:不穿透到整行的点击', () => {
  it('桌面端输入框拦住 click 与 keydown', () => {
    const input = desktopEditing;
    expect(input).toContain('onClick={(event) => event.stopPropagation()}');
    expect(input).toMatch(/onKeyDown=\{\(event\) => \{\s*event\.stopPropagation\(\);/);
  });

  it('两个输入框都带行内改名标记(全局 Esc 靠它放行)', () => {
    expect((source.match(/data-inline-rename="true"/g) ?? []).length).toBe(2);
  });
});

describe('项目改名:行高不跳', () => {
  it('编辑分支是单行,完整路径进 title', () => {
    const editing = desktopEditing;
    // 完整路径只以 title 的形式出现一次 —— 再出现一次就是又挂了一行文本
    expect(editing).toContain('title={project.fullPath}');
    expect(
      (editing.match(/\{project\.fullPath\}/g) ?? []).length,
      '第二行的完整路径是行高翻倍的原因',
    ).toBe(1);
    // 注意查的是 className 里的,不是注释里提到的
    expect(editing).not.toMatch(/className="[^"]*space-y-1/);
  });

  it('输入框 26px + 编辑态补偿内边距,前后都是 36px', () => {
    expect(desktopRow).toContain('h-[26px]');
    // 非编辑:20px 内容 + py-2(8+8) = 36;编辑:26 + py-[5px](5+5) = 36
    expect(desktopRow).toContain('py-2');
    expect(desktopRow).toContain("isEditing && 'py-[5px]'");
  });
});

describe('项目改名:原本就没有"旧名字露在旁边"的病', () => {
  it('输入框顶替标题,不是浮在上面', () => {
    const editing = desktopEditing;
    expect(editing).not.toContain('absolute');
    expect(editing).not.toContain('{project.displayName}');
  });

  it('悬停浮层在编辑态被整个关掉', () => {
    expect(desktopRow).toContain('{!isEditing && !selectionMode && (');
  });
});
