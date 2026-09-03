import { describe, expect, it } from 'vitest';

/**
 * dv:归档清理的翻页不变量。
 *
 * 原实现恒取 offset 0 且 `targets.length === 0` 即 break —— 带
 * `olderThanDays` 时,只要最新那一页 archived 全是近期的,后面真正够旧的
 * 一条都清不到(清理静默地什么也没做);少量删不动的条目也会把游标钉死。
 * 这里把游标推进规则单独钉住:**留下几条就往前跨几条**。
 */

type Row = { id: string; old: boolean; deletable: boolean };

/** 复刻服务里的循环:返回删掉的 id 与读页次数(防死循环)。 */
function purge(all: Row[], pageSize: number, cutoffOn: boolean) {
  const remaining = [...all];
  const deleted: string[] = [];
  let failed = 0;
  let offset = 0;
  let reads = 0;

  for (;;) {
    reads += 1;
    if (reads > 100) throw new Error('死循环');
    const page = remaining.slice(offset, offset + pageSize);
    if (page.length === 0) break;

    const targets = page.filter((row) => (cutoffOn ? row.old : true));
    let deletedThisPage = 0;
    for (const row of targets) {
      if (!row.deletable) { failed += 1; continue; }
      const at = remaining.indexOf(row);
      remaining.splice(at, 1);
      deleted.push(row.id);
      deletedThisPage += 1;
    }

    offset += page.length - deletedThisPage;
    if (deletedThisPage === 0 && page.length < pageSize) break;
  }
  return { deleted, failed, remaining: remaining.map((row) => row.id) };
}

const row = (id: string, old: boolean, deletable = true): Row => ({ id, old, deletable });

describe('归档清理翻页', () => {
  it('第一页全是近期的时,仍能翻到后面够旧的(修前:一条都清不到)', () => {
    const all = [
      row('new1', false), row('new2', false),
      row('old1', true), row('old2', true),
    ];
    const { deleted, remaining } = purge(all, 2, true);
    expect(deleted).toEqual(['old1', 'old2']);
    expect(remaining).toEqual(['new1', 'new2']);
  });

  it('删不动的条目被跨过,不会把游标钉死', () => {
    const all = [row('stuck', true, false), row('ok', true)];
    const { deleted, failed, remaining } = purge(all, 2, true);
    expect(deleted).toEqual(['ok']);
    expect(failed).toBe(1);
    expect(remaining).toEqual(['stuck']);
  });

  it('不带 cutoff 时清空全部', () => {
    const all = [row('a', false), row('b', false), row('c', false)];
    expect(purge(all, 2, false).remaining).toEqual([]);
  });

  it('全空直接收工', () => {
    expect(purge([], 2, true).deleted).toEqual([]);
  });
});
