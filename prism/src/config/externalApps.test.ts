import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXTERNAL_APPS } from './externalApps';

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

/**
 * ek:「算法效果查询」入口的位置约定。
 *
 * 它此前写死在起手卡文件里、挂在第四张卡右下角 —— 起手卡点了是"填输入框",
 * 它点了是"跳走",两种行为混在一个 60px 的框里读不出区别;而且只有首页才有,
 * 一进会话就找不到。现在改成一份清单、两处消费(图标轨 + 首页「工具」栏目)。
 * 下面钉住的就是这几条,改回去不会有别的测试变红。
 */
describe('外部应用清单', () => {
  it('清单里的每一项都能被两处入口渲染出来', () => {
    expect(EXTERNAL_APPS.length).toBeGreaterThan(0);
    for (const app of EXTERNAL_APPS) {
      expect(app.key).toBeTruthy();
      expect(app.labelFallback).toBeTruthy();
      expect(app.descriptionFallback).toBeTruthy();
      expect(app.icon).toBeTruthy();
      // 相对路径:真实地址由服务端反代决定,前端写死主机就没法换环境
      expect(app.href.startsWith('/')).toBe(true);
      expect(app.href.startsWith('//')).toBe(false);
    }
  });

  it('算法效果查询指向 /recsys,且入口不随反代配置隐藏(cy 的决定)', () => {
    const recsys = EXTERNAL_APPS.find((app) => app.key === 'recsys');
    expect(recsys?.href).toBe('/recsys');
    expect(recsys?.newTab).toBe(true);
    // 清单是静态的 —— 一旦按"服务端说配了才显示"来做,没配的机器上入口凭空消失,
    // 比给一句「在 .env 里加这一行」难懂得多。
    expect(read('./externalApps.ts')).not.toMatch(/fetch\(|useEffect|authenticatedFetch/);
  });
});

describe('入口位置', () => {
  it('图标轨**不放**外部应用 —— 那条轨只放 Prism 自己的标签页(el 定夺)', () => {
    // ek 一度把「算法效果查询」挂到轨上,用户要把轨位留作他用,el 撤掉。
    // 入口只在首页「工具」栏目一处。
    const rail = read('../components/app/AppRail.tsx');
    expect(rail).not.toMatch(/EXTERNAL_APPS/);
    expect(rail).not.toMatch(/data-rail-external/);
    expect(rail).not.toMatch(/externalAppHint/);
  });

  it('首页:独立的「工具」栏目,40px 行(不是 60px 起手卡)', () => {
    const section = read('../components/chat/view/subcomponents/HomeToolsSection.tsx');
    expect(section).toMatch(/data-home-tools/);
    expect(section).toMatch(/home\.tools/);
    expect(section).toMatch(/h-10 w-full items-center/);
    expect(section).not.toMatch(/h-\[60px\]/);

    const home = read('../components/chat/view/subcomponents/ChatEmptyState.tsx');
    // 顺序:起手卡 → 工具 → 最近会话
    const cardsAt = home.indexOf('<PromptStarterCards');
    const toolsAt = home.indexOf('<HomeToolsSection');
    const recentAt = home.indexOf('data-home-recent');
    expect(cardsAt).toBeGreaterThan(-1);
    expect(toolsAt).toBeGreaterThan(cardsAt);
    expect(recentAt).toBeGreaterThan(toolsAt);
  });

  it('起手卡里那枚外链已经撤走 —— 一张卡只有一种行为', () => {
    const cards = read('../components/chat/view/subcomponents/PromptStarterCards.tsx');
    expect(cards).not.toMatch(/recsys/);
    expect(cards).not.toMatch(/ExternalLink/);
    expect(cards).not.toMatch(/category\.link/);
    expect(cards).not.toMatch(/interface StarterLink/);
  });
});
