import { AppError } from '@/shared/utils.js';

/**
 * gy:Prism → `whet serve` 的回环 HTTP 客户端。
 *
 * serve 不认识用户:它只验共享口令。所以**权限判断全在 Prism 的路由里**,这里只管转、
 * 把它的错误映射成 AppError(状态码与 error 码原样带回,前端一句人话)。
 * serve 没起来 / 超时 → 503 `SKILLWHET_UNAVAILABLE`,不让整条路由变成 500。
 */
export type SkillWhetClientConfig = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
};

export type SkillWhetEnvelope<T = unknown> = { ok: true; data: T } | { ok: false; error: string; message: string; [key: string]: unknown };

/**
 * hl(动态 P3 中英混排):serve 的错误是英文,原来原样透传到页面。常见的几条在这里映射成中文;
 * 没映射到的仍原样带回(英文总比没有强)。`message` 是 serve 的原话,映射时可从中抽细节。
 */
const MESSAGES: Record<string, (raw: string, extra: Record<string, unknown>) => string> = {
  ALREADY_MANAGED: () => '已经有同名的受管副本 —— 先移除它,或换个名字',
  NAME_MISMATCH: (raw) => { const m = /declares name '([^']+)' but the folder is '([^']+)'/.exec(raw); return m ? `SKILL.md 里声明的名字是「${m[1]}」,与技能名「${m[2]}」不一致` : 'SKILL.md 里声明的名字与技能名不一致'; },
  NO_SKILL_MD: () => '包里根目录没有 SKILL.md',
  HAS_EVO: () => '包里不能带 .evo/(那是训练状态目录)',
  BAD_PATH: (raw) => `包里有不安全的路径:${raw.replace(/^refusing path\s*/, '')}`,
  DUP_PATH: () => '包里有重复的路径',
  BAD_B64: () => '包里有文件不是合法的 base64',
  FILE_TOO_BIG: (raw) => `单个文件超过上限(${raw})`,
  TOO_BIG: () => '整个包超过 30 MiB',
  TOO_MANY_FILES: () => '包里文件太多(最多 500 个)',
  NO_FILES: () => '包是空的',
  NOT_MANAGED: (raw) => { const m = /'([^']+)'/.exec(raw); return `没有「${m?.[1] ?? '?'}」的受管副本`; },
  NOT_BOOTSTRAPPED: () => '这个副本还没 bootstrap(冻结 S₀)—— 先在技能资产里点 bootstrap',
  NO_TASKS: () => '这个副本没有任务集(或任务集为空)—— 先导入或派生任务',
  // serve 原话两种:`'s' has no tests/unit/` 与 `no tests collected under tests/unit/`(复核 P3:原来的正则只认前一种的一部分)
  NO_TESTS: (raw) => {
    const dir = /(tests\/[A-Za-z0-9_-]+)\/?/.exec(raw)?.[1];
    if (/no tests collected/.test(raw)) return `${dir ?? 'tests'}/ 下没有收集到测试,派生不出任务`;
    return dir ? `副本里没有 ${dir}/,派生不出任务` : '没有收集到测试,派生不出任务';
  },
  NO_TEST_TASKS: () => '任务集里没有 test 划分的任务,做不了留出集评估',
  ALREADY_ADOPTED: () => '这份 staging 已经采纳过了,没有可比的',
  TEST_CONSUMED: () => '这份 staging 的留出集评估已经做过一次(留出集只能看一次)',
  STAGING_NOT_FOUND: () => '找不到这份 staging',
  ADOPT_REFUSED: (raw) => {
    if (/backup already exists/.test(raw)) return '这份 staging 已经采纳过了';
    if (/NOT accepted/.test(raw)) return '这一轮没有超过 S₀,没有可采纳的;要硬采纳请勾「强制」';
    if (/live skill changed since staging/.test(raw)) return `副本在训练之后被改过(${raw.replace(/^live skill changed since staging:\s*/, '').replace(/ — .*$/, '')})—— 重新训练,或勾「强制」覆盖`;
    if (/no release evaluation/.test(raw)) return '这份 staging 还没做留出集评估 —— 先评估,或勾「跳过留出集」';
    if (/changed after the release evaluation/.test(raw)) return '留出集评估之后 proposed 里的文件变了 —— 重新训练';
    return `采纳被拒绝:${raw}`;
  },
  JOB_DUPLICATE: (raw) => { const m = /already has (\w+) job (\S+) \((\w+)\)/.exec(raw); return m ? `这个 skill 已有 ${m[1]} 作业 ${m[2]}(${m[3] === 'running' ? '在跑' : '排队中'})` : '这个 skill 已有同类作业在排队 / 在跑'; },
  JOB_NOT_LIVE: () => '作业已经结束,不能取消',
  JOB_NOT_FOUND: () => '找不到这个作业',
  JOB_ACTIVE: (raw, extra) => `这个 skill 有作业在${extra.state === 'running' ? '跑' : '排队'}(${String(extra.job_id ?? '')}),先取消或等它结束`,
  NOT_IMPORTABLE: (raw) => (/dry-run/.test(raw) ? '这是一次试挖(dry-run),只列会话不出任务;真挖一次再入库' : '只有跑完的挖任务作业能入库'),
  ALREADY_IMPORTED: () => '这次挖出来的任务已经入库过了',
  NOTHING_TO_IMPORT: () => '没有选中可判分的任务',
  ROWS_INVALID: (raw) => { const m = /^(\d+) row/.exec(raw); return `${m ? `${m[1]} 行` : '有行'}没通过校验;改好再传,或勾「只入库通过的」`; },
  BAD_ALLOW: () => '第三方模块名不合法(只能是 a.b_c 这样的模块名)',
  LIVE_MISSING: () => '技能库里没有这个目录',
  LIVE_HAS_EVO: () => '技能库目录里已经有 .evo/(训练状态)—— 先把它移出去',
  BAD_SPLIT: () => 'val / test 比例要是 0–0.5 的数',
  TOO_MANY_ROWS: () => '任务超过 5000 行',
  BAD_FORMAT: () => '格式只能是 json / jsonl / csv',
  RECORD_TAMPERED: () => '这份副本的受管记录没通过校验(可能被副本里的代码改过)—— 请移除副本后重新导入 / 上传',
  BAD_QUERY: (raw) => `查询参数不对:${raw}`,
};

