/**
 * 工具详情区(参数 / 返回)的纯函数:JSON 着色分词 与 返回值形态判定。
 *
 * 放在这里而不是组件里,是为了能单测 —— 详情区的坑全在"这段文本到底是什么"
 * 的判断上,而不在样式。
 */

export type JsonTokenKind = 'key' | 'string' | 'literal' | 'plain';

export type JsonToken = {
  kind: JsonTokenKind;
  text: string;
};

// 一次扫过:带冒号的字符串是键,不带的是值;数字与 true/false/null 归为字面量。
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let cursor = 0;

  JSON_TOKEN.lastIndex = 0;
  let match = JSON_TOKEN.exec(text);
  while (match !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'plain', text: text.slice(cursor, match.index) });
    }

    const [, quoted, colon, num, literal] = match;
    if (quoted !== undefined) {
      tokens.push({ kind: colon ? 'key' : 'string', text: quoted });
      if (colon) tokens.push({ kind: 'plain', text: colon });
    } else if (num !== undefined) {
      tokens.push({ kind: 'literal', text: num });
    } else if (literal !== undefined) {
      tokens.push({ kind: 'literal', text: literal });
    }

    cursor = match.index + match[0].length;
    match = JSON_TOKEN.exec(text);
  }

  if (cursor < text.length) {
    tokens.push({ kind: 'plain', text: text.slice(cursor) });
  }

  return tokens;
}

export type ResultShape =
  /** 没有输出 —— 一行弱化文字就够,不要给一个空盒子 */
  | { kind: 'empty' }
  /** 能解析的 JSON —— 缩排 + 着色 */
  | { kind: 'json'; text: string; lines: number }
  /** 一句话的结果(`Cancelled job 15082b3a` 这种)—— 直接一行,不套框 */
  | { kind: 'line'; text: string }
  /** 其余多行文本 / 日志 —— 等宽块 + 折叠 */
  | { kind: 'text'; text: string; lines: number };

const SINGLE_LINE_LIMIT = 120;

export function detectResultShape(raw: unknown): ResultShape {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
      return { kind: 'json', text: pretty, lines: pretty.split('\n').length };
    } catch {
      // 不是合法 JSON,按文本走
    }
  }

  if (!trimmed.includes('\n') && trimmed.length <= SINGLE_LINE_LIMIT) {
    return { kind: 'line', text: trimmed };
  }

  return { kind: 'text', text, lines: text.split('\n').length };
}

export type ParamRow = {
  key: string;
  /** 单行短值,直接排在键右边 */
  inline?: string;
  /** 多行 / 长文本 / 结构化值,排在键下面 */
  block?: { text: string; lines: number; isJson: boolean };
};

const INLINE_LIMIT = 96;

/** 把工具入参摊成"键 → 值"的行。对象与数组缩排成 JSON 放在块里。 */
export function toParamRows(input: unknown): ParamRow[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    const text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    return [{ key: '', block: { text, lines: text.split('\n').length, isJson: typeof input !== 'string' } }];
  }

  return Object.entries(input as Record<string, unknown>).map(([key, value]) => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return { key, inline: String(value) };
    }

    if (typeof value === 'string') {
      if (!value.includes('\n') && value.length <= INLINE_LIMIT) {
        return { key, inline: value };
      }
      return { key, block: { text: value, lines: value.split('\n').length, isJson: false } };
    }

    const text = JSON.stringify(value, null, 2) ?? String(value);
    return { key, block: { text, lines: text.split('\n').length, isJson: true } };
  });
}
