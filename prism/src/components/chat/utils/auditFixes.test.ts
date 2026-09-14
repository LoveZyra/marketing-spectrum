import { describe, expect, it } from 'vitest';

import { mergeTurnOutputs, type TurnOutputFile } from './turnOutputs';
import { resolveReadingSpot } from './messageWindow';

const file = (path: string) => ({ path, name: path.split('/').pop() ?? path, display: path, metric: '' }) as unknown as TurnOutputFile;

/**
 * fz:一轮里有两段工具流时,前一段写出的文件不许被覆盖掉。
 *
 * `ChatMessagesPane` 里工具组分支原来是**赋值**,而紧邻的子代理分支是**累加** ——
 * 同一个变量两种语义。于是「工具组 A 写报告 → 子代理各写一章 → 工具组 B 写汇总」
 * 这一轮,B 一行就把前面攒的全覆盖掉,回答下面的产出卡只剩一个文件。
 */
describe('mergeTurnOutputs', () => {
  it('**累加,不是覆盖**', () => {
    const a = [file('/p/报告.md')];
    const b = [file('/p/汇总.md')];
    expect(mergeTurnOutputs(a, b).map((f) => f.path)).toEqual(['/p/报告.md', '/p/汇总.md']);
  });

  it('同一个文件不重复', () => {
    const a = [file('/p/报告.md')];
    expect(mergeTurnOutputs(a, [file('/p/报告.md')])).toBe(a);
  });

  it('**没有新东西就原样返回旧引用** —— 这一句是给 memo 用的', () => {
    const a = [file('/p/报告.md')];
    expect(mergeTurnOutputs(a, [])).toBe(a);
    expect(mergeTurnOutputs(a, [file('/p/报告.md')])).toBe(a);
  });

  it('本来是空的就直接用新那份的引用(extractTurnOutputsCached 的稳定引用)', () => {
    const b = [file('/p/汇总.md')];
    expect(mergeTurnOutputs([], b)).toBe(b);
  });

  it('三段依次并进来,顺序按发生先后', () => {
    let acc: TurnOutputFile[] = [];
    acc = mergeTurnOutputs(acc, [file('/p/大纲.md')]);
    acc = mergeTurnOutputs(acc, [file('/p/一.md'), file('/p/二.md')]);
    acc = mergeTurnOutputs(acc, [file('/p/汇总.md')]);
    expect(acc.map((f) => f.path)).toEqual(['/p/大纲.md', '/p/一.md', '/p/二.md', '/p/汇总.md']);
  });
});

/**
 * ga:**阅读位置改成按行的稳定标识找回。**
 *
 * fz 那版用"离开与回来之间的**消息条数差**"去补偿追加的行,而
 * `indexFromEnd`/`rowCount` 数的是 **DOM 行** —— 60 次工具调用是 61 条消息、
 * 渲染出来只有 1 行,补偿反而把落点推出去几十行。单位不同的两个量不能相减。
 *
 * 现在顶层行都带 `data-row-key`,直接按它找;老记录没有标识才退回下标。
 */
describe('resolveReadingSpot 按标识找回', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const keyAt = (i: number) => keys[i];

  it('**按标识精确落位** —— 尾部追加了多少行都不影响', () => {
    const spot = { rowKey: 'b', indexFromEnd: 3, offset: -18 };
    expect(resolveReadingSpot(spot, keys.length, keyAt)).toEqual({ rowIndex: 1, offset: -18 });
    // 后台又追加了两行:标识还在,落点仍然是那一行
    const grown = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(resolveReadingSpot(spot, grown.length, (i) => grown[i]))
      .toEqual({ rowIndex: 1, offset: -18 });
  });

  it('**那一行不在窗口里了 → 放弃守位**(下标兜底也不会更准)', () => {
    const spot = { rowKey: '不在了', indexFromEnd: 3, offset: 0 };
    expect(resolveReadingSpot(spot, keys.length, keyAt)).toBeNull();
  });

  it('老记录没有标识 → 退回倒数下标,且**不做任何补偿**', () => {
    expect(resolveReadingSpot({ indexFromEnd: 3, offset: 5 }, 10, keyAt))
      .toEqual({ rowIndex: 6, offset: 5 });
  });

  it('老记录的下标越界 → null(不许把视口钉到算不出来的地方)', () => {
    expect(resolveReadingSpot({ indexFromEnd: 10, offset: 0 }, 10)).toBeNull();
    expect(resolveReadingSpot({ indexFromEnd: -1, offset: 0 }, 10)).toBeNull();
  });

  it('没记过 / 一行都没有 / 脏偏移 → null', () => {
    expect(resolveReadingSpot(null, 10, keyAt)).toBeNull();
    expect(resolveReadingSpot({ rowKey: 'a', indexFromEnd: 0, offset: 0 }, 0, keyAt)).toBeNull();
    expect(resolveReadingSpot({ rowKey: 'a', indexFromEnd: 0, offset: Number.NaN }, 5, keyAt)).toBeNull();
  });

  it('同一个标识出现多次(理论上不该有)→ 取最靠后的那个,不炸', () => {
    const dup = ['a', 'b', 'a'];
    expect(resolveReadingSpot({ rowKey: 'a', indexFromEnd: 0, offset: 0 }, dup.length, (i) => dup[i]))
      .toEqual({ rowIndex: 2, offset: 0 });
  });
});
