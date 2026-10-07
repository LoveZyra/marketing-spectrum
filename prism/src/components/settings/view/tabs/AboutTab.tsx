import { useTranslation } from 'react-i18next';

import { BUILD_RELEASE } from '../../../../utils/releaseInfo';
import PrismLogo from '../../../PrismLogo';
import PrismWordmark from '../../../PrismWordmark';

/**
 * Prism About: brand, version and the product vision. No update badges,
 * external links or upsells.
 */
export default function AboutTab() {
  const { t } = useTranslation('settings');
  const pillars = [
    {
      key: 'entry',
      title: t('about.pillars.entry.title', { defaultValue: '一个入口' }),
      body: t('about.pillars.entry.body', { defaultValue: '统一承载算法研发、数据分析与多 Agent 协作' }),
    },
    {
      key: 'trusted',
      title: t('about.pillars.trusted.title', { defaultValue: '可信执行' }),
      body: t('about.pillars.trusted.body', { defaultValue: '每一轮改动可视化、可审计、可一键回滚' }),
    },
    {
      key: 'reuse',
      title: t('about.pillars.reuse.title', { defaultValue: '沉淀复用' }),
      body: t('about.pillars.reuse.body', { defaultValue: '团队的算法资产与分析方法在这里持续积累' }),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Brand + version */}
      <div className="flex items-center gap-3">
        <PrismLogo size={44} />
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="inline-flex items-center text-foreground">
              <PrismWordmark height={18} />
            </span>
            <span className="rounded-sm border border-border px-1.5 py-px font-mono text-[11px] font-medium text-muted-foreground">
              v{BUILD_RELEASE.version}
            </span>
            {/* 发布日期与提交号来自包里的 RELEASE.json,从源码运行时没有。 */}
            {(BUILD_RELEASE.date || BUILD_RELEASE.commit) && (
              <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground" data-release-meta>
                {[BUILD_RELEASE.date, BUILD_RELEASE.commit].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('about.tagline', { defaultValue: '公共算法与分析 Agent 工作台' })}
          </p>
        </div>
      </div>

      {/* Vision */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium text-foreground">{t('about.visionTitle', { defaultValue: '愿景' })}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t('about.vision', {
            defaultValue: '像棱镜把一束光分解为完整的光谱，棱镜把复杂的算法与数据问题，分解为清晰、可执行、可回溯的智能工作流。',
          })}
        </p>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          {pillars.map((pillar) => (
            <li key={pillar.key} className="flex gap-2">
              <span className="text-foreground dark:text-primary">·</span>
              <span><span className="text-foreground">{pillar.title}</span> —— {pillar.body}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs italic text-muted-foreground">
          Split complexity into insight.
        </p>
      </div>
    </div>
  );
}
