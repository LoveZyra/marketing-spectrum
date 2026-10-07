/** 别名映射的两份来源,都出自 `/api/providers/claude/model-mappings`。 */
export interface AliasMappingSources {
  /** 实测映射(`mappings`)。 */
  probed: Record<string, { actualModel?: string | null } | undefined>;
  /** 配置映射(`configMappings`,读 settings.json)。 */
  configured: Record<string, { configuredModel?: string | null } | undefined>;
  /** settings.json 在上次实测后改过:实测值可能过期。 */
  stale: boolean;
}

/**
 * 别名(default / sonnet / opus / haiku …)此刻实际打到哪个模型。
 *
 * 全应用只有这一份判据:输入框的模型芯片、模型菜单别名行的「→」、`/models` 弹窗、
 * 定时任务 / SkillWhet 的模型下拉都用它。各写一份的话,网关把配置的 X 改写成 Y 时,
 * 同一个人在两处会看到两个不同的"实际模型"。
 *
 * 优先级:新鲜的实测 > 配置映射 > 不知道(null)。
 *   - 实测是端到端真相:用户关心的是"到底是谁在答";
 *   - 实测过期(settings 在上次实测后改过)时不用它,这时配置映射恰好是新值,正好补位。
 *
 * 判"是不是同一个模型"(proposer / evaluator 冲突)不走这里,只看配置映射,与服务端同一口径。
 */
export function resolveAliasReal(alias: string, { probed, configured, stale }: AliasMappingSources): string | null {
  const probedModel = stale ? null : (probed[alias]?.actualModel ?? null);
  return probedModel ?? configured[alias]?.configuredModel ?? null;
}
