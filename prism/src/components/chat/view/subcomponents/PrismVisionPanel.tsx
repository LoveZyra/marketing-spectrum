import { useTranslation } from 'react-i18next';

import PrismLogo from '../../../PrismLogo';
import PrismWordmark from '../../../PrismWordmark';

/**
 * 首页空态左栏的品牌区 —— 品牌标识 + 产品主张,让落地页一眼读得出这是一个
 * 算法分析工作台,同时在宽屏上把左半边填住。
 *
 * 保留这块是产品上的取舍(把 Prism 打开给别人看时,这里正是要讲的东西),
 * 不要顺手"优化"掉它。
 */
export default function PrismVisionPanel() {
  const { t } = useTranslation('chat');
  const pillars = [
    { key: 'entry', title: t('visionPanel.pillars.entry.title', { defaultValue: '一个入口' }), desc: t('visionPanel.pillars.entry.desc', { defaultValue: '算法研发 · 数据分析 · 多 Agent 协作' }) },
    { key: 'trusted', title: t('visionPanel.pillars.trusted.title', { defaultValue: '可信执行' }), desc: t('visionPanel.pillars.trusted.desc', { defaultValue: '每轮改动可视化 · 可审计 · 可回滚' }) },
    { key: 'reuse', title: t('visionPanel.pillars.reuse.title', { defaultValue: '沉淀复用' }), desc: t('visionPanel.pillars.reuse.desc', { defaultValue: '团队的算法资产与方法持续积累' }) },
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col justify-center overflow-hidden rounded-lg border border-border p-6">
      <div className="flex items-center gap-3.5">
        <PrismLogo size={56} />
        <span className="inline-flex items-center text-foreground">
          <PrismWordmark height={30} />
        </span>
      </div>

      <p className="mt-4 text-[1.3rem] font-medium leading-snug text-foreground">
        {t('visionPanel.headlineLead', { defaultValue: '把复杂的算法与数据问题，' })}<br className="hidden sm:block" />{t('visionPanel.headlineTail', { defaultValue: '分解为清晰、可执行、可回溯的智能工作流' })}
      </p>

      <div className="mt-5 space-y-2.5">
        {pillars.map((pillar) => (
          <div key={pillar.key} className="flex gap-2.5">
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden />
            <div>
              <span className="text-sm font-medium text-foreground">{pillar.title}</span>
              <span className="ml-1.5 text-xs text-muted-foreground">{pillar.desc}</span>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-5 text-xs italic text-muted-foreground">
        Split complexity into insight.
      </p>
    </div>
  );
}
