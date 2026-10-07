import { describe, expect, it } from 'vitest';

import { collectWorkFrames, MAX_WORK_FRAMES } from '../services/sessions.service';

/**
 * 工作帧响应的载荷上限。
 *
 * 这个接口在会话切换、每个回合结束时都要拉一次,不设上限的话长会话的载荷只增不减。
 * 截断规则有两条必须钉死:
 *  1. 保留尾部(当前清单状态、最近的产出都在尾部);
 *  2. revertedPaths 按全量算,否则"这个文件已经回滚了"这条结论会因截断而丢失,
 *     已回滚的文件又冒回面板里。
 */

type Msg = Record<string, unknown>;

const write = (n: number): Msg => ({
  kind: 'tool_use',
  id: `w${n}`,
  toolName: 'Write',
  toolInput: { file_path: `/w/f${n}.md` },
  toolResult: { content: 'ok' },
});

describe('工作帧截断', () => {
  it('没触顶时原样返回,不带 truncated', () => {
    const { frames, truncated } = collectWorkFrames(
      Array.from({ length: 10 }, (_, i) => write(i + 1)) as never,
    );
    expect(frames).toHaveLength(10);
    expect(truncated).toBeUndefined();
  });

  it('触顶后留尾部并置 truncated', () => {
    const total = MAX_WORK_FRAMES + 30;
    const { frames, truncated } = collectWorkFrames(
      Array.from({ length: total }, (_, i) => write(i + 1)) as never,
    );
    expect(truncated).toBe(true);
    expect(frames).toHaveLength(MAX_WORK_FRAMES);
    const last = frames[frames.length - 1].toolInput as { file_path: string };
    expect(last.file_path).toBe(`/w/f${total}.md`);
    // 头部被丢掉的那一批确实不在了。
    expect(frames.some((f) => (f.toolInput as { file_path?: string })?.file_path === '/w/f1.md')).toBe(false);
  });

  it('已回滚的路径不因截断而丢失 —— 回滚记录在会话开头也算数', () => {
    const messages: Msg[] = [
      write(1),
      { kind: 'files_reverted', cwd: '/w', paths: ['f1.md'] },
      ...Array.from({ length: MAX_WORK_FRAMES + 30 }, (_, i) => write(i + 100)),
    ];
    const { revertedPaths, truncated } = collectWorkFrames(messages as never);
    expect(truncated).toBe(true);
    expect(revertedPaths).toContain('/w/f1.md');
  });

  it('回滚删掉尾部的帧后,窗口由更早的帧补满', () => {
    const messages: Msg[] = [
      ...Array.from({ length: MAX_WORK_FRAMES + 10 }, (_, i) => write(i + 1)),
      { kind: 'files_reverted', cwd: '/w', paths: [`f${MAX_WORK_FRAMES + 10}.md`, 'f1.md'] },
    ];
    const { frames, truncated, revertedPaths } = collectWorkFrames(messages as never);
    expect(truncated).toBe(true);
    const paths = frames.map((frame) => (frame.toolInput as { file_path: string }).file_path);
    // f2..f1509 留得下来,共 1508 帧;尾部 1500 帧从 f10 起。
    expect(paths).toHaveLength(MAX_WORK_FRAMES);
    expect(paths[0]).toBe('/w/f10.md');
    expect(paths[paths.length - 1]).toBe(`/w/f${MAX_WORK_FRAMES + 9}.md`);
    expect(revertedPaths).toEqual([`/w/f${MAX_WORK_FRAMES + 10}.md`, '/w/f1.md']);
  });

  it('写过的帧超过上限、回滚之后剩下的没超:全部下发,不报截断', () => {
    const messages: Msg[] = [
      write(1),
      ...Array.from({ length: MAX_WORK_FRAMES + 10 }, (_, i) => ({ ...write(i + 2), toolInput: { file_path: `/w/hot${i % 5}.md` } })),
      { kind: 'files_reverted', cwd: '/w', paths: ['hot0.md', 'hot1.md', 'hot2.md', 'hot3.md', 'hot4.md'] },
    ];
    const { frames, truncated } = collectWorkFrames(messages as never);
    expect(truncated).toBeUndefined();
    expect(frames.map((frame) => frame.id)).toEqual(['w1']);
  });
});

