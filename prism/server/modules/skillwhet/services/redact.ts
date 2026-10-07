/**
 * 反馈原文离开 Prism 之前先脱敏,规则与 SkillWhet `harvest.redact()` 一致
 * (那边 harvest 时还会再过一遍;两道都在,任一边漏了另一边兜底)。
 * 覆盖 URL 内嵌凭据、`key=value` 与 JSON 引号形式、`ticket`、中文键名(密码 / 口令 / 密钥 / 秘钥 / 令牌 / 凭证)、
 * 全角冒号;键值形式的取值至少 4 个字符才脱敏。
 */
// 键名像密钥、取值却显然不是密钥的(`max_tokens: 4096`、`credential_type: oauth`)不脱敏;
// 口令类的键(password / 密码 / 口令)取值是纯数字仍脱敏(可能就是 PIN)。与 SkillWhet harvest._keep_or_redact 同一口径。
const NON_SECRET_VALUES = new Set([
  'oauth', 'oauth2', 'bearer', 'basic', 'digest', 'jwt', 'hmac', 'none', 'null', 'true', 'false',
  'required', 'optional', 'enabled', 'disabled', 'default', 'auto', 'string', 'str', 'int', 'integer',
  'env', 'file', 'header', 'query', 'cookie', 'password', 'token', 'secret', 'api_key', 'apikey',
  'redacted', '[redacted]', 'xxxx', '****', '<redacted>', 'example', 'changeme',
]);
const NUMBER = /^[+-]?\d+(?:[.,_]\d+)*[kKmM]?$/;

function keepOrRedact(match: string, key: string, rawValue: string, replacement: string): string {
  const value = rawValue.replace(/[,;]+$/, '');
  const lowKey = key.toLowerCase();
  const numericOk = !['password', 'passwd', '密码', '口令'].some((w) => lowKey.includes(w));
  if ((numericOk && NUMBER.test(value)) || NON_SECRET_VALUES.has(value.toLowerCase()) || value.startsWith('[REDACTED')) return match;
  return replacement;
}

type Replacer = string | ((substring: string, ...args: string[]) => string);
const PATTERNS: Array<[RegExp, Replacer]> = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED:anthropic]'],
  [/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED:openai]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack]'],
  [/AIza[0-9A-Za-z_-]{30,}/g, '[REDACTED:google]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:pem]'],
  // scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, '$1[REDACTED]@'],
  [/([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|authorization|credential|ticket)[A-Za-z0-9_-]*)(\s*[:=:=]\s*['"]?)([^\s'"]{4,})/gi,
    (m: string, k: string, _s: string, v: string) => keepOrRedact(m, k, v, `${k}=[REDACTED]`)],
  [/"([A-Za-z0-9_.-]*(?:apikey|api_key|accesstoken|access_token|token|password|secret|authorization|credential|ticket)[A-Za-z0-9_-]*)"(\s*:\s*")([^"]{4,})"/gi,
    (m: string, k: string, _s: string, v: string) => keepOrRedact(m, k, v, `"${k}": "[REDACTED]"`)],
  [/((?:登录|数据库|管理员|账[号户]|root|admin)?\s*(?:密码|口令|密钥|秘钥|令牌|凭证))(\s*(?:[:=:=]|是)\s*['"「]?)([^\s'"「」,,;;。]{4,})/g,
    (m: string, k: string, _s: string, v: string) => keepOrRedact(m, k, v, `${k}:[REDACTED]`)],
  [/"((?:密码|口令|密钥|秘钥|令牌|凭证)[^"]{0,20})"(\s*:\s*")([^"]{4,})"/g,
    (m: string, k: string, _s: string, v: string) => keepOrRedact(m, k, v, `"${k}": "[REDACTED]"`)],
];

export function redactSecrets(text: string | null | undefined): string {
  let out = String(text ?? '');
  for (const [rx, repl] of PATTERNS) out = out.replace(rx, repl as never);
  return out;
}