export function translateServeError(code: string, raw: string, extra: Record<string, unknown> = {}): string {
  const fn = MESSAGES[code];
  if (!fn) return raw;
  try {
    return fn(raw, extra);
  } catch {
    return raw;
  }
}

export class SkillWhetClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: SkillWhetClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 8_000;
  }

  async request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-skillwhet-token': this.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? '超时' : (error instanceof Error ? error.message : String(error));
      throw new AppError(`技能优化服务没有应答(${reason})。它由 Prism 随服务拉起;看 prism.log 里 [skillwhet] 开头的几行。`, {
        code: 'SKILLWHET_UNAVAILABLE',
        statusCode: 503,
      });
    } finally {
      clearTimeout(timer);
    }
    let payload: SkillWhetEnvelope<T>;
    try {
      payload = await response.json() as SkillWhetEnvelope<T>;
    } catch {
      throw new AppError(`技能优化服务返回了不是 JSON 的东西(HTTP ${response.status})`, {
        code: 'SKILLWHET_BAD_RESPONSE',
        statusCode: 502,
      });
    }
    if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
      throw new AppError('技能优化服务返回了看不懂的信封', { code: 'SKILLWHET_BAD_RESPONSE', statusCode: 502 });
    }
    if (payload.ok !== true) {
      const status = response.status >= 400 && response.status < 600 ? response.status : 502;
      const raw = String(payload.message || payload.error || '技能优化服务拒绝了这个请求');
      throw new AppError(translateServeError(String(payload.error || ''), raw, payload), {
        code: `SKILLWHET_${String(payload.error || 'ERROR')}`,
        statusCode: status,
        details: { ...payload, raw_message: raw },
      });
    }
    return payload.data;
  }

  /** gz:二进制体(staging 导出的 tar.gz)。错误仍是 JSON 信封,照常映射。 */
  async requestRaw(path: string, timeoutMs?: number): Promise<{ data: Buffer; filename: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET', headers: { 'x-skillwhet-token': this.token }, signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? '超时' : (error instanceof Error ? error.message : String(error));
      throw new AppError(`技能优化服务没有应答(${reason})`, { code: 'SKILLWHET_UNAVAILABLE', statusCode: 503 });
    } finally {
      clearTimeout(timer);
    }
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || type.includes('application/json')) {
      const payload = (await response.json().catch(() => null)) as SkillWhetEnvelope | null;
      const raw = payload && 'message' in payload ? String(payload.message) : `HTTP ${response.status}`;
      const serveCode = payload && 'error' in payload ? String(payload.error) : '';
      const code = serveCode ? `SKILLWHET_${serveCode}` : 'SKILLWHET_BAD_RESPONSE';
      throw new AppError(translateServeError(serveCode, raw, (payload ?? {}) as Record<string, unknown>), { code, statusCode: response.status >= 400 && response.status < 600 ? response.status : 502 });
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    return { data: Buffer.from(await response.arrayBuffer()), filename: match ? match[1] : null };
  }

  /** healthz 不带口令;serve 不在时返回 null 而不是抛。 */
  async health(): Promise<Record<string, unknown> | null> {
    try {
      return await this.request<Record<string, unknown>>('GET', '/healthz');
    } catch {
      return null;
    }
  }
}
