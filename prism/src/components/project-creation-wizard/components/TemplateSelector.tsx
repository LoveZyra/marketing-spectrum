import { useEffect, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatBytes } from '../../../utils/formatBytes';
import { fetchProjectTemplates } from '../data/workspaceApi';
import type { ProjectTemplate } from '../types';

/**
 * 从模板创建。
 *
 * ## 没有模板时整块不渲染
 *
 * 模板是运维往 `PRISM_PROJECT_TEMPLATES_DIR` 里放的东西,大多数部署一开始没有。
 * 显示一个只有「不使用模板」一项的下拉,是在向导里塞一个永远没用的控件 ——
 * 每个新建项目的人都要多看它一眼、多想一秒"这是什么"。没有就不画。
 */

type TemplateSelectorProps = {
  value: string;
  disabled?: boolean;
  onChange: (templateId: string) => void;
};

export default function TemplateSelector({ value, disabled, onChange }: TemplateSelectorProps) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectTemplates().then((list) => { if (!cancelled) setTemplates(list); });
    return () => { cancelled = true; };
  }, []);

  // null = 还没拉到;空数组 = 这台服务器没配模板。两种都不画。
  if (templates === null || templates.length === 0) return null;

  const selected = templates.find((template) => template.id === value) ?? null;

  return (
    <div>
      <label className="mb-2 flex items-center gap-1.5 text-sm font-medium text-body">
        <LayoutTemplate className="h-3.5 w-3.5 text-muted-foreground" />
        {t('projectWizard.template.label', '从模板创建')}
      </label>

      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-body focus:border-border-strong focus:outline-none disabled:opacity-50"
      >
        <option value="">{t('projectWizard.template.none', '不使用模板(空目录)')}</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>

      <p className="mt-1 text-xs text-muted-foreground">
        {selected
          ? [
              selected.description,
              t('projectWizard.template.stats', {
                count: selected.fileCount,
                size: formatBytes(selected.totalBytes),
                defaultValue: `${selected.fileCount} 个文件 · ${formatBytes(selected.totalBytes)}`,
              }),
            ].filter(Boolean).join(' · ')
          : t('projectWizard.template.help',
              '模板会把一棵现成的目录树复制进新项目(CLAUDE.md、目录结构等)。目标目录里已存在的同名文件不会被覆盖。')}
      </p>
    </div>
  );
}
