/**
 * 「我的账号」页的版面。
 *
 * gp:「退出登录」与「退出所有设备」原来是页面**最下面两张独立卡片**,各占一整块,
 * 把「附件空间」「修改密码」这些真正要读的内容顶下去(2026-09-15 用户截图)。
 * 它们本来就是"对当前这个账号做的事" —— 挪到身份行的右侧。
 *
 * 这里钉三件事:两个按钮在身份行里、不再有独立卡片、说明文案没丢(进了 title)。
 * 版面是 class 与 JSX 结构的事,跑起来才发现就太晚了,所以对源码断言。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'AccountSettingsTab.tsx'), 'utf8');

/** 身份行 = 含 `account.signedInAs` 的那个块,到 `<AttachmentUsageCard` 为止。 */
const identityBlock = (() => {
  const at = source.indexOf("t('account.signedInAs')");
  expect(at, '找不到身份行').toBeGreaterThan(-1);
  const end = source.indexOf('<AttachmentUsageCard', at);
  return source.slice(source.lastIndexOf('<div className="flex flex-wrap items-center gap-3', 0 + at), end);
})();

describe('我的账号:退出入口在身份行上', () => {
  it('两个按钮都在身份行里', () => {
    expect(identityBlock).toContain("t('account.logoutButton')");
    expect(identityBlock).toContain("t('account.revokeAllButton')");
    // 二次确认的取消也要一起搬过来,否则确认态下取消不了
    expect(identityBlock).toContain("t('account.revokeAllCancel')");
  });

  it('按钮组靠右,且窄屏能整体换行', () => {
    expect(identityBlock).toContain('justify-end');
    expect(identityBlock).toMatch(/basis-full[^"]*sm:basis-auto|sm:basis-auto[^"]*basis-full/);
    expect(identityBlock, '身份行自身要允许换行').toContain('flex-wrap');
  });

  it('原来那两张独立卡片没了', () => {
    // 卡片头是 `<h3>{t('account.logoutTitle')}</h3>` 这种形状
    expect(source).not.toMatch(/<h3[^>]*>\s*\{t\('account\.logoutTitle'\)\}/);
    expect(source).not.toMatch(/<h3[^>]*>\s*\{t\('account\.revokeAllTitle'\)\}/);
  });

  it('卡片的标题与说明没丢 —— 进了按钮的 title', () => {
    for (const key of ['account.logoutTitle', 'account.logoutHelp', 'account.revokeAllTitle', 'account.revokeAllHelp']) {
      expect(identityBlock, `${key} 不见了`).toContain(`t('${key}')`);
    }
    expect(identityBlock.match(/title=\{`/g)?.length ?? 0, '两个按钮各要一个 title').toBeGreaterThanOrEqual(2);
  });

  it('文字可能被图标挤掉,所以两个按钮都要有 aria-label', () => {
    expect(identityBlock).toContain("aria-label={t('account.logoutButton')}");
    expect(identityBlock).toContain("aria-label={t('account.revokeAllButton')}");
  });
});
