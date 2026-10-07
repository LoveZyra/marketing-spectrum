import type { FancyOption } from '../../../shared/view/ui/FancySelect';
import type { ModelRow } from '../../../hooks/useTaskLikeOptions';

/**
 * SkillWhet 能用的模型 = 默认网关上、所有人可见的模型。别的网关上的(`gatewayId` > 0)要用某个人的 key,
 * 私有模型只有本人能用;SkillWhet 的训练 / 夜训不跟着哪个人的 key 走,这两种一律不列(root 也一样)。
 */
export const isSkillWhetUsable = (row: ModelRow): boolean =>
  !row.private && !(typeof row.gatewayId === 'number' && row.gatewayId > 0);

/**
 * SkillWhet 模型下拉的可选行(纯函数,单测见 modelRows.test.ts)。
 *
 * - 先筛掉 SkillWhet 用不了的(见 isSkillWhetUsable);
 * - `allowed` 为 null / undefined(root):目录条目(`models`,目录有条目时已不含别名);
 * - `allowed` 为数组(非 root):只列允许的目录条目;名单里有、目录里没有的名字作纯文字行;
 *   别名不当选项(与对话的模型菜单同一口径),但名单里没有任何可用的目录模型(比如显式配成
 *   haiku,sonnet,opus)时,别名就是仅有的选项,照给,否则下拉只剩当前值、改不了。
 *   名单里的名字恰好是被筛掉的模型(别的网关 / 私有)时也不补成纯文字行:它在目录里,只是 SkillWhet 用不了。
 */
export function skillWhetModelRows(
  models: ModelRow[],
  aliasModels: ModelRow[],
  allowed: string[] | null | undefined,
): FancyOption[] {
  const usable = models.filter(isSkillWhetUsable);
  if (!Array.isArray(allowed)) return usable;
  const allowedCatalog = usable.filter((model) => allowed.includes(model.value));
  const allowedAliases = allowedCatalog.length === 0
    ? aliasModels.filter((model) => isSkillWhetUsable(model) && allowed.includes(model.value))
    : [];
  return [
    ...allowedCatalog,
    ...allowedAliases,
    ...allowed
      .filter((name) => !models.some((model) => model.value === name) && !aliasModels.some((model) => model.value === name))
      .map((name) => ({ value: name, label: name, mono: true })),
  ];
}
