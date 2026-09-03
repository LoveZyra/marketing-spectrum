import { useMemo } from 'react';
import {
  Megaphone,
  Microscope,
  Binary,
  Lightbulb,
  type LucideIcon,
} from 'lucide-react';

interface PromptStarterCardsProps {
  /** Fill the composer with the chosen prompt (user edits then sends). */
  onPick: (prompt: string) => void;
}

interface StarterCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  /** 点卡片填进输入框的那句提示词;卡片上只显示这一句(单行省略)。 */
  prompt: string;
}

/**
 * Prism welcome-screen starter prompts, grouped by the workbench's core
 * algorithm-analysis scenarios. Clicking a card loads the prompt into the
 * composer for editing — it is not sent automatically.
 *
 * ef:卡片减半 —— 一张卡 = 图标 + 标题 + 一句提示词,60px 高,2 × 2 排。
 * 原来每张卡摆两条提示词、占满半屏;现在每个场景只留最有代表性的一句,
 * 输入框就在卡片上方,点了直接改。
 *
 * ek:**每张卡只有一种行为 —— 把提示词填进输入框。** 「算法效果查询」那枚外链
 * 从这里撤走了(挂在第四张卡右下角,是"跳走"混进了"填输入框",而且只有首页才有):
 * 现在它在首页的「工具」栏目和左侧图标轨上,见 config/externalApps.ts。
 */
const CATEGORIES: StarterCategory[] = [
  {
    key: 'campaign',
    label: '营销活动诊断',
    icon: Megaphone,
    prompt: '帮我诊断这个营销活动，评估人群圈选和触达链路是否合理',
  },
  {
    key: 'analyst',
    label: '分析专家',
    icon: Microscope,
    prompt: '做一份外部专题调研：这个行业近一年的竞争格局和主要玩家动向',
  },
  {
    key: 'modeling',
    label: '算法建模',
    icon: Binary,
    prompt: '构建一个用户流失预测模型，给出特征方案',
  },
  {
    key: 'consulting',
    label: '方案咨询',
    icon: Lightbulb,
    prompt: '推荐一个适合冷启动推荐的算法方案',
  },
];

export default function PromptStarterCards({ onPick }: PromptStarterCardsProps) {
  // 四张卡全展示:营销活动诊断固定第一、方案咨询固定最后,中间两张(分析专家/算法建模)
  // 每次挂载随机换个先后 —— 让人真的读一遍,而不是永远只点第一张。
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
    <div data-starter-cards className="flex w-full flex-col gap-2.5">
      <p className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
        试试这些开始
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {categories.map((category) => {
          const Icon = category.icon;
          return (
            <button
              key={category.key}
              type="button"
              onClick={() => onPick(category.prompt)}
              title={category.prompt}
              className="group flex h-[60px] items-center gap-3 rounded-panel border border-border bg-card px-3.5 text-left transition-colors hover:border-primary/30"
            >
              <span className="bg-primary/8 grid h-7 w-7 flex-none place-items-center rounded-md">
                <Icon className="h-4 w-4 text-primary" strokeWidth={2} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-semibold leading-[18px] text-foreground">{category.label}</span>
                <span className="min-w-0 truncate text-xs leading-4 text-muted-foreground transition-colors group-hover:text-body">
                  {category.prompt}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
