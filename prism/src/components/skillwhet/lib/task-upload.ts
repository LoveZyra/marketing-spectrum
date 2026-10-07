/**
 * 任务集导入的浏览器侧校验,与 SkillWhet `imports.validate_and_map` 同一套规则。
 *
 * 为什么前端也校一遍:粘贴 200 行、错在第 37 行,来回打服务端才知道太慢;这里逐行给
 * 结果,用户改完再提交。服务端仍是最终裁判(`POST /tasks/validate` 复校,`POST /tasks`
 * 入库时再校),所以这里判"通过"不等于一定能入库,只是把大部分低级错误就地拦住。
 *
 * 规则(与 Python 侧逐条对应,改一边记得改另一边):
 * - `input` / `prompt` 必填,空串不算;
 * - `expected_output` / `output` 二选一存在即可(0 / false / null 都是合法预期值),
 *   否则要 `rubric` ≥ 8 字;
 * - `task_id` / `id` 可选,给了就不许重复;
 * - `split` 只能是 train / val / test(及别名 learn / dev / holdout / eval);
 * - `checks` 若给必须是对象数组;
 * - CSV 里除 input / prompt 外的空单元格视为没给;
 * - 最多 5,000 行、5 MiB。
 */
import { swText } from './sw-text';

export type TaskFormat = 'json' | 'jsonl' | 'csv';

export type RowCheck = {
  row: number;
  taskId: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  referenceKind: 'exact' | 'rubric' | '';
  family: string;
};

export type LocalReport = {
  format: TaskFormat;
  rows: RowCheck[];
  passed: number;
  failed: number;
  /** 解析阶段就失败(不是 JSON、超限…),此时 rows 为空。 */
  fatal: string | null;
};

export const MAX_TASK_BYTES = 5 * 1024 * 1024;
export const MAX_TASK_ROWS = 5000;

const SPLIT_ALIASES = new Set(['train', 'learn', 'val', 'dev', 'test', 'holdout', 'eval']);
const CSV_JSON_COLUMNS = new Set(['input', 'prompt', 'expected_output', 'output', 'checks', 'context', 'metadata']);

export function detectFormat(fileName: string | null, content: string): TaskFormat {
  const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'csv') return 'csv';
  if (ext === 'json') return 'json';
  const trimmed = content.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    // 多行、每行都是对象 → jsonl
    const lines = trimmed.split('\n').filter((line) => line.trim());
    if (lines.length > 1 && lines.every((line) => line.trim().startsWith('{') && line.trim().endsWith('}'))) return 'jsonl';
    return 'json';
  }
  return 'csv';
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** 极简 CSV(支持引号与引号内逗号 / 换行),与 Python csv 模块的默认方言一致。 */
function parseCsv(content: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i += 1;
      record.push(field); field = '';
      records.push(record); record = [];
    } else {
      field += ch;
    }
  }
  if (field.length || record.length) { record.push(field); records.push(record); }
  const nonEmpty = records.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((cell) => cell.trim());
  return nonEmpty.slice(1).map((row) => {
    const out: Record<string, string> = {};
    header.forEach((key, index) => { if (key) out[key] = row[index] ?? ''; });
    return out;
  });
}

const isNumber = (value: string): boolean => value.trim() !== '' && Number.isFinite(Number(value));

