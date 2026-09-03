import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { extractSessionOutputs, isDeliverablePath } from './sessionOutputs';

const writeMessage = (filePath: unknown, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    type: 'assistant',
    content: '',
    timestamp: new Date(),
    isToolUse: true,
    toolName: 'Write',
    toolInput: JSON.stringify({ file_path: filePath, content: 'x' }),
    toolResult: { content: 'File created successfully', isError: false },
    ...overrides,
  }) as ChatMessage;

describe('extractSessionOutputs', () => {
  it('按首次出现的顺序收集 Write 出的可交付文件,重写不重复', () => {
    const outputs = extractSessionOutputs([
      writeMessage('/home/u/proj/报告.md'),
      writeMessage('/home/u/proj/script.py'),
      writeMessage('/home/u/proj/数据.xlsx'),
      writeMessage('/home/u/proj/报告.md'),
    ]);
    expect(outputs.map((file) => file.name)).toEqual(['报告.md', 'script.py', '数据.xlsx']);
    expect(outputs[0].path).toBe('/home/u/proj/报告.md');
  });

  it('toolInput 已是对象、Windows 分隔符都可读;坏输入跳过', () => {
    const outputs = extractSessionOutputs([
      writeMessage(null, {
        toolInput: { file_path: 'C:\\work\\总结.html' } as unknown as string,
      }),
      writeMessage(null, { toolInput: '{broken' }),
      writeMessage(123),
      { type: 'user', content: 'hi', timestamp: new Date() } as ChatMessage,
    ]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].name).toBe('总结.html');
  });

  it('非 Write 工具不收;代码文件现在算产出(dr 策略反转)', () => {
    const outputs = extractSessionOutputs([
      writeMessage('/p/gen_users.py'),
      writeMessage('/p/b.md', { toolName: 'Edit' }),
    ]);
    expect(outputs.map((file) => file.name)).toEqual(['gen_users.py']);
  });

  it('未执行完的 Write 不算产出:审批挂起(无结果)与失败(isError)都不列', () => {
    expect(extractSessionOutputs([
      writeMessage('/p/待批.md', { toolResult: null }),
      writeMessage('/p/失败.md', { toolResult: { content: 'denied', isError: true } }),
      writeMessage('/p/成功.md'),
    ]).map((file) => file.name)).toEqual(['成功.md']);
  });

  it('子代理 childTools 里的成功 Write 计入;基线+窗口重叠重放幂等', () => {
    const container = {
      type: 'assistant',
      content: '',
      timestamp: new Date(),
      isToolUse: true,
      toolName: 'Agent',
      toolInput: '{}',
      subagentState: {
        childTools: [{
          toolId: 'w1',
          toolName: 'Write',
          toolInput: { file_path: '/p/子代理报告.md' },
          toolResult: { content: 'ok', isError: false },
          timestamp: new Date(),
        }],
        currentToolIndex: 0,
        isComplete: true,
      },
    } as unknown as ChatMessage;
    const messages = [container, writeMessage('/p/主报告.md')];
    const once = extractSessionOutputs(messages);
    expect(once.map((file) => file.name)).toEqual(['子代理报告.md', '主报告.md']);
    expect(extractSessionOutputs([...messages, ...messages])).toEqual(once);
  });
});

describe('isDeliverablePath', () => {
  it('dr 反转:新建文件默认都算(含代码与无扩展名),只排噪声', () => {
    expect(isDeliverablePath('/p/报告.PDF')).toBe(true);
    expect(isDeliverablePath('/p/main.tsx')).toBe(true);
    expect(isDeliverablePath('/p/wordcount.sh')).toBe(true);
    expect(isDeliverablePath('/p/Makefile')).toBe(true);
    // 噪声:中间产物扩展名 / 依赖与构建目录 / 隐藏文件
    expect(isDeliverablePath('/p/x.tmp')).toBe(false);
    expect(isDeliverablePath('/p/debug.log')).toBe(false);
    expect(isDeliverablePath('/p/node_modules/a/b.js')).toBe(false);
    expect(isDeliverablePath('C:\\proj\\__pycache__\\m.pyc')).toBe(false);
    expect(isDeliverablePath('/p/.env')).toBe(false);
  });
});
