import { useMemo } from 'react';
import {
  Megaphone,
  Microscope,
  Binary,
  Lightbulb,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { EXTERNAL_APPS } from '../../../../config/externalApps';

interface PromptStarterCardsProps {
  /** 把选中的提示词填进输入框(用户改完再发,不自动发送)。 */
  onPick: (prompt: string) => void;
}

interface StarterCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  prompts: string[];
  /** 外部应用挂在这张卡下面(点了是跳页面,不是填输入框)。 */
  withExternalApps?: boolean;
}

/**
 * 首页的起手卡,按工作台的几个核心场景分组。点一条提示词是**填进输入框**,
 * 不会自动发送。
 *
 * ## 版式沿革(改之前先读完)
 *
 * - ee 及之前:一张卡两条提示词,四张卡占满右半屏。
 * - ef:砍成一张卡一句提示词、60px 半高,理由是输入框搬到了卡片上方,
 *   点完就能直接改。
 * - **ex:按用户要求整体还原回 ee 那版** —— 两条提示词、四张大卡、左边配品牌区。
 *   输入框也回到页面底部。
 *
 * 所以这里"一张卡两条"不是随手写的,是回到过的版式。要再改回半高版,
 * 对着 CHANGELOG 的 ef / ex 两条互查。
 *
 * ## 外部应用为什么长在第四张卡里
 *
 * 位置是 ee 的位置(方案咨询这张卡只留一条提示词,腾出的那行给它),但**地址不是**
 * ee 的写法 —— ek 把外部应用抽成了 `config/externalApps.ts`,理由是入口不该写死在
 * 某个组件里。还原版式不等于把那条一起还原回去,所以这里读清单,不写 `/recsys`。
 *
 * 它长得和提示词行明显不同(主题色描边 + 外链图标):同一张卡里两种行为,
 * 至少要让人一眼看出哪条是"跳走"。这是 ek 当初拆走它的核心理由,版式还原了,
 * 那个理由仍然成立,所以在样式上留住。
 */
const CATEGORIES: StarterCategory[] = [
  {
    key: 'campaign',
    label: '营销活动诊断',
    icon: Megaphone,
    prompts: [
      '帮我诊断这个营销活动，评估人群圈选和触达链路是否合理',
      '复盘这个活动的转化漏斗，找出效果不佳的环节',
    ],
  },
  {
    key: 'analyst',
    label: '分析专家',
    icon: Microscope,
    prompts: [
      '做一份外部专题调研：这个行业近一年的竞争格局和主要玩家动向',
      '做一份内部业务经营分析：拆解这条业务线的收入结构和同比变化',
    ],
  },
  {
    key: 'modeling',
    label: '算法建模',
    icon: Binary,
    prompts: [
      '构建一个用户流失预测模型，给出特征方案',
      '为这个推荐场景设计召回 + 排序链路',
    ],
  },
  {
    key: 'consulting',
    label: '方案咨询',
    icon: Lightbulb,
    // 只留一条,给外部应用腾出那一行 —— 这样这张卡也是两行,和其余三张齐平。
    prompts: ['推荐一个适合冷启动推荐的算法方案'],
    withExternalApps: true,
  },
];

export default function PromptStarterCards({ onPick }: PromptStarterCardsProps) {
  const { t } = useTranslation('chat');

  // 四张卡全展示:营销活动诊断固定第一、方案咨询固定最后,中间两张(分析专家/算法建模)
  // 每次挂载随机换个先后。所以"算法效果查询"这个入口一定在场。
  const categories = useMemo(() => {
    const first = CATEGORIES[0];
    const last = CATEGORIES[CATEGORIES.length - 1];
    const middle = CATEGORIES.slice(1, -1);
    for (let i = middle.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [middle[i], middle[j]] = [middle[j], middle[i]];
    }
    return [first, ...middle, last];
  }, []);

  return (
    <div className="w-full">
      <p className="mb-3 text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
        {t('home.starters', { defaultValue: '试试这些开始' })}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {categories.map((category) => {
          const Icon = category.icon;
          return (
            <div
              key={category.key}
              className="prism-hover-glow rounded-lg border border-border p-4 text-left transition-shadow"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="bg-primary/8 grid h-8 w-8 place-items-center rounded-sm">
                  <Icon className="h-5 w-5 text-primary" strokeWidth={2} aria-hidden />
                </span>
                <span className="text-sm font-semibold text-foreground">{category.label}</span>
              </div>
              <div className="space-y-2">
                {category.prompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => onPick(prompt)}
                    className="hover:bg-primary/8 block w-full rounded-md border border-transparent bg-card px-3.5 py-2.5 text-left text-sm leading-relaxed text-body transition-colors hover:border-primary/30 hover:text-foreground"
                  >
                    {prompt}
                  </button>
                ))}
                {category.withExternalApps
                  && EXTERNAL_APPS.map((app) => {
                    const label = t(app.labelKey, { defaultValue: app.labelFallback });
                    return (
                      <a
                        key={app.key}
                        href={app.href}
                        target={app.newTab ? '_blank' : undefined}
                        rel={app.newTab ? 'noopener noreferrer' : undefined}
                        data-home-tool={app.key}
                        title={t('home.toolHint', { defaultValue: '{{name}} · 新标签页打开', name: label })}
                        className="flex w-full items-center justify-between gap-2 rounded-md border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-left text-sm leading-relaxed text-body transition-colors hover:border-primary/45 hover:bg-primary/10 hover:text-foreground"
                      >
                        <span>{label}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                      </a>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
