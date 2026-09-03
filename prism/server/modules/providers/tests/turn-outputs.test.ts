import { describe, expect, it } from 'vitest';

import { collectWorkFrames, MAX_FILES_PER_TURN, MAX_TURN_OUTPUT_ENTRIES } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * ej:「产出」卡的**回合归属**。
 *
 * 这张卡此前由前端从"当前加载到的消息窗口"现推,窗口起点常落在某一轮工具流
 * 中间,于是数字会随历史补齐而变(用户两次实测:先「产出 2」变「产出 5」,
 * 加了截断保护之后变成先没有、过一会儿才出现)。改成服务端按**全量历史**算好、
 * 挂到收尾那条助手回答上,卡片才能"和正文一起到达、此后不变"。
 *
 * 下面这些用例就是那句话的判据:挂在哪条消息上、什么时候清空、回滚怎么减、
 * 截断不影响它。
 */
const write = (toolId: string, filePath: string, content = 'a\nb\nc'): NormalizedMessage[] => ([
  { id: toolId, kind: 'tool_use', provider: 'claude', toolName: 'Write', toolId, toolInput: { file_path: filePath, content } } as NormalizedMessage,
  { kind: 'tool_result', provider: 'claude', toolId, content: 'ok' } as NormalizedMessage,
]);
const text = (id: string, role: 'user' | 'assistant', content: string): NormalizedMessage =>
  ({ id, kind: 'text', provider: 'claude', role, content } as NormalizedMessage);

