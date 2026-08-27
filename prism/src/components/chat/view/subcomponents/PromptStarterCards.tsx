import { useMemo } from 'react';
import {
  Megaphone,
  Microscope,
  Binary,
  Lightbulb,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';

interface PromptStarterCardsProps {
  /** Fill the composer with the chosen prompt (user edits then sends). */
  onPick: (prompt: string) => void;
}

interface StarterLink {
  label: string;
  /** 相对路径。真实地址由服务端给,前端不写死。 */
  href: string;
}

interface StarterCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  prompts: string[];
  /** 外链入口,点了是跳页面而不是填输入框。运行时才知道挂没挂上,所以是可选的。 */
  links?: StarterLink[];
}

/**
 * Prism welcome-screen starter prompts, grouped by the workbench's core
 * algorithm-analysis scenarios. Clicking a card loads the prompt into the
 * composer for editing — it is not sent automatically.
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
    // 只留一个例子,给"算法效果查询"腾出位置 —— 这样这张卡也是两行,和其余三张齐平。
    prompts: ['推荐一个适合冷启动推荐的算法方案'],
    links: [{ label: '算法效果查询', href: '/recsys' }],
  },
];

export default function PromptStarterCards({ onPick }: PromptStarterCardsProps) {
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
        试试这些开始
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
                <span className="grid h-8 w-8 place-items-center rounded-sm bg-primary/8">
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
                    className="block w-full rounded-md border border-transparent bg-card px-3.5 py-2.5 text-left text-sm leading-relaxed text-body transition-colors hover:border-primary/30 hover:bg-primary/8 hover:text-foreground"
                  >
                    {prompt}
                  </button>
                ))}
                {category.links?.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-between gap-2 rounded-md border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-left text-sm leading-relaxed text-body transition-colors hover:border-primary/45 hover:bg-primary/10 hover:text-foreground"
                  >
                    <span>{link.label}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
