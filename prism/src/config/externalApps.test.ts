import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXTERNAL_APPS } from './externalApps';

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

/**
 * 「算法效果查询」入口的位置与真源约定。
 *
 * 位置(首页起手卡里,不上图标轨)是产品取舍,可以调整;真源不能分散 —— 一旦有第二个地方写死 `/recsys`,
 * 换环境时就会漏掉一处。所以钉得最死的一条是"起手卡不许写死路径,必须读清单"。
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

  it('算法效果查询指向 /recsys,且入口不随反代配置隐藏', () => {
    const recsys = EXTERNAL_APPS.find((app) => app.key === 'recsys');
    expect(recsys?.href).toBe('/recsys');
    expect(recsys?.newTab).toBe(true);
    // 清单是静态的 —— 一旦按"服务端说配了才显示"来做,没配的机器上入口凭空消失,
    // 比给一句「在 .env 里加这一行」难懂得多。
    expect(read('./externalApps.ts')).not.toMatch(/fetch\(|useEffect|authenticatedFetch/);
  });
});

describe('入口位置', () => {
  it('图标轨不放外部应用 —— 那条轨只放 Prism 自己的标签页', () => {
    const rail = read('../components/app/AppRail.tsx');
    expect(rail).not.toMatch(/EXTERNAL_APPS/);
    expect(rail).not.toMatch(/data-rail-external/);
    expect(rail).not.toMatch(/externalAppHint/);
  });

  it('入口在起手卡里,且从清单读,不写死路径', () => {
    const cards = read('../components/chat/view/subcomponents/PromptStarterCards.tsx');
    // 这条是这个文件里最要紧的一条:位置怎么挪都行,真源只能有一处。
    expect(cards).toMatch(/EXTERNAL_APPS/);
    expect(cards).not.toMatch(/'\/recsys'/);
    expect(cards).toMatch(/data-home-tool=/);
  });

  it('同一张卡里两种行为要看得出区别 —— 外链不长成提示词行', () => {
    // 提示词行是 `border-transparent bg-card`,外链是主题色描边 + 外链图标。
    const cards = read('../components/chat/view/subcomponents/PromptStarterCards.tsx');
    expect(cards).toMatch(/ExternalLink/);
    expect(cards).toMatch(/border-primary\/25/);
  });

  it('首页不再有独立的「工具」栏目(ex 随版式一起撤掉)', () => {
    const home = read('../components/chat/view/subcomponents/ChatEmptyState.tsx');
    expect(home).not.toMatch(/<HomeToolsSection/);
    expect(home).not.toMatch(/data-home-tools/);
    // 两栏版式:左品牌区 + 右起手卡
    expect(home).toMatch(/<PrismVisionPanel/);
    expect(home).toMatch(/<PromptStarterCards/);
  });
});
