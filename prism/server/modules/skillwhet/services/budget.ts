/**
 * gz / he:技能优化的预算旋钮 —— `.env` 可调、有硬上限。表单值先被钳到这里再转发;
 * 夜训调度器用同一套上限,外加一晚合计 `PRISM_SKILLWHET_NIGHTLY_MAX_COST_USD`。
 *
 * hf2:`.env` 的单次上限是给**非 root**的;root 在表单 / 夜训设置里可以填得更高,
 * 最高到硬上限(费用 50 / 时长 24h),超过 `.env` 的那一次审计里记 `cost_override`。
 * 原来 root 填 10 也被悄悄压回 2,页面上看不出来。
 */
export const HARD_MAX_COST_USD = 50;
export const HARD_MAX_HOURS = 24;
/** hi:夜训单次的硬上限单独放宽到 100(手动训练仍是 50);一晚合计默认也提到 100。 */
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
    // hl(静态 P1-10):非 root 能指定的模型(逗号分隔);root 不受限。
    // hn(B7):**配了才是唯一口径**;没配时 = 三个别名 + 模型目录里上架的条目(见 model-policy.ts)。
    modelAllowlist: String(env.PRISM_SKILLWHET_MODEL_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean).length > 0
      ? String(env.PRISM_SKILLWHET_MODEL_ALLOWLIST).split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_MODEL_ALLOWLIST,
    modelAllowlistConfigured: String(env.PRISM_SKILLWHET_MODEL_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean).length > 0,
  };
};