/** `JSON.parse` 的报错只给 `position N`(V8)或 `line X column Y`(Firefox / 新 V8);统一算成行列。 */
export function jsonErrorLine(content: string, message: string): { line: number; column: number } | null {
  const lc = /line (\d+) column (\d+)/i.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/i.exec(message);
  if (!pos) return null;
  const index = Math.min(Number(pos[1]), content.length);
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

export function parseRows(content: string, format: TaskFormat): Record<string, unknown>[] {
  if (utf8Bytes(content) > MAX_TASK_BYTES) throw new Error(swText('skillwhet:tasks.err.tooBig', '文件超过 {{mib}} MiB', { mib: MAX_TASK_BYTES / (1024 * 1024) }));
  let rows: unknown[];
  if (format === 'json') {
    let data: unknown;
    try { data = JSON.parse(content); } catch (error) {
      // JSONL 里有一行坏掉时 detectFormat 会退成 JSON,而 JSON.parse 可能只报 `position N`:换算出行列;
      // 多行、过半以 { 开头的内容再提示可能是 JSONL、请手选格式。
      const message = error instanceof Error ? error.message : String(error);
      const at = jsonErrorLine(content, message);
      const lines = content.split('\n').filter((line) => line.trim());
      const looksJsonl = lines.length > 1 && lines.filter((line) => line.trim().startsWith('{')).length >= Math.ceil(lines.length / 2);
      throw new Error(swText('skillwhet:tasks.err.badJson', '不是合法 JSON{{at}}:{{message}}{{hint}}', {
        at: at ? swText('skillwhet:tasks.err.at', '(第 {{line}} 行第 {{column}} 列)', at) : '',
        message,
        hint: looksJsonl ? swText('skillwhet:tasks.err.looksJsonl', ' —— 看起来像 JSONL(一行一个对象),请把格式手动切成 jsonl 再看逐行结果') : '',
      }));
    }
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { tasks?: unknown }).tasks)) {
      data = (data as { tasks: unknown[] }).tasks;
    }
    if (!Array.isArray(data)) throw new Error(swText('skillwhet:tasks.err.topLevel', '顶层必须是 JSON 数组(或 {"tasks": [...]})'));
    rows = data;
  } else if (format === 'jsonl') {
    rows = [];
    content.split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try { rows.push(JSON.parse(line)); } catch (error) { throw new Error(swText('skillwhet:tasks.err.badLine', '第 {{n}} 行不是合法 JSON:{{message}}', { n: index + 1, message: error instanceof Error ? error.message : String(error) })); }
    });
  } else {
    rows = parseCsv(content).map((raw) => {
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        // 与 serve 同一口径:可选列留空当缺省(空 split / checks 不判失败);
        // 空 expected_output 等于没给,没有 rubric 时同样拒。
        if (value.trim() === '' && key !== 'input' && key !== 'prompt') continue;
        let parsed: unknown = value;
        if (CSV_JSON_COLUMNS.has(key) && (value.startsWith('{') || value.startsWith('['))) {
          try { parsed = JSON.parse(value); } catch { /* 留原串 */ }
        } else if ((key === 'expected_output' || key === 'output')) {
          const low = value.trim().toLowerCase();
          if (low === '0' || low === 'false' || low === 'null' || low === 'true' || isNumber(value)) {
            parsed = JSON.parse(['false', 'null', 'true'].includes(low) ? low : value.trim());
          }
        }
        row[key] = parsed;
      }
      return row;
    });
  }
  if (rows.length > MAX_TASK_ROWS) throw new Error(swText('skillwhet:tasks.err.tooMany', '超过 {{n}} 行', { n: MAX_TASK_ROWS }));
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) throw new Error(swText('skillwhet:tasks.err.rowNotObject', '每一行都必须是对象'));
  return rows as Record<string, unknown>[];
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

