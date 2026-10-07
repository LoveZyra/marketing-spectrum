/**
 * 技能优化的预算旋钮:`.env` 可调,有硬上限。表单值先钳到这里再转发;
 * 夜训调度器用同一套上限,外加一晚合计 `PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD`。
 *
 * `.env` 的单次上限只约束非 root;root 在表单 / 夜训设置里可以填到硬上限(费用 50 / 时长 24h),
 * 超过 `.env` 上限的那一次在审计里记 `cost_override`。
 */
export const HARD_MAX_COST_USD = 50;
export const HARD_MAX_HOURS = 24;
/** 夜训单次的硬上限单独设为 100(手动训练是 50);一晚合计的默认值也是 100。 */
export const NIGHTLY_HARD_MAX_COST_USD = 100;
export const NIGHTLY_MAX_ROUNDS = 20;
export const DEFAULT_MODEL_ALLOWLIST = ['haiku', 'sonnet', 'opus'];

export const readBudget = (env: NodeJS.ProcessEnv) => {
  const num = (key: string, fallback: number, hard: number) => {
    const raw = Number.parseFloat(String(env[key] ?? ''));
    return Math.min(hard, Number.isFinite(raw) && raw > 0 ? raw : fallback);
  };
  return {
    maxCostUsd: num('PRISM_SKILLWHET_MAX_COST_USD', 2, HARD_MAX_COST_USD),
    maxHours: num('PRISM_SKILLWHET_MAX_HOURS', 2, HARD_MAX_HOURS),
    hardMaxCostUsd: HARD_MAX_COST_USD,
    hardMaxHours: HARD_MAX_HOURS,
    maxWorkers: Math.round(num('PRISM_SKILLWHET_MAX_WORKERS', 2, 8)),
    userDailyMaxCostUsd: num('PRISM_SKILLWHET_USER_DAILY_MAX_COST_USD', 2, 500),
    nightlyMaxCostUsd: num('PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD', 100, 500),
    nightlyHardMaxCostUsd: NIGHTLY_HARD_MAX_COST_USD,
    nightlyMaxRounds: NIGHTLY_MAX_ROUNDS,
    // 非 root 能指定的模型(逗号分隔);root 不受限。
    // 配置了就是唯一口径;没配置时 = 三个别名 + 模型目录里上架的条目(见 model-policy.ts)。
    modelAllowlist: String(env.PRISM_SKILLWHET_MODEL_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean).length > 0
      ? String(env.PRISM_SKILLWHET_MODEL_ALLOWLIST).split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_MODEL_ALLOWLIST,
    modelAllowlistConfigured: String(env.PRISM_SKILLWHET_MODEL_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean).length > 0,
  };
};
