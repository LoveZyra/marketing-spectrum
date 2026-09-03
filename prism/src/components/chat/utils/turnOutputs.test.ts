import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { displayOutputPath, extractTurnOutputs, turnOutputsFromServer } from './turnOutputs';

const write = (path: string, lines: number, isError = false): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: new Date(),
  isToolUse: true,
  toolName: 'Write',
  toolInput: { file_path: path, content: 'x\n'.repeat(lines) },
  toolResult: { content: 'File written', isError },
} as unknown as ChatMessage);

/**
 * ef:一轮的「产出」卡(设计稿里回答正文下方那张)。判据与会话级那份同源:
 * 成功的 Write、排噪声路径、按路径去重;多带一个写入量。
 */
describe('extractTurnOutputs', () => {
  it('只收成功的 Write,按路径去重,带上「+N 行」', () => {
    const outputs = extractTurnOutputs([
      write('/w/proj/outputs/a.html', 412),
      write('/w/proj/outputs/a.html', 9),          // 同路径重写 → 不重复
      write('/w/proj/outputs/b.csv', 1206),
      write('/w/proj/outputs/failed.md', 3, true), // 失败 → 不算产出(盘上没有)
      write('/w/proj/node_modules/x.js', 5),       // 噪声路径
      write('/w/proj/run.log', 5),                 // 噪声扩展名
    ], '/w/proj');
    expect(outputs.map((file) => file.display)).toEqual(['outputs/a.html', 'outputs/b.csv']);
    // countLines 数的是 split('\n') 的段数,末尾换行会多出一段空行 —— 与
    // 时间轴那一列的口径完全一致(同一个 toolMetric)。
    expect(outputs[0].metric).toBe('+413 行');
    expect(outputs[1].metric).toBe('+1207 行');
  });

  it('子代理里的 Write 同样计入', () => {
    const parent = {
      type: 'assistant',
      content: '',
      timestamp: new Date(),
      isToolUse: true,
      toolName: 'Task',
      toolInput: {},
      toolResult: { content: 'ok', isError: false },
      subagentState: {
        childTools: [
          { toolName: 'Write', toolInput: { file_path: '/w/proj/sub.md', content: 'a\nb\n' }, toolResult: { isError: false } },
        ],
      },
    } as unknown as ChatMessage;
    expect(extractTurnOutputs([parent], '/w/proj').map((file) => file.display)).toEqual(['sub.md']);
  });

  it('没有 Write → 空数组(卡片整个不渲染)', () => {
    expect(extractTurnOutputs([], '/w/proj')).toEqual([]);
  });
});

describe('displayOutputPath', () => {
  it('项目内的走相对路径,项目外的退回文件名', () => {
    expect(displayOutputPath('/w/proj/outputs/a.html', '/w/proj')).toBe('outputs/a.html');
    expect(displayOutputPath('/w/proj/outputs/a.html', '/w/proj/')).toBe('outputs/a.html');
    expect(displayOutputPath('/tmp/elsewhere/a.html', '/w/proj')).toBe('a.html');
    expect(displayOutputPath('C:\\w\\proj\\a.html', 'C:\\w\\proj')).toBe('a.html');
    expect(displayOutputPath('/w/proj/a.html', null)).toBe('a.html');
  });
});

/**
 * ej:服务端那份产出映射的落地。
 *
 * 服务端只给路径 + 行数(它不知道项目根),显示名、噪声过滤、写入量文案都在
 * 这里生成 —— 判据必须和窗口内抽取一致,否则同一个文件在两条路径下长得不一样。
 */
describe('turnOutputsFromServer', () => {
  it('按消息 id 分组,显示名走项目相对路径,行数转成 +N 行', () => {
    const map = turnOutputsFromServer({
      a1: [{ path: '/w/proj/report.md', addedLines: 42 }, { path: '/tmp/plan.md', addedLines: null }],
      a2: [{ path: '/w/proj/src/app.ts', addedLines: 7 }],
    }, '/w/proj');
    expect([...map.keys()]).toEqual(['a1', 'a2']);
    expect(map.get('a1')).toEqual([
      { path: '/w/proj/report.md', display: 'report.md', metric: '+42 行' },
      { path: '/tmp/plan.md', display: 'plan.md', metric: '' },
    ]);
    expect(map.get('a2')?.[0].display).toBe('src/app.ts');
  });

  it('噪声路径照样排掉(与右侧产出表同一套判据)', () => {
    const map = turnOutputsFromServer({
      a1: [
        { path: '/w/proj/node_modules/x/index.js', addedLines: 3 },
        { path: '/w/proj/build.log', addedLines: 3 },
        { path: '/w/proj/.env', addedLines: 3 },
        { path: '/w/proj/keep.py', addedLines: 3 },
      ],
    }, '/w/proj');
    expect(map.get('a1')?.map((file) => file.display)).toEqual(['keep.py']);
  });

  it('一条都不剩的回合不留空卡', () => {
    expect(turnOutputsFromServer({ a1: [{ path: '/w/proj/x.log', addedLines: 1 }] }, '/w/proj').size).toBe(0);
  });

  it('同一路径去重', () => {
    const map = turnOutputsFromServer({ a1: [{ path: '/w/p/a.md', addedLines: 2 }, { path: '/w/p/a.md', addedLines: 9 }] }, '/w/p');
    expect(map.get('a1')).toHaveLength(1);
    expect(map.get('a1')?.[0].metric).toBe('+2 行');
  });

  it('脏数据不抛:null / 数组 / 缺字段 / 行数非法一律安全降级', () => {
    expect(turnOutputsFromServer(null, '/w/p').size).toBe(0);
    expect(turnOutputsFromServer([1, 2], '/w/p').size).toBe(0);
    expect(turnOutputsFromServer('nope', '/w/p').size).toBe(0);
    const map = turnOutputsFromServer({
      a1: [null, 42, { path: '   ' }, { path: '/w/p/a.md', addedLines: Number.NaN }],
      a2: 'not-an-array',
    }, '/w/p');
    expect(map.get('a1')).toEqual([{ path: '/w/p/a.md', display: 'a.md', metric: '' }]);
    expect(map.has('a2')).toBe(false);
  });
});
