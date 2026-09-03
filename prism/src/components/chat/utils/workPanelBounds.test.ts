import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import {
  extractSessionOutputs,
  foldEarlierOutputs,
  MAX_SESSION_OUTPUTS,
  OUTPUT_FOLD_THRESHOLD,
} from './sessionOutputs';
import { extractSessionChecklist, MAX_CHECKLIST_ITEMS } from './taskChecklist';

/**
 * dw:工作面板两张表的"不会无限长"不变量。
 *
 * 两张表都是**会话级只增不减**的:任务 id 在会话内单调递增、永不撞号,产出
 * 按路径去重、只在回滚时才减。既没有按时间过期,也没有上限 —— 一个会话跑
 * 得够久,两张表就一直长下去,右栏越来越长、每回合结束还要把全量重折一遍。
 * 这里把上限钉住:超了**丢最早的、留最近的**(最近的才是用户在看的)。
 */

const taskCreate = (id: number, subject: string): ChatMessage => ({
  isToolUse: true,
  toolName: 'TaskCreate',
  toolInput: { subject },
  toolResult: { content: `Task #${id} created successfully: ${subject}` },
} as unknown as ChatMessage);

const write = (path: string): ChatMessage => ({
  isToolUse: true,
  toolName: 'Write',
  toolInput: { file_path: path },
  toolResult: { content: 'ok' },
} as unknown as ChatMessage);

describe('任务清单上限', () => {
  it('没触顶时一条不少', () => {
    const messages = Array.from({ length: 12 }, (_, i) => taskCreate(i + 1, `任务${i + 1}`));
    expect(extractSessionChecklist(messages)).toHaveLength(12);
  });

  it('触顶后只留最近的 —— 丢的是会话开头那批', () => {
    const total = MAX_CHECKLIST_ITEMS + 40;
    const messages = Array.from({ length: total }, (_, i) => taskCreate(i + 1, `任务${i + 1}`));
    const items = extractSessionChecklist(messages)!;
    expect(items).toHaveLength(MAX_CHECKLIST_ITEMS);
    // 保留的是尾部:最后一条一定在,第一条一定不在。
    expect(items[items.length - 1].content).toBe(`任务${total}`);
    expect(items.some((item) => item.content === '任务1')).toBe(false);
  });
});

describe('产出文件上限', () => {
  it('没触顶时一条不少,且保持首次出现的顺序', () => {
    const messages = [write('/w/a.md'), write('/w/b.md'), write('/w/a.md')];
    expect(extractSessionOutputs(messages).map((f) => f.name)).toEqual(['a.md', 'b.md']);
  });

  it('触顶后只留最近的', () => {
    const total = MAX_SESSION_OUTPUTS + 25;
    const messages = Array.from({ length: total }, (_, i) => write(`/w/f${i + 1}.md`));
    const files = extractSessionOutputs(messages);
    expect(files).toHaveLength(MAX_SESSION_OUTPUTS);
    expect(files[files.length - 1].name).toBe(`f${total}.md`);
    expect(files.some((file) => file.name === 'f1.md')).toBe(false);
  });

  it('上限按去重后的条数算 —— 反复重写同一个文件不会把别的挤掉', () => {
    const messages = [
      ...Array.from({ length: MAX_SESSION_OUTPUTS * 2 }, () => write('/w/loop.md')),
      write('/w/tail.md'),
    ];
    const files = extractSessionOutputs(messages);
    expect(files.map((f) => f.name)).toEqual(['loop.md', 'tail.md']);
  });
});

describe('产出表折叠', () => {
  it('没超过阈值时不折,hidden 为 0', () => {
    const files = Array.from({ length: OUTPUT_FOLD_THRESHOLD }, (_, i) => write(`/w/f${i + 1}.md`));
    const { visible, hidden } = foldEarlierOutputs(extractSessionOutputs(files), false);
    expect(hidden).toBe(0);
    expect(visible).toHaveLength(OUTPUT_FOLD_THRESHOLD);
  });

  it('超了只露最近的,且顺序不变 —— 最新的仍在最后一条', () => {
    const total = OUTPUT_FOLD_THRESHOLD + 12;
    const files = extractSessionOutputs(
      Array.from({ length: total }, (_, i) => write(`/w/f${i + 1}.md`)),
    );
    const { visible, hidden } = foldEarlierOutputs(files, false);
    expect(hidden).toBe(12);
    expect(visible).toHaveLength(OUTPUT_FOLD_THRESHOLD);
    expect(visible[visible.length - 1].name).toBe(`f${total}.md`);
    expect(visible[0].name).toBe(`f${total - OUTPUT_FOLD_THRESHOLD + 1}.md`);
  });

  it('展开时一条不少,hidden 仍报实际折起来的条数(按钮文案要用)', () => {
    const total = OUTPUT_FOLD_THRESHOLD + 5;
    const files = extractSessionOutputs(
      Array.from({ length: total }, (_, i) => write(`/w/f${i + 1}.md`)),
    );
    const { visible, hidden } = foldEarlierOutputs(files, true);
    expect(visible).toHaveLength(total);
    expect(hidden).toBe(5);
  });
});