/**
 * 收集时只留尾部那一段,结果必须和"正着收齐所有帧、遇到回滚删掉此前同一文件的帧、最后切尾部"
 * 逐帧一致(帧、回合号、截断标记,以及 revertedPaths / turnOutputs / userTurns)。
 * `referenceCollect` 就是后一种写法,用随机生成的长历史(超过上限、夹着回滚、插话、
 * changed_files、失败和在途的写入)对拍。
 */
describe('只留尾部的收集与收齐再切逐帧一致', () => {
  type Frame = { id?: string; kind?: string; toolName: string; toolInput: unknown; resultContent: string | null; resultIsError: boolean; turn?: number };
  const WORK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'Write']);
  const filePathOf = (frame: Frame) => {
    const input = frame.toolInput as { file_path?: unknown } | null;
    return typeof input?.file_path === 'string' ? input.file_path : null;
  };

  function referenceCollect(messages: Msg[]) {
    const results = new Map<string, { content?: string; isError?: boolean }>();
    for (const m of messages) {
      if (m.kind === 'tool_result' && m.toolId) results.set(m.toolId as string, { content: m.content as string, isError: m.isError as boolean });
    }
    const frames: Frame[] = [];
    const reverted = new Set<string>();
    const turnOutputs: Record<string, Array<{ path: string; addedLines: number | null }>> = {};
    let pending: Array<{ path: string; addedLines: number | null }> = [];
    let anchor = '';
    let userTurn = 0;
    const flush = () => {
      if (anchor && pending.length > 0) {
        turnOutputs[anchor] = pending;
        const keys = Object.keys(turnOutputs);
        if (keys.length > 500) delete turnOutputs[keys[0]];
      }
      pending = [];
      anchor = '';
    };
    const noteWrite = (path: string | null, content: unknown) => {
      if (!path || pending.length >= 50 || pending.some((file) => file.path === path)) return;
      pending.push({ path, addedLines: typeof content === 'string' && content ? content.split('\n').length : null });
    };
    const dropWrite = (path: string) => {
      pending = pending.filter((file) => file.path !== path);
      for (const key of Object.keys(turnOutputs)) {
        const kept = turnOutputs[key].filter((file) => file.path !== path);
        if (kept.length === 0) delete turnOutputs[key];
        else turnOutputs[key] = kept;
      }
    };
    for (const m of messages) {
      if (m.kind === 'files_reverted') {
        const cwd = typeof m.cwd === 'string' && m.cwd ? m.cwd.replace(/[\\/]+$/, '') : '';
        for (const entry of m.paths as unknown[]) {
          if (typeof entry !== 'string' || !entry.trim()) continue;
          const absolute = cwd ? `${cwd}/${entry.trim()}` : entry.trim();
          reverted.add(absolute);
          dropWrite(absolute);
          for (let index = frames.length - 1; index >= 0; index -= 1) {
            if (filePathOf(frames[index]) === absolute) frames.splice(index, 1);
          }
        }
        continue;
      }
      if (m.kind === 'changed_files') {
        const cwd = typeof m.cwd === 'string' && m.cwd ? m.cwd : '';
        for (const entry of m.files as Array<{ path?: unknown; status?: unknown; untracked?: unknown }>) {
          const relPath = typeof entry.path === 'string' ? entry.path.trim() : '';
          if (!relPath || (entry.status !== 'added' && !entry.untracked)) continue;
          const absolute = cwd ? `${cwd.replace(/[\\/]+$/, '')}/${relPath}` : relPath;
          reverted.delete(absolute);
          noteWrite(absolute, null);
          frames.push({ id: `${m.id}::${relPath}`, kind: 'changed_file', toolName: 'Write', toolInput: { file_path: absolute }, resultContent: 'checkpoint', resultIsError: false, ...(userTurn > 0 ? { turn: userTurn } : {}) });
        }
        continue;
      }
      if (m.kind === 'text') {
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) anchor = m.id as string;
        else if (m.role === 'user') {
          flush();
          if (!m.interjection) userTurn += 1;
        }
        continue;
      }
      if (m.kind !== 'tool_use' || !WORK_TOOLS.has(m.toolName as string)) continue;
      const paired = (m.toolResult as { content?: string; isError?: boolean } | undefined) ?? results.get(m.toolId as string);
      const frame: Frame = {
        id: m.id as string,
        toolName: m.toolName as string,
        toolInput: m.toolInput ?? null,
        resultContent: typeof paired?.content === 'string' ? paired.content : null,
        resultIsError: Boolean(paired?.isError),
        ...(userTurn > 0 ? { turn: userTurn } : {}),
      };
      if (frame.toolName === 'Write' && frame.resultContent !== null && !frame.resultIsError) {
        const written = filePathOf(frame);
        if (written) reverted.delete(written);
        noteWrite(written, (m.toolInput as { content?: unknown } | null)?.content);
      }
      frames.push(frame);
    }
    flush();
    return {
      frames: frames.length > MAX_WORK_FRAMES ? frames.slice(-MAX_WORK_FRAMES) : frames,
      truncated: frames.length > MAX_WORK_FRAMES ? true : undefined,
      revertedPaths: [...reverted],
      turnOutputs,
      userTurns: userTurn,
    };
  }

  /** 可复现的伪随机数(mulberry32)。 */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function randomHistory(seed: number, length: number, pool: number, revertRate = 0.02): Msg[] {
    const next = random(seed);
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
    const history: Msg[] = [];
    for (let n = 0; n < length; n += 1) {
      const roll = next();
      const id = `m${n}`;
      if (roll < 0.03) {
        history.push({ kind: 'text', role: 'user', id, content: '下一步', ...(next() < 0.2 ? { interjection: true } : {}) });
      } else if (roll < 0.07) {
        history.push({ kind: 'text', role: 'assistant', id, content: next() < 0.2 ? '  ' : '好的' });
      } else if (roll < 0.5) {
        const rel = `src/f${Math.floor(next() * pool)}.ts`;
        const content = 'line\n'.repeat(1 + Math.floor(next() * 5));
        const outcome = next();
        if (outcome < 0.08) {
          history.push({ kind: 'tool_use', id, toolId: id, toolName: 'Write', toolInput: { file_path: `/p/${rel}`, content } });
        } else if (outcome < 0.16) {
          history.push({ kind: 'tool_use', id, toolId: id, toolName: 'Write', toolInput: { file_path: `/p/${rel}`, content }, toolResult: { content: 'ok', isError: false } });
        } else {
          history.push({ kind: 'tool_use', id, toolId: id, toolName: 'Write', toolInput: { file_path: `/p/${rel}`, content } });
          history.push({ kind: 'tool_result', id: `${id}r`, toolId: id, content: outcome < 0.24 ? 'EACCES' : 'ok', isError: outcome < 0.24 });
        }
      } else if (roll < 0.6) {
        const toolName = pick(['TaskCreate', 'TaskUpdate', 'TodoWrite'] as const);
        const input = toolName === 'TaskCreate' ? { subject: `任务${n}` }
          : toolName === 'TaskUpdate' ? { taskId: String(Math.floor(next() * 20)), status: pick(['in_progress', 'completed']) }
            : { todos: [{ content: `清单${n}`, status: 'pending' }] };
        history.push({ kind: 'tool_use', id, toolId: id, toolName, toolInput: input });
        history.push({ kind: 'tool_result', id: `${id}r`, toolId: id, content: toolName === 'TaskCreate' ? `Task #${n} created successfully: 任务${n}` : 'ok' });
      } else if (roll < 0.66) {
        const files = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
          path: `src/f${Math.floor(next() * pool)}.ts`,
          status: pick(['added', 'modified', 'deleted']),
          ...(next() < 0.2 ? { untracked: true } : {}),
        }));
        history.push({ kind: 'changed_files', id, cwd: next() < 0.5 ? '/p' : '/p/', files });
      } else if (roll < 0.66 + revertRate) {
        const paths = Array.from({ length: 1 + Math.floor(next() * 3) }, () => `src/f${Math.floor(next() * pool)}.ts`);
        history.push({ kind: 'files_reverted', id, cwd: next() < 0.5 ? '/p' : '/p/', paths: next() < 0.2 ? [...paths, '  '] : paths });
      } else {
        history.push({ kind: 'tool_use', id, toolId: id, toolName: pick(['Read', 'Bash', 'Grep']), toolInput: {} });
      }
    }
    return history;
  }

  const expectSame = (messages: Msg[]) => {
    const actual = collectWorkFrames(messages as never);
    const expected = referenceCollect(messages);
    const shape = (frames: readonly Frame[]) => frames.map((frame) => [frame.id, frame.turn, frame.resultIsError, frame.resultContent === null]);
    expect(shape(actual.frames as unknown as Frame[])).toEqual(shape(expected.frames));
    expect(actual.truncated).toBe(expected.truncated);
    expect(actual.revertedPaths).toEqual(expected.revertedPaths);
    expect(actual.turnOutputs).toEqual(expected.turnOutputs);
    expect(actual.userTurns).toBe(expected.userTurns);
    return expected;
  };

  it('随机长历史:超过上限、夹着回滚', () => {
    for (const seed of [1, 7, 42, 2026, 31337]) {
      const expected = expectSame(randomHistory(seed, 8000, 80));
      expect(expected.truncated, `seed ${seed}`).toBe(true);
    }
  });

  it('随机长历史:文件池很小、回滚稀少,一次回滚成批删掉窗口里的帧', () => {
    for (const seed of [3, 11, 99, 123, 4567]) expectSame(randomHistory(seed, 9000, 6, 0.0004));
  });

  it('没触顶的短历史', () => {
    for (const seed of [5, 8]) {
      const expected = expectSame(randomHistory(seed, 300, 20));
      expect(expected.truncated).toBeUndefined();
    }
  });
});

