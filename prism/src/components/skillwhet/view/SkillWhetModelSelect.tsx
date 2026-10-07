import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { FancySelect } from '../../../shared/view/ui/FancySelect';
import type { ModelRow } from '../../../hooks/useTaskLikeOptions';
import { isValidModelId } from '../../../../shared/modelVendors';
import { isSkillWhetUsable, skillWhetModelRows } from '../lib/modelRows';

/**
 * SkillWhet 的模型下拉:与对话 /models 同一份目录(图标、显示名、网关名 + 窗口)。
 *
 * - `allowed` 为数组(非 root):只列允许的(`PRISM_SKILLWHET_MODEL_ALLOWLIST` 配了就是它;没配 = 三个别名 + 目录上架条目);
 *   名单里有、目录里没有的名字也列出来(纯文字行);
 * - `allowed` 为 null(root):列全部,还能在搜索框里手填任意合法模型名(服务端同样只校验字符集);
 * - 当前值不在列表里(老配置、已下架)也插一行,免得触发器上显示成空;
 * - 别名不当选项(与对话的模型菜单同一口径):`models` 在目录有条目时已不含别名,允许名单里的别名也不补成纯文字行
 *   (名单里没有可用目录模型时例外,见 skillWhetModelRows)。当前值恰好是别名(默认 haiku / sonnet / opus、老配置)时
 *   用 `aliasModels` 那一行显示:主行实际模型、副行别名;
 * - 只列默认网关上、所有人可见的模型(别的网关要某个人的 key、私有模型只归本人,SkillWhet 不跟着谁的 key 走),
 *   root 也一样;root 手填时也不收这两种的名字。当前值恰好是这种(老配置)时插一行,副行说明为什么不能选。
 */
export default function SkillWhetModelSelect({ value, onChange, models, aliasModels = [], allowed, ariaLabel, variant = 'field', className }: {
  value: string;
  onChange: (next: string) => void;
  /** `useModelCatalog().models`(目录有条目时只有目录条目;目录为空时是别名组;不含 default) */
  models: ModelRow[];
  /** `useModelCatalog().aliasModels`:收起来的别名行,只用于显示当前值 */
  aliasModels?: ModelRow[];
  /** null / undefined = 不限(root);数组 = 只许这些 */
  allowed: string[] | null | undefined;
  ariaLabel: string;
  variant?: 'chip' | 'field';
  className?: string;
}) {
  const { t } = useTranslation('skillwhet');
  const options = useMemo(() => {
    const rows = skillWhetModelRows(models, aliasModels, allowed);
    if (value && !rows.some((row) => row.value === value)) {
      const aliasRow = aliasModels.find((model) => model.value === value);
      if (aliasRow) return [aliasRow, ...rows];
      // 在目录里、但 SkillWhet 用不了(别的网关 / 私有):照它的名字显示,副行说明原因,不当可选项
      const excluded = models.find((model) => model.value === value && !isSkillWhetUsable(model));
      if (excluded) {
        return [{ value, label: excluded.label, icon: excluded.icon, disabled: true, sublabel: t('models.defaultGatewayOnly') }, ...rows];
      }
      return [{ value, label: value, mono: true, sublabel: t('models.notInCatalog', { defaultValue: '不在模型目录里' }) }, ...rows];
    }
    return rows;
  }, [models, aliasModels, allowed, value, t]);
  // root 手填:被筛掉的那些名字(别的网关 / 私有)不给「使用」这一行
  const excludedNames = useMemo(
    () => new Set(models.filter((model) => !isSkillWhetUsable(model)).map((model) => model.value)),
    [models],
  );

  const unrestricted = !Array.isArray(allowed);
  return (
    <FancySelect
      value={value}
      options={options}
      onChange={onChange}
      variant={variant}
      className={className}
      searchable
      ariaLabel={ariaLabel}
      searchPlaceholder={unrestricted
        ? t('models.searchOrType', { defaultValue: '搜索,或直接填网关模型名' })
        : t('models.search', { defaultValue: '搜索模型' })}
      customOption={unrestricted
        ? (query) => (isValidModelId(query) && !excludedNames.has(query) ? t('models.useCustom', { defaultValue: '使用「{{name}}」', name: query }) : null)
        : undefined}
    />
  );
}
