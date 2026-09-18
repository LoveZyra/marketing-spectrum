import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * ga:**子代理卡展开区里的步骤行不能永久转圈。**
 *
 * fz 给卡片本身和抬头都接上了"这一轮还在不在跑"(`isCurrentTurn`),唯独展开区
 * 里的 `ChildStepRow` 没拿到这个信号 —— 它的判据一直是"没有 `toolResult` 就是
 * 还在跑"。于是卡片抬头显示 ✗「已中断」,点开一看最后一条子步骤还在转圈:
 * 同一张卡上两块牌子说反话(门口牌子翻成"今日打烊",后厨取餐屏还亮着"正在
 * 烹饪中"),而且刷新、明天、下个月翻回这条会话它都还在转。
 *
 * 这里没有 DOM 挂不起组件,所以读源码钉住这条接线 —— 而接线正是这一轮反复
 * 出错的地方(判据写对了,信号到不了它)。
 */
const source = readFileSync(
  fileURLToPath(new URL('./SubagentGroupCard.tsx', import.meta.url)),
  'utf8',
);

describe('ChildStepRow 的"还在跑"判据', () => {
  it('拿到了"这一步还会不会有结果送来"这个入参', () => {
    expect(source).toMatch(/function ChildStepRow\(\{ child, isLast, stillRunning \}/);
    expect(source).toMatch(/stillRunning: boolean;/);
  });

  it('转圈要同时满足"没有结果"和"还在跑" —— 光看没有结果是不够的', () => {
    // ge:再加一条 —— 正文/思考那种步骤本来就没有结果,也不该转圈。
    expect(source).toMatch(/const running = !isNarration && !child\.toolResult && stillRunning;/);
    expect(source).toMatch(/const interrupted = !isNarration && !child\.toolResult && !stillRunning;/);
    // fz 之前那句(只看有没有结果)必须已经不在了
    expect(source).not.toMatch(/const running = !child\.toolResult;/);
  });

  it('中断的步骤画 ✗ 并写明「已中断」,不是留一个空白圆点', () => {
    const rowStart = source.indexOf('function ChildStepRow');
    const rowEnd = source.indexOf('function SubagentCard');
    const row = source.slice(rowStart, rowEnd);
    expect(row).toMatch(/\) : interrupted \? \(/);
    expect(row).toMatch(/activity\.interrupted/);
  });

  /**
   * gh:展开区与卡片、抬头共用同一条判据(subagentStillRunning):有后台状态以它为准。
   * 此前展开区只看 isCurrentTurn + toolResult,转后台的 Task 一定有 toolResult,
   * 于是抬头「1 个进行中」、卡片转圈、点开每一步都是 ✗「已中断」。
   */
  it('信号来自 subagentStillRunning —— 与卡片、抬头同一条判据,转后台的不算中断', () => {
    expect(source).toMatch(/const openStillRunning = openMessage \? subagentStillRunning\(openMessage, isCurrentTurn\) : false;/);
    expect(source).toMatch(/stillRunning=\{openStillRunning\}/);
    expect(source).not.toMatch(/const openStillRunning = isCurrentTurn/);
  });
});