describe('collectWorkFrames · turnOutputs', () => {
  it('产出挂在**收尾的助手回答**上,不挂在用户提问上', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '写两个文件'),
      ...write('w1', '/p/a.md'),
      ...write('w2', '/p/b.md'),
      text('a1', 'assistant', '写好了'),
    ]);
    expect(Object.keys(turnOutputs)).toEqual(['a1']);
    expect(turnOutputs.a1.map((file) => file.path)).toEqual(['/p/a.md', '/p/b.md']);
    expect(turnOutputs.a1[0].addedLines).toBe(3);
  });

  it('每一轮各归各的 —— 第二轮不会把第一轮的文件再算一遍', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '一'), ...write('w1', '/p/a.md'), text('a1', 'assistant', '好'),
      text('u2', 'user', '二'), ...write('w2', '/p/b.md'), text('a2', 'assistant', '好'),
    ]);
    expect(turnOutputs.a1.map((f) => f.path)).toEqual(['/p/a.md']);
    expect(turnOutputs.a2.map((f) => f.path)).toEqual(['/p/b.md']);
  });

  it('这一轮没跑出回答(用户又发了一条)→ 不留半张卡', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '一'), ...write('w1', '/p/a.md'),
      text('u2', 'user', '算了,换一个'), ...write('w2', '/p/b.md'), text('a2', 'assistant', '好'),
    ]);
    expect(Object.keys(turnOutputs)).toEqual(['a2']);
    expect(turnOutputs.a2.map((f) => f.path)).toEqual(['/p/b.md']);
  });

  it('空正文的助手消息不当锚点(工具轮里的空 text 帧很常见)', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '写'), ...write('w1', '/p/a.md'),
      text('a0', 'assistant', '   '),
      ...write('w2', '/p/b.md'), text('a1', 'assistant', '写好了'),
    ]);
    expect(Object.keys(turnOutputs)).toEqual(['a1']);
    expect(turnOutputs.a1.map((f) => f.path)).toEqual(['/p/a.md', '/p/b.md']);
  });

  it('失败的 Write 不算产出', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '写'),
      { id: 'w1', kind: 'tool_use', provider: 'claude', toolName: 'Write', toolId: 'w1', toolInput: { file_path: '/p/bad.md', content: 'x' } } as NormalizedMessage,
      { kind: 'tool_result', provider: 'claude', toolId: 'w1', content: 'EACCES', isError: true } as NormalizedMessage,
      text('a1', 'assistant', '没写成'),
    ]);
    expect(turnOutputs).toEqual({});
  });

  it('Bash/python 写盘走 checkpoint 改动清单,同样计入(但没有行数)', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '跑个脚本'),
      { id: 'c1', kind: 'changed_files', provider: 'claude', cwd: '/p', files: [{ path: 'out.csv', status: 'added' }] } as unknown as NormalizedMessage,
      text('a1', 'assistant', '跑完了'),
    ]);
    expect(turnOutputs.a1).toEqual([{ path: '/p/out.csv', addedLines: null }]);
  });

  it('回滚之后,已经挂上去的那张卡也要跟着减(减空就整条去掉)', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '写'), ...write('w1', '/p/a.md'), text('a1', 'assistant', '好'),
      text('u2', 'user', '撤了'),
      { id: 'r1', kind: 'files_reverted', provider: 'claude', cwd: '/p', paths: ['a.md'] } as unknown as NormalizedMessage,
      text('a2', 'assistant', '已回滚'),
    ]);
    expect(turnOutputs).toEqual({});
  });

  it('同一轮内重写同一个文件只记一条', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '写'), ...write('w1', '/p/a.md'), ...write('w2', '/p/a.md'), text('a1', 'assistant', '好'),
    ]);
    expect(turnOutputs.a1).toHaveLength(1);
  });

  it('帧数截断不影响它 —— 产出在截断**之前**算好', () => {
    const messages: NormalizedMessage[] = [
      text('u1', 'user', '写'), ...write('w1', '/p/first.md'), text('a1', 'assistant', '好'),
      text('u2', 'user', '再写一堆'),
    ];
    for (let index = 0; index < 1600; index += 1) {
      messages.push(...write(`f${index}`, `/p/filler-${index}.md`));
    }
    const { turnOutputs, truncated } = collectWorkFrames(messages);
    expect(truncated).toBe(true);
    expect(turnOutputs.a1.map((f) => f.path)).toEqual(['/p/first.md']);
  });

  it('过渡性正文不偷锚点 —— 整轮的产出都挂在**最后一条**助手正文上(ek 修)', () => {
    // 真实会话里模型在工具之间不停说话("任务 32 完成。任务 33:"),这些
    // 中间正文同样是 kind:'text' role:'assistant';ej 的写法会把产出挂到它们
    // 身上,而它们在前端被吸进活动时间轴当 narration 渲染 —— 卡片谁也看不见。
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '随机测试几个任务'),
      ...write('w1', '/p/urlparse.py'),
      text('n1', 'assistant', '任务 32 完成。任务 33:'),
      ...write('w2', '/p/countdown.sh'),
      text('n2', 'assistant', '任务 33 完成。任务 34:'),
      ...write('w3', '/p/imgthumb.py'),
      text('a1', 'assistant', '目录累计 36 个任务产出。继续第七批还是换方向?'),
    ]);
    expect(Object.keys(turnOutputs)).toEqual(['a1']);
    expect(turnOutputs.a1.map((f) => f.path)).toEqual(['/p/urlparse.py', '/p/countdown.sh', '/p/imgthumb.py']);
  });

  it('日志走完也要结算 —— 刚跑完、还没有下一条用户消息的那一轮全靠这一句', () => {
    const { turnOutputs } = collectWorkFrames([
      text('u1', 'user', '写'), ...write('w1', '/p/a.md'), text('a1', 'assistant', '写好了'),
    ]);
    expect(turnOutputs.a1).toHaveLength(1);
  });

  it('单轮文件数有上限 —— 一次批量写几百个文件不该把卡片和载荷撑爆', () => {
    const messages: NormalizedMessage[] = [text('u1', 'user', '批量写')];
    for (let index = 0; index < MAX_FILES_PER_TURN + 30; index += 1) {
      messages.push(...write(`w${index}`, `/p/f-${index}.md`));
    }
    messages.push(text('a1', 'assistant', '写完了'));
    expect(collectWorkFrames(messages).turnOutputs.a1).toHaveLength(MAX_FILES_PER_TURN);
  });

  it('回合数有上限,不会随会话无限涨', () => {
    const messages: NormalizedMessage[] = [];
    for (let index = 0; index < MAX_TURN_OUTPUT_ENTRIES + 20; index += 1) {
      messages.push(text(`u${index}`, 'user', '写'), ...write(`w${index}`, `/p/${index}.md`), text(`a${index}`, 'assistant', '好'));
    }
    const { turnOutputs } = collectWorkFrames(messages);
    expect(Object.keys(turnOutputs)).toHaveLength(MAX_TURN_OUTPUT_ENTRIES);
  });
});
