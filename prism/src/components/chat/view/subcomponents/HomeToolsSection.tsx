import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { EXTERNAL_APPS } from '../../../../config/externalApps';

/**
 * 首页的「工具」栏目(ek)—— 挂在 Prism 上的外部应用。
 *
 * 位置在起手卡之后、最近会话之前。**行卡做成 40px 的行**(与最近会话行同高),
 * 而不是 60px 的起手卡:高度上的差别本身就在说"这不是起手卡" —— 起手卡点了是
 * 把提示词填进输入框,这里点了是跳到另一个应用,两种行为不该长成一个样子。
 *
 * 之前这枚入口挤在第四张起手卡的右下角,既读不出是另一种东西,又跟"方案咨询"
 * 那句提示词没有从属关系(纯粹是那张卡右下角有空位)。现在它在首页有自己的栏目。
 */
export default function HomeToolsSection() {
  const { t } = useTranslation('chat');

  if (EXTERNAL_APPS.length === 0) return null;

  return (
    <div data-home-tools className="flex w-full flex-col gap-2.5">
      <p className="text-[11px] font-medium uppercase tracking-[1.4px] text-muted-foreground">
        {t('home.tools', { defaultValue: '工具' })}
      </p>
      <div className="overflow-hidden rounded-panel border border-border bg-card">
        {EXTERNAL_APPS.map((app, index) => {
          const label = t(app.labelKey, { defaultValue: app.labelFallback });
          const description = t(app.descriptionKey, { defaultValue: app.descriptionFallback });
          return (
            <a
              key={app.key}
              href={app.href}
              target={app.newTab ? '_blank' : undefined}
              rel={app.newTab ? 'noopener noreferrer' : undefined}
              data-home-tool={app.key}
              title={t('home.toolHint', { defaultValue: '{{name}} · 新标签页打开', name: label })}
              className={`group flex h-10 w-full items-center gap-2.5 px-3 transition-colors hover:bg-muted ${
                index > 0 ? 'border-t border-border' : ''
              }`}
            >
              <span className="bg-primary/8 grid h-6 w-6 flex-none place-items-center rounded-md">
                <app.icon className="h-3.5 w-3.5 text-primary" strokeWidth={2} aria-hidden />
              </span>
              <span className="flex-none text-[13px] font-medium text-foreground">{label}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{description}</span>
              <ArrowUpRight
                className="h-3.5 w-3.5 flex-none text-border-strong transition-colors group-hover:text-primary"
                strokeWidth={2}
                aria-hidden
              />
            </a>
          );
        })}
      </div>
    </div>
  );
}
