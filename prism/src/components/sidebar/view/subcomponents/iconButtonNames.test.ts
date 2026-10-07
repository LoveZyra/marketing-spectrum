import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 侧栏里只有图标的按钮要有可访问名称。
 *
 * 读屏在这类按钮上只念「按钮」,用户分不清用途;移动端头部的刷新 / 新建项目是那两个动作唯一的入口。
 * 判据:`<button>` 上没有 aria-label / aria-labelledby / title / 展开的 props,按钮体去掉组件标签后
 * 也没有文字、`{t(…)}` 或表达式,就算一个缺名称的纯图标按钮。
 */
const VIEW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const listTsx = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsx(full);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [full] : [];
  });

/** 返回缺名称的纯图标按钮所在行号。 */
const findUnnamedIconButtons = (source: string): number[] => {
  const lines: number[] = [];
  for (const match of source.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g)) {
    const [, attrs, body] = match;
    if (/aria-label|aria-labelledby|\btitle=|\{\.\.\./.test(attrs)) continue;
    const visible = body
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/<[A-Z][A-Za-z0-9.]*[^>]*\/>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (visible.length > 0) continue;
    lines.push(source.slice(0, match.index).split('\n').length);
  }
  return lines;
};

describe('侧栏纯图标按钮的可访问名称', () => {
  it('判据:只有图标、没有名称的按钮算缺;有 aria-label、title 或文字的不算', () => {
    expect(findUnnamedIconButtons('<button onClick={close}>\n  <X className="h-4 w-4" />\n</button>')).toEqual([1]);
    expect(findUnnamedIconButtons('<button onClick={close} aria-label={t(\'actions.close\')}>\n  <X className="h-4 w-4" />\n</button>')).toEqual([]);
    expect(findUnnamedIconButtons('<button onClick={close} title="Close"><X /></button>')).toEqual([]);
    expect(findUnnamedIconButtons('<button onClick={go}><Plus />{t(\'tasksPage.newTask\')}</button>')).toEqual([]);
  });

  it('侧栏 view 目录下没有缺名称的纯图标按钮', () => {
    const files = listTsx(VIEW_DIR);
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((file) =>
      findUnnamedIconButtons(readFileSync(file, 'utf8')).map((line) => `${path.relative(VIEW_DIR, file)}:${line}`));
    expect(hits).toEqual([]);
  });
});
