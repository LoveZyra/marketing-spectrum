import { DEFAULT_GATEWAY_ID, claudeModelCatalog } from '@/modules/providers/index.js';

import { isValidModelId } from '../../../../shared/modelVendors.js';

import { DEFAULT_MODEL_ALLOWLIST } from './budget.js';

/**
 * SkillWhet 的模型从模型目录选。
 *
 * SkillWhet 的 Python 端接受任意模型名(`claude -p --model <名>`),限制全在 Prism:
 * - 非 root:配置了 `PRISM_SKILLWHET_MODEL_ALLOWLIST` 就只认它(条目可以写目录里的网关名);
 *   没配置 = 三个别名 haiku / sonnet / opus + 模型目录里上架的条目,与对话里能选的一致;
 * - root:不受限,但名字仍要过字符集校验(它要进 argv,不能以 `-` 开头)。
 */
export const SKILLWHET_MODEL_KEYS = ['fast_model', 'slow_model', 'eval_model', 'target_model'] as const;

/** SkillWhet CLI 不传时的默认(`skillwhet/cli.py`):fast=haiku、slow=sonnet、eval=opus;target 缺省 = fast。 */
export const SKILLWHET_MODEL_DEFAULTS = { fast_model: 'haiku', slow_model: 'sonnet', eval_model: 'opus' } as const;

type Budget = { modelAllowlist: string[]; modelAllowlistConfigured: boolean };

/** 非 root 可选的模型(给页面下拉用;root 返回 null = 不限)。 */
export function allowedSkillWhetModels(budget: Budget, root: boolean): string[] | null {
  if (root) return null;
  if (budget.modelAllowlistConfigured) return [...budget.modelAllowlist];
  return [...DEFAULT_MODEL_ALLOWLIST, ...skillWhetCatalogModels()];
}

/**
 * SkillWhet 只能用默认网关(settings.json)上、未限定可用人员的目录模型:SkillWhet 是另一个进程,
 * 里面的 `claude -p` 只读 settings.json,连不上挂在别的网关上的模型;
 * 限定了「可用人员」的模型也不能借 SkillWhet 绕过去。
 */
export function skillWhetCatalogModels(): string[] {
  return claudeModelCatalog.listEnabled()
    .filter((entry) => entry.gatewayId === DEFAULT_GATEWAY_ID && entry.allowedUsers === null)
    .map((entry) => entry.modelId);
}

export function isSkillWhetModelAllowed(model: string, budget: Budget, root: boolean): boolean {
  if (!isValidModelId(model)) return false;
  const allowed = allowedSkillWhetModels(budget, root);
  return allowed === null || allowed.includes(model);
}

/**
 * 夜训配置里在目录中、但已下架的模型(key=名字)。夜训计划是 root 配的(root 不受目录限制),
 * 所以只拦"明确下架"的:目录里压根没有的名字照旧放行;不自动换成别的模型 —— 换模型会改变训练结论。
 */
export function disabledCatalogModelsIn(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of SKILLWHET_MODEL_KEYS) {
    const value = config[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const entry = claudeModelCatalog.lookup(value.trim());
    if (entry && !entry.enabled) out.push(`${key}=${value.trim()}`);
  }
  return out;
}

/** 别名换成真名(`opus` → 它映射到的网关模型);不是别名原样返回。 */
async function realModelOf(model: string): Promise<string> {
  const { realModel } = await claudeModelCatalog.resolveEntry(model);
  return realModel ?? model;
}

/**
 * 评估模型必须与提议模型不同(SkillEvo 的 Generator ≠ Evaluator 约束),且按真名比较:
 * 别名可能映射到目录里的另一个名字(如 `opus` → `glm-5.2`),按字符串比会放过同一个模型给自己的提议打分。
 * 没填的角色按 SkillWhet 的默认补上再比。返回冲突说明,没冲突返回 null。
 */
export async function proposerEvaluatorConflict(config: Record<string, unknown>): Promise<string | null> {
  const pick = (key: 'fast_model' | 'slow_model' | 'eval_model'): string => {
    const value = config[key];
    return typeof value === 'string' && value.trim() ? value.trim() : SKILLWHET_MODEL_DEFAULTS[key];
  };
  const evaluator = pick('eval_model');
  const evaluatorReal = await realModelOf(evaluator);
  for (const key of ['fast_model', 'slow_model'] as const) {
    const proposer = pick(key);
    if ((await realModelOf(proposer)) === evaluatorReal) {
      return `评估模型要和提议模型不同:${key}=${proposer} 与 eval_model=${evaluator} 实际都是「${evaluatorReal}」`;
    }
  }
  return null;
}
