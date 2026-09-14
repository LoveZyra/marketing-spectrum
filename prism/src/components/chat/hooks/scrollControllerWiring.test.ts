import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * ga:**滚动控制器与滚动事件之间那几根线,读源码钉住。**
 *
 * 这一轮反复付代价的失败形状是"判据写对了、单测也绿,但真实链路喂给它的
 * 数据不是那个东西":`isLocalNotice` 在写进 store 的第一步被剥掉、
 * 阅读位置补偿收到的是消息条数而不是行数、"用户滚过了"其实是控制器自己写的。
 * 这些都不是纯函数的错,而是**接线**的错 —— 而 vitest 这边没有 DOM,
 * 挂不起这个 hook,纯函数测试永远照不到接线。
 *
 * 所以这里退一步,直接对源码断言那几根线还在:
 *  - 控制器**每一处** `container.scrollTop = ...` 后面都紧跟一句记账;
 *  - 滚动事件用 `isUserInitiatedScroll` 判"这一下是谁滚的";
 *  - 看不见的容器上的滚动事件一律不算数;
 *  - 由不可见变可见的那一帧要按锚点校回去,并把补页循环重新叫起来。
 *
 * 任何一根线被拆掉,这里立刻红。
 */
const source = readFileSync(
  fileURLToPath(new URL('./useChatSessionState.ts', import.meta.url)),
  'utf8',
);

describe('程序化滚动的记账(位置恢复不能被自己的写掐死)', () => {
  it('控制器里每一处写 scrollTop 后面都紧跟一句"读回来记账"', () => {
    /**
     * 控制器那段 layout effect 里的两个写点:跟底与守位。
     * `scrollToBottom`(用户点"回到底部")**故意不记账** —— 那一下是用户的意图,
     * 恢复就该让位,所以它不在这段范围里。
     */
    const controllerStart = source.indexOf('const rows = container.querySelectorAll');
    expect(controllerStart).toBeGreaterThan(0);
    const controller = source.slice(controllerStart);

    const lines = controller.split('\n');
    const writeLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*container\.scrollTop = /.test(line));
    expect(writeLines.length).toBeGreaterThanOrEqual(2);
    for (const { index } of writeLines) {
      // 记账允许隔几行注释,但必须在紧随的这一小段里。
      const following = lines.slice(index + 1, index + 6).join('\n');
      expect(following).toMatch(/programmaticScrollTopRef\.current = container\.scrollTop;/);
    }
  });

  it('滚动事件用 isUserInitiatedScroll 判,不是"有事件就算用户滚的"', () => {
    expect(source).toMatch(/isUserInitiatedScroll\(container\.scrollTop, programmaticScrollTopRef\.current\)/);
    // fz 那一句必须已经不在了 —— 它是把整个恢复功能掐死的那一句。
    expect(source).not.toMatch(/if \(scrollRestoreRef\.current\) scrollRestoreUserMovedRef\.current = true;/);
  });
});

describe('容器不可见时的两道闸', () => {
  it('handleScroll 开头就早退 —— 尺寸全是 0,算出来的结论条条都错', () => {
    const handleScrollStart = source.indexOf('const handleScroll = useCallback');
    expect(handleScrollStart).toBeGreaterThan(0);
    const head = source.slice(handleScrollStart, handleScrollStart + 1600);
    expect(head).toMatch(/if \(!containerIsVisible\(\)\) return;/);
    // 早退必须在这三件事之前发生
    expect(head.indexOf('if (!containerIsVisible()) return;'))
      .toBeLessThan(head.indexOf('const nearBottom = isNearBottom();'));
  });

  it('由不可见变可见:按锚点校回去(hold),隐藏期间被污染的账要清掉', () => {
    expect(source).toMatch(/const becameVisible = !containerWasVisibleRef\.current;/);
    expect(source).toMatch(/containerWasVisibleRef\.current = true;/);
    const branch = source.slice(source.indexOf('if (becameVisible) {'), source.indexOf('if (becameVisible) {') + 400);
    expect(branch).toMatch(/holdAnchorRef\.current = true;/);
    expect(branch).toMatch(/scrollRestoreUserMovedRef\.current = false;/);
    expect(branch).toMatch(/programmaticScrollTopRef\.current = null;/);
  });

  it('补页循环由 ResizeObserver 的"0 → 非 0"重新叫起来,不在无依赖的 layout effect 里 setState', () => {
    // fz 只加了"看不见就别补页",没有任何东西会在"重新看得见"时把循环叫回来 ——
    // 于是在别的页签里点开的会话,切回来只有十来行,而且没有任何出口。
    expect(source).toMatch(/new ResizeObserver\(/);
    const observer = source.slice(source.indexOf('new ResizeObserver('));
    expect(observer.slice(0, 600)).toMatch(/const cameBack = wasEmpty && !isEmpty;/);
    expect(observer.slice(0, 600)).toMatch(/setAutoFillTick\(\(n\) => n \+ 1\);/);
    // 那个没有依赖数组的滚动控制器里不许再有 setState
    const controller = source.slice(source.indexOf('const rows = container.querySelectorAll'));
    const controllerEnd = controller.indexOf('  useEffect(() => {');
    expect(controller.slice(0, controllerEnd)).not.toMatch(/setAutoFillTick/);
  });

  it('控制器早退时把"上次不可见"记下来 —— 不记就永远等不到那个转折点', () => {
    expect(source).toMatch(/if \(!containerIsVisible\(\)\) \{\n\s*containerWasVisibleRef\.current = false;\n\s*return;\n\s*\}/);
  });
});

/**
 * ga:**每一个顶层行都必须带 `data-row-key`,一个都不能漏。**
 *
 * 锚点集合是 `.chat-message[data-row-key]`。漏掉一类行,它就不在锚点集合里 ——
 * "倒数第几行"当场错位,阅读位置落到别处。这一轮已经在 `MessageComponent`
 * 的**压缩摘要那一支**真的漏了一次(props 收下了 `rowKey` 却没往 DOM 上放,
 * 靠 eslint 的"未使用参数"才发现)。所以把它钉住:凡是渲染 `chat-message`
 * 根节点的地方,都要在同一个元素上放 `data-row-key`。
 */
describe('顶层行的 data-row-key', () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  const ROW_COMPONENTS = [
    '../view/subcomponents/MessageComponent.tsx',
    '../view/subcomponents/ActivityTimeline.tsx',
    '../view/subcomponents/SubagentGroupCard.tsx',
  ];

  it.each(ROW_COMPONENTS)('%s:每个 chat-message 根节点都带 data-row-key', (relative) => {
    const componentSource = read(relative);
    // 每一处 `chat-message` 类名(根节点)都要有一个同元素的 data-row-key。
    const roots = (componentSource.match(/className=\{?[`"'][^`"']*chat-message/g) ?? []);
    expect(roots.length).toBeGreaterThan(0);
    const keys = (componentSource.match(/data-row-key=\{rowKey\}/g) ?? []);
    expect(keys.length).toBe(roots.length);
  });

  it('ChatMessagesPane 给三类行都传了 rowKey,而且与 React key 同源', () => {
    const pane = read('../view/subcomponents/ChatMessagesPane.tsx');
    expect(pane).toMatch(/rowKey=\{`subagents-\$\{getGroupKey\(item\)\}`\}/);
    expect(pane).toMatch(/rowKey=\{`activity-\$\{getGroupKey\(item\)\}`\}/);
    expect(pane).toMatch(/rowKey=\{getMessageKey\(item\)\}/);
  });
});
