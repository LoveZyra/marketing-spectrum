import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 钉住子代理卡真的用上了后台状态。
 *
 * 数据归到 `subagentState.background` 由 subagentBackground.test.ts 测(跑的是真实转换链路);
 * 组件若只读 `childTools.length` / `toolResult`,转后台的任务会显示成已完成、步数停在转后台时。
 * vitest 这边没有 DOM 挂不起组件,读源码钉住这几根线。
 */
const source = readFileSync(
  fileURLToPath(new URL('./SubagentGroupCard.tsx', import.meta.url)),
  'utf8',
);

describe('子代理卡的后台状态', () => {
  it('完成与否以后台状态为准 —— "running in the background" 的 tool_result 不算完成', () => {
    expect(source).toMatch(/const background = message\.subagentState\?\.background;/);
    expect(source).toMatch(/const isComplete = background\s*\n\s*\? background\.status !== 'running'/);
  });

  it('步数取两个来源的最大值 —— 用 ?? 会让一条早到的进展帧盖掉已收到的步数', () => {
    // 转后台之后子代理的 tool_use / tool_result 仍会实时转发(SDK 默认行为),不能用 ??
    // 让后台计数盖掉 childTools;判据在 subagentToolStepCount(只数工具步、取两个来源的最大值)。
    expect(source).toMatch(/const stepCount = subagentToolStepCount\(message\);/);
    expect(source).toMatch(/t\('subagent\.steps', \{ count: stepCount/);
    expect(source).not.toMatch(/t\('subagent\.steps', \{ count: childTools\.length/);
  });

  it('正文与思考渲染成叙述行,不转圈、不标已中断', () => {
    expect(source).toMatch(/const isNarration = child\.kind === 'text' \|\| child\.kind === 'thinking';/);
    expect(source).toMatch(/const running = !isNarration && !child\.toolResult && stillRunning;/);
  });

  it('在后台跑着的不许被标成「已中断」', () => {
    expect(source).toMatch(/const isInterrupted = !isComplete && !isCurrentTurn && !background;/);
  });

  it('抬头的总步数同样取最大值,「N 个进行中」跟着后台状态走', () => {
    expect(source).toMatch(/const stepCountOf = \(message: ChatMessage\) => subagentToolStepCount\(message\);/);
    expect(source).toMatch(/const runningCount = group\.messages\.filter\(\(message\) => subagentStillRunning\(message, isCurrentTurn\)\)\.length;/);
  });

  it('展开区不再是一个独立的白盒子 —— 接在轴上', () => {
    expect(source).toMatch(/<div className="mt-1 border-l border-border pl-3">/);
    expect(source).not.toMatch(/<div className="mt-2 rounded-lg border border-border bg-background p-3">/);
  });

  /**
   * 展开区只剩这个子代理自己的那根轴:不贴后台任务的 summary 大块,也不贴「子代理汇报」全文。
   */
  it('展开区不再贴后台任务的 summary 大块', () => {
    expect(source).not.toMatch(/subagentState\?\.background\?\.summary/);
  });

  it('展开区不再贴「子代理汇报」全文', () => {
    expect(source).not.toMatch(/subagent\.resultLabel/);
    expect(source).not.toMatch(/openResultText/);
    // 随之无用的引入也得摘掉,否则 eslint 基线会涨
    expect(source).not.toMatch(/ClampedBlock/);
    expect(source).not.toMatch(/from '\.\/Markdown'/);
  });

  it('失败原因保留 —— 这根轴上唯一"不说就丢了"的信息', () => {
    expect(source).toMatch(/openMessage\.toolResult\?\.isError && \(/);
  });

  it('跑完之后抬头补一句耗时,而不是另起一段', () => {
    expect(source).toMatch(/const doneSeconds = background && background\.status !== 'running'/);
    expect(source).toMatch(/t\('subagent\.elapsed', \{ seconds: doneSeconds/);
  });

  /**
   * 子代理的长叙述(正文 / 思考)默认折叠。判据本身在 toolRowSummary(纯函数,单独测),
   * 这里只钉"卡片真的用了它"。
   */
  it('长叙述默认折起来 —— 判据取自 shouldFoldNarration,不是就地又写一遍', () => {
    expect(source).toMatch(/const foldable = shouldFoldNarration\(body\);/);
    expect(source).toMatch(/const \[narrationOpen, setNarrationOpen\] = useState\(false\);/);
    // 默认值必须是"折着"
    expect(source).not.toMatch(/useState\(true\)/);
  });

  it('折起来时只露一行,展开才铺全文', () => {
    expect(source).toMatch(/narrationOpen \? 'whitespace-pre-wrap' : 'line-clamp-1'/);
    expect(source).toMatch(/\{narrationOpen \? body : firstLine\}/);
  });

  it('一行放得下的叙述不加箭头 —— 不折就原样铺开', () => {
    expect(source).toMatch(/if \(!foldable\) \{/);
  });
});
