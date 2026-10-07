/**
 * `.env` 的解析规则,只在这一处定义:`load-env.js` 用它,`prism.sh` 的 `read_env`
 * 用 sed 实现同一套规则(两边由同一份夹具测试钉着,见 server/tests/ops.test.ts)。
 *
 * `.env.example` 里不少行是 `# KEY=值  # 说明` 的写法,运维取消注释后若不剥行内注释,
 * `PRISM_X=1   # 说明` 的值就成了 `"1   # 说明"`,代码里 `=== '1'` 永远为假 —— 配了
 * 等于没配,而且没有任何报错。规则如下:
 *
 *   1. 空行、`#` 开头的行跳过;`export KEY=值` 的 `export` + 空白(空格或 Tab)前缀允许;
 *   2. 第一个 `=` 左边是键(trim),右边是原始值;
 *   3. 原始值以 `"` 或 `'` 开头时,取到配对的引号为止,引号后面的内容(通常是注释)丢掉;
 *      没有配对引号就当普通值处理;
 *   4. 不带引号的值:从前面有空白的 `#` 起截断(` # 说明`),再 trim。
 *      `abc#def` 这种紧贴的 `#` 不算注释 —— 口令里出现 `#` 很常见。
 *
 * 不做变量展开、不处理多行值:这个仓库的 .env 用不到,加了只会多一种出错方式。
 */

/**
 * 解析一行。返回 `{ key, value }`,不是赋值行(空行 / 注释 / 没有 `=`)返回 null。
 * @param {string} line
 * @returns {{ key: string, value: string } | null}
 */
export function parseDotEnvLine(line) {
  let text = String(line ?? '').replace(/\r$/, '').trim();
  if (!text || text.startsWith('#')) return null;
  // `export<空白>KEY=` 前缀:空白可以是空格或 Tab(与 prism.sh 的 `export[[:space:]]+` 一致)。
  text = text.replace(/^export\s+/, '');

  const eq = text.indexOf('=');
  if (eq <= 0) return null;
  const key = text.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  return { key, value: parseDotEnvValue(text.slice(eq + 1)) };
}

/**
 * 只解析 `=` 右边那一段。导出是为了让规则可以单独测。
 * @param {string} raw
 * @returns {string}
 */
export function parseDotEnvValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, 1);
    // 配对引号内的内容原样保留(含 ` #`);引号后面的一律丢掉。
    if (close > 0) return text.slice(1, close);
    // 没配对:退回普通值规则,但保留开头那个引号 —— 它多半就是值的一部分。
  }

  // ` #` 起是注释。只认前面有空白的 `#`,紧贴的 `#`(abc#def)是值。
  const hash = text.search(/\s#/);
  const body = hash >= 0 ? text.slice(0, hash) : text;
  return body.trim();
}

/**
 * 解析整份文件文本。后写的键覆盖先写的(与 shell `source` 语义一致,也与 prism.sh 的
 * `tail -1` 一致)。
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const parsed = parseDotEnvLine(line);
    if (parsed) out[parsed.key] = parsed.value;
  }
  return out;
}