/**
 * 长会话的代码生成:几百上千次 Write,每次带整份文件正文。这个接口每个回合结束、每个在看的人都要拉一次,
 * 帧里要是还带着正文,就是每回合几十 MB 的同步 JSON.stringify(期间所有人的请求都被卡住)。
 */
describe('工作帧载荷上限', () => {
  const content = 'export const value = 42; // padding padding padding padding\n'.repeat(1800);
  const snippet = `The file has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${'     1\texport const value = 42;\n'.repeat(200)}`;
  const heavyWrite = (n: number): Msg[] => ([
    {
      kind: 'tool_use',
      id: `w${n}`,
      toolId: `w${n}`,
      timestamp: '2026-10-07T10:00:00.000Z',
      toolName: 'Write',
      toolInput: { file_path: `/home/ubuntu/project/src/generated/module-${n}.ts`, content },
    },
    { kind: 'tool_result', toolId: `w${n}`, content: snippet },
  ]);

  it('1500 帧、每帧 100KB 正文的 Write:序列化后不到 1MB', () => {
    expect(content.length).toBeGreaterThan(100 * 1024);
    const messages: Msg[] = [{ kind: 'text', role: 'user', id: 'u1', content: '生成全部模块' }];
    for (let n = 0; n < MAX_WORK_FRAMES; n += 1) messages.push(...heavyWrite(n));
    messages.push({ kind: 'text', role: 'assistant', id: 'a1', content: '生成完了' });

    const collected = collectWorkFrames(messages as never);
    expect(collected.frames).toHaveLength(MAX_WORK_FRAMES);
    expect(collected.truncated).toBeUndefined();
    const bytes = Buffer.byteLength(JSON.stringify(collected));
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it('超出上限时同样有界,而且留的是最近的帧', () => {
    const total = MAX_WORK_FRAMES * 2;
    const messages: Msg[] = [];
    for (let n = 0; n < total; n += 1) messages.push(...heavyWrite(n));

    const collected = collectWorkFrames(messages as never);
    expect(collected.truncated).toBe(true);
    expect(collected.frames).toHaveLength(MAX_WORK_FRAMES);
    expect((collected.frames[0].toolInput as { file_path: string }).file_path)
      .toBe(`/home/ubuntu/project/src/generated/module-${total - MAX_WORK_FRAMES}.ts`);
    expect(Buffer.byteLength(JSON.stringify(collected))).toBeLessThan(1024 * 1024);
  });
});

/**
 * 路由必须把这几个字段一起透传:`truncated` 漏了,前端那句"更早的帧未下发"永远亮不起来;
 * `turnOutputs` 漏了,对话正文下面那张产出卡只能退回随窗口现推(数字会跳、会晚到)。
 * 这里读路由源码钉住。
 */
describe('work-frames 路由透传 truncated / turnOutputs', () => {
  it('响应体带 turnOutputs 与 truncated', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('../provider.routes.ts', import.meta.url)), 'utf8');
    const at = source.indexOf("'/sessions/:sessionId/work-frames'");
    expect(at).toBeGreaterThan(-1);
    const handler = source.slice(at, at + 1400);
    expect(handler).toMatch(/createApiSuccessResponse\(\{\s*frames,\s*revertedPaths,\s*turnOutputs,\s*truncated/);
    expect(handler).toMatch(/const \{ frames, revertedPaths, truncated, turnOutputs, userTurns \}/);
    // userTurns 也得下发:前端拿它补一条回合基线,进度锚点才认得出"这一轮"。
    expect(handler).toMatch(/userTurns: userTurns \?\? 0/);
  });
});
