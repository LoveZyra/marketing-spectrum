import { useMemo } from 'react';
import {
  Megaphone,
  Stethoscope,
  BarChart3,
  Binary,
  Network,
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
  prompts: string[];
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
    key: 'diagnosis',
    label: '场景诊断',
    icon: Stethoscope,
    prompts: [
      '帮我诊断这个先知场景的圈人逻辑，检查分支是否互斥完备',
      '检查这个场景的人群配置和标签口径有没有问题',
    ],
  },
  {
    key: 'analysis',
    label: '数据分析',
    icon: BarChart3,
    prompts: [
      '分析这份用户行为数据，找出关键转化瓶颈',
      '对比 A/B 实验两组指标的显著性差异',
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
    prompts: [
      '推荐一个适合冷启动推荐的算法方案',
      '这个排序场景该选什么模型，讲讲权衡',
    ],
  },
  {
    key: 'algomodel',
    label: '算法模型',
    icon: Network,
    prompts: [
      '训练一个用户流失预测模型，评估 AUC 和特征重要性',
      '为这个分类任务做模型选型与调参，比较几种方案的效果',
    ],
  },
];

export default function PromptStarterCards({ onPick }: PromptStarterCardsProps) {
  // 营销活动诊断 stays pinned first and 量化策略 pinned last; the two middle
  // slots are randomized once per mount for freshness.
  const categories = useMemo(() => {
    const first = CATEGORIES[0];
    const last = CATEGORIES[CATEGORIES.length - 1];
    const middle = CATEGORIES.slice(1, -1);
    for (let i = middle.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [middle[i], middle[j]] = [middle[j], middle[i]];
    }
    return [first, ...middle.slice(0, 2), last];
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
