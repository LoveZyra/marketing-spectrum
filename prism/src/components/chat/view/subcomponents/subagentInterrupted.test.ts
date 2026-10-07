import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 子代理卡展开区里的步骤行不能永久转圈:ChildStepRow 要拿到"这一步还会不会有结果送来"
 * 的信号,只看"没有 toolResult"的话,回合结束后它会一直转圈,与抬头的「已中断」说反话。
 *
 * 这里没有 DOM 挂不起组件,所以读源码钉住这条接线(判据写对了,信号也得真的传到它)。
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
    // 正文 / 思考那种步骤本来就没有结果,也不该转圈。
    expect(source).toMatch(/const running = !isNarration && !child\.toolResult && stillRunning;/);
    expect(source).toMatch(/const interrupted = !isNarration && !child\.toolResult && !stillRunning;/);
    // 只看有没有结果的写法不能再出现
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
   * 展开区与卡片、抬头共用同一条判据(subagentStillRunning):有后台状态以它为准。
   * 转后台的 Task 一定有 toolResult,只看 isCurrentTurn + toolResult 会把还在后台跑的每一步都标成「已中断」。
   */
  it('信号来自 subagentStillRunning —— 与卡片、抬头同一条判据,转后台的不算中断', () => {
    expect(source).toMatch(/const openStillRunning = openMessage \? subagentStillRunning\(openMessage, isCurrentTurn\) : false;/);
    expect(source).toMatch(/stillRunning=\{openStillRunning\}/);
    expect(source).not.toMatch(/const openStillRunning = isCurrentTurn/);
  });
});
