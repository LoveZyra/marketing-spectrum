/**
 * hl(复核 P2-4):非 root 起训练 / 派生任务 / 留出集评估、上传来源的夜训,都要最近一次体检 G1 PASS。
 * 原来四处各写一遍判断、报错只说「G1 是 SKIP」——serve 0.5.2 起缺 bandit 时 G1 记 SKIP(不算通过),
 * 用户看不出是**服务器没装工具**而不是 skill 有问题。这里统一判断,并把缺的工具与装法写进中文报错。
 */
export type GateCache = {
  cached?: boolean;
  results?: Array<{ gate: string; verdict: string; detail?: Record<string, unknown> }>;
};

const INSTALL: Record<string, string> = {
  bandit: 'pip install bandit',
  ruff: 'pip install ruff',
  pyright: 'pip install pyright',
  pytest: 'pip install pytest pytest-timeout',
};

/** G1 没过的原因(中文,一句话);过了返回 null。`what` 是被拦的动作,如「起训练」。 */
export function g1Problem(gate: GateCache | null | undefined, what: string): string | null {
  const g1 = (gate?.results ?? []).find((r) => r.gate === 'G1.security');
  if (gate?.cached && g1 && g1.verdict === 'pass') return null;
  if (!gate?.cached || !g1) return `还没体检过;先「重跑体检」拿到 G1 PASS 再${what}`;
  const missing = Array.isArray(g1.detail?.missing_tools) ? (g1.detail?.missing_tools as unknown[]).map(String) : [];
  if (g1.verdict === 'skip' && missing.length > 0) {
    return `G1 安全门没查成:服务器上缺 ${missing.join(' / ')}(${missing.map((t) => INSTALL[t] ?? `安装 ${t}`).join(';')},装进运行 SkillWhet 的那个 Python)—— 请管理员装好后重跑体检,再${what}`;
  }
  return `G1 安全门是 ${g1.verdict.toUpperCase()},非 root 不能${what} —— 修好再体检`;
}
