/**
 * 账号审批表的横向预算。
 *
 * 2026-09-15 用户截图:窗口 877px 时「操作」那一列被**整个切掉**,而且没有任何办法
 * 滚过去 —— 外框是 `overflow-hidden`,表格实际要 625px、容器只有 555px,那 70px
 * 就是看不见也够不着。旁边的审计表一直是 `overflow-x-auto`,这张漏了。
 *
 * 更早一版把各列锁成 `whitespace-nowrap`(治"到处换行"),等于把这张表变宽 ——
 * 于是"换行"换成了"被切掉"。所以这两件事必须一起钉:**放不下时够得着**(横向滚动),
 * 以及**尽量别放不下**(窄屏收列 + 按钮只留图标)。
 *
 * vitest 这边没有 jsdom,挂不起组件,而这一轮出错的地方全在 class 上 ——
 * 所以对源码断言,和仓库里其它"钉接线"的测试同一路数。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'AccountsSettingsTab.tsx'), 'utf8');
const auditSource = readFileSync(path.join(here, 'AuditLogList.tsx'), 'utf8');

/** 表格外框那一行(`<div …><table` 之前)。 */
const tableWrapperClass = (code: string): string => {
  const match = /<div className="([^"]*)">\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<table/.exec(code)
    || /<div className="([^"]*)">\s*<table/.exec(code);
  if (!match) throw new Error('找不到包着 <table> 的那层 div');
  return match[1];
};

describe('账号审批表:放不下时够得着', () => {
  it('外框可以横向滚动,不能是 overflow-hidden', () => {
    const cls = tableWrapperClass(source);
    expect(cls).toContain('overflow-x-auto');
    expect(cls).not.toContain('overflow-hidden');
  });

  it('审计表也是同一条规矩(它本来就是对的,别被改回去)', () => {
    const cls = tableWrapperClass(auditSource);
    expect(cls).toContain('overflow-x-auto');
    expect(cls).not.toContain('overflow-hidden');
  });
});

describe('两张表的列都靠左', () => {
  /**
   * 2026-09-15 用户反馈:「操作这两个字为什么是右对齐的,其他我看都是左对齐」。
   * 原来「操作」那一列表头是 `text-right`、按钮组是 `justify-end`,
   * 在一张其余四列全靠左的表里,它自己贴着右边。
   */
  it('账号审批表:五个表头全是 text-left,没有一个 text-right', () => {
    const headers = source.match(/<th className="[^"]*"/g) ?? [];
    expect(headers.length, '表头数量不对').toBe(5);
    for (const th of headers) {
      expect(th, th).toContain('text-left');
      expect(th, th).not.toContain('text-right');
    }
  });

  it('账号审批表:操作列里的按钮也跟着靠左', () => {
    expect(source).toContain('flex items-center justify-start gap-1.5');
    expect(source).not.toContain('flex items-center justify-end gap-1.5');
  });

  it('审计表:同样五个表头全靠左', () => {
    const headers = auditSource.match(/<th className="[^"]*"/g) ?? [];
    expect(headers.length).toBe(5);
    for (const th of headers) {
      expect(th, th).toContain('text-left');
      expect(th, th).not.toContain('text-right');
    }
  });
});

describe('账号审批表:尽量别放不下', () => {
  it('「审批人」列窄屏收起 —— 表头与单元格都要收,只收一边会串列', () => {
    const header = /<th className="([^"]*)"[^>]*>\{t\('accounts\.columns\.reviewer'/.exec(source);
    expect(header, '找不到审批人表头').not.toBeNull();
    expect(header![1]).toContain('hidden');
    expect(header![1]).toContain('lg:table-cell');

    // 单元格:reviewed_by_username 所在的那个 <td>
    const cellIndex = source.indexOf('reviewed_by_username ?');
    const cellStart = source.lastIndexOf('<td className="', cellIndex);
    const cellClass = /<td className="([^"]*)"/.exec(source.slice(cellStart))![1];
    expect(cellClass).toContain('hidden');
    expect(cellClass).toContain('lg:table-cell');
  });

  it('操作列的按钮文字窄屏收起(只留图标)', () => {
    // 五个动作:通过 / 驳回 / 重置密码 / 停用 / 启用
    for (const action of ['approve', 'reject', 'resetPassword', 'deactivate', 'activate']) {
      const wrapped = new RegExp(`<span className="hidden xl:inline">\\{t\\('accounts\\.actions\\.${action}'`);
      expect(wrapped.test(source), `${action} 的按钮文字没有包进可收起的 span`).toBe(true);
    }
  });

  it('文字能被收起,所以每个动作按钮都必须自带 title 与 aria-label', () => {
    for (const action of ['approve', 'reject', 'resetPassword', 'deactivate', 'activate']) {
      const key = `accounts.actions.${action}`;
      const titleCount = source.split(`title={t('${key}'`).length - 1;
      const ariaCount = source.split(`aria-label={t('${key}'`).length - 1;
      expect(titleCount, `${action} 缺 title`).toBeGreaterThanOrEqual(1);
      expect(ariaCount, `${action} 缺 aria-label`).toBeGreaterThanOrEqual(1);
    }
  });
});
