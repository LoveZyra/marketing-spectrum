import { describe, expect, it } from 'vitest';

import { collectWorkFrames, MAX_WORK_FRAMES } from '../services/sessions.service';

/**
 * dw:工作帧响应的载荷上限。
 *
 * 这个接口原本无条件回**整个会话**的工作帧,而它在会话切换、每个回合结束
 * 都要拉一次 —— 长会话下载荷只增不减。截断规则有两条必须钉死:
 *  1. 保留**尾部**(当前清单状态、最近的产出都在尾部);
 *  2. revertedPaths 在截断**之前**按全量算 —— 否则"这个文件已经回滚了"
 *     这条结论会因为截断而丢失,已回滚的文件又冒回面板里。
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
});

/**
 * ec:`truncated` 必须真的下发。dw 在 collectWorkFrames 与前端两头都接了这个
 * 字段,唯独路由中间只透传了 frames / revertedPaths —— 前端那句"更早的帧未
 * 下发"永远亮不起来。这里读路由源码钉住几个字段一起走。
 *
 * ej:`turnOutputs` 同理,而且更要紧 —— 对话正文下面那张产出卡整个靠它,
 * 路由漏一个字段,卡片就退回"随窗口现推"的老毛病(数字会跳 / 会晚到)。
 */
describe('work-frames 路由透传 truncated / turnOutputs', () => {
  it('响应体带 turnOutputs 与 truncated', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('../provider.routes.ts', import.meta.url)), 'utf8');
    const at = source.indexOf("'/sessions/:sessionId/work-frames'");
    expect(at).toBeGreaterThan(-1);
    const handler = source.slice(at, at + 900);
    expect(handler).toMatch(/createApiSuccessResponse\(\{\s*frames,\s*revertedPaths,\s*turnOutputs,\s*truncated/);
    expect(handler).toMatch(/const \{ frames, revertedPaths, truncated, turnOutputs \}/);
  });
});