export function validateRows(rows: Record<string, unknown>[], format: TaskFormat): LocalReport {
  const seen = new Map<string, number>();
  const checks: RowCheck[] = rows.map((row, index) => {
    const n = index + 1;
    const errors: string[] = [];
    const warnings: string[] = [];
    const rawInput = row.input ?? row.prompt;
    if (rawInput === undefined || rawInput === null || (typeof rawInput === 'string' && !rawInput.trim())) errors.push(swText('skillwhet:tasks.err.noInput', '缺 input / prompt'));
    const hasExpected = 'expected_output' in row || 'output' in row;
    const rubric = row.rubric;
    const rubricOk = typeof rubric === 'string' && rubric.trim().length >= 8;
    if (!hasExpected && !rubricOk) errors.push(swText('skillwhet:tasks.err.noReference', '缺 expected_output(0 / false / null 都算合法值)或 rubric(≥ 8 字)'));
    let taskId = row.task_id ?? row.id;
    if (taskId !== undefined && taskId !== null && typeof taskId !== 'string') taskId = String(taskId);
    const tid = typeof taskId === 'string' && taskId ? taskId : '';
    if (tid && seen.has(tid)) errors.push(swText('skillwhet:tasks.err.dupId', 'task_id 重复(与第 {{n}} 行相同)', { n: seen.get(tid) }));
    const split = row.split;
    if (split !== undefined && split !== null && (typeof split !== 'string' || !SPLIT_ALIASES.has(split.toLowerCase()))) {
      errors.push(swText('skillwhet:tasks.err.badSplit', 'split 只能是 train / val / test(收到 {{got}})', { got: asText(split) }));
    }
    const rowChecks = row.checks;
    if (rowChecks !== undefined && rowChecks !== null) {
      if (!Array.isArray(rowChecks) || !rowChecks.every((item) => item && typeof item === 'object' && !Array.isArray(item))) errors.push(swText('skillwhet:tasks.err.badChecks', 'checks 必须是对象数组'));
    }
    if (hasExpected && rubricOk) warnings.push(swText('skillwhet:tasks.err.bothRefs', '同时给了 expected_output 与 rubric,以 expected_output 为准'));
    const familyRaw = row.group_id ?? row.family_id ?? '';
    const family = familyRaw === null || familyRaw === undefined ? '' : String(familyRaw);
    if (tid && !seen.has(tid)) seen.set(tid, n);
    return {
      row: n, taskId: tid || swText('skillwhet:tasks.err.autoId', '(自动 #{{n}})', { n }), ok: errors.length === 0, errors, warnings,
      referenceKind: errors.length ? '' : hasExpected ? 'exact' : 'rubric', family,
    };
  });
  const passed = checks.filter((check) => check.ok).length;
  return { format, rows: checks, passed, failed: checks.length - passed, fatal: null };
}

export function checkTasks(content: string, format: TaskFormat): LocalReport {
  try {
    return validateRows(parseRows(content, format), format);
  } catch (error) {
    return { format, rows: [], passed: 0, failed: 0, fatal: error instanceof Error ? error.message : String(error) };
  }
}

/** 只留通过的行,重新序列化成同一格式(csv 回成 json —— 列可能被解析成对象,回写 csv 不可靠)。 */
export function keepPassing(content: string, format: TaskFormat, report: LocalReport): { content: string; format: TaskFormat } {
  const rows = parseRows(content, format);
  const passing = rows.filter((_, index) => report.rows[index]?.ok);
  if (format === 'jsonl') return { content: passing.map((row) => JSON.stringify(row)).join('\n'), format };
  return { content: JSON.stringify(passing, null, 2), format: 'json' };
}

export const TASK_TEMPLATES: Record<'exact.json' | 'rubric.jsonl' | 'tasks.csv', string> = {
  'exact.json': JSON.stringify([
    { task_id: 'case-001', group_id: 'rate-a', input: { visits: 100, conversions: 8 }, expected_output: { rate: 0.08 } },
    { task_id: 'case-002', group_id: 'rate-a', input: { visits: 0, conversions: 0 }, expected_output: { rate: 0 } },
  ], null, 2),
  'rubric.jsonl': [
    JSON.stringify({ task_id: 'r-001', input: '把这份渠道明细做成周报表', rubric: '表格必须含「渠道」列;按周汇总;给出环比' }),
    JSON.stringify({ task_id: 'r-002', input: '按等长日窗比较两段销售额', rubric: '窗口不等长时要先追问;给出环比与绝对差' }),
  ].join('\n'),
  'tasks.csv': [
    'task_id,group_id,input,expected_output,split',
    'c-001,rate-a,"{""visits"":100,""conversions"":8}","{""rate"":0.08}",train',
    'c-002,rate-a,"{""visits"":0,""conversions"":0}",0,val',
  ].join('\n'),
};
