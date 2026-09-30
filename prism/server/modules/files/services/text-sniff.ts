import { promises as fsPromises } from 'node:fs';

/**
 * hk(审计 P1-6 / P2-7 / P2-8):编辑器读写前,先看一眼文件**是不是能安全当 UTF-8 文本编辑的**。
 *
 * 原来编辑器只按扩展名判二进制:`.pkl / .npy / .pt / .parquet / .h5`、没有扩展名的文件、GBK 编码的
 * csv / txt 都被 `readFile(…, 'utf8')` 读进来,非法字节变成替换字符 U+FFFD;用户按一次 Ctrl+S,
 * 整个文件就被写成替换字符 —— 不可逆(探针:8 字节变 14 字节)。算法团队这类文件很多。
 *
 * 判据:
 * - **二进制**:前 8KB 里有 NUL 字节(与 git / grep 同一判据);
 * - **非 UTF-8 文本**:整份按 UTF-8 严格解码失败 —— 多半是 GBK(国内 Excel 导出的 csv 默认就是);
 * - **换行符**:CRLF 行占多数就记为 crlf,保存时还原(CodeMirror 一律按 \n 存,改一个字整份变 LF)。
 */

/** 编辑器最多打开多大的文件。超了返回 413,只给下载 —— 几百 MB 的日志整份读进内存再 JSON 序列化会拖住整个服务。 */
export const EDITOR_MAX_BYTES = (() => {
  const raw = Number.parseInt(process.env.PRISM_EDITOR_MAX_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 1024 * 1024;
})();

const SNIFF_BYTES = 8 * 1024;

export type TextSniff = {
  binary: boolean;
  /** 整份是合法 UTF-8(二进制时恒为 false) */
  utf8: boolean;
  /** 带 UTF-16 BOM(FF FE / FE FF)的文本 —— 其中大量 NUL 是正常的,不能当二进制 */
  utf16: 'le' | 'be' | null;
  lineEnding: 'lf' | 'crlf';
};

export function sniffText(buffer: Buffer): TextSniff {
  // PowerShell 重定向、Excel「Unicode 文本」都是 UTF-16LE 带 BOM:每个 ASCII 字符后面跟一个 NUL,
  // 按 NUL 判会被当成二进制。先认 BOM(复核指出)。
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { binary: false, utf8: false, utf16: 'le', lineEnding: 'lf' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { binary: false, utf8: false, utf16: 'be', lineEnding: 'lf' };
  }
  const head = buffer.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) {
    return { binary: true, utf8: false, utf16: null, lineEnding: 'lf' };
  }
  let utf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    utf8 = false;
  }
  return { binary: false, utf8, utf16: null, lineEnding: detectLineEnding(buffer) };
}

function detectLineEnding(buffer: Buffer): 'lf' | 'crlf' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      if (i > 0 && buffer[i - 1] === 0x0d) crlf += 1;
      else lf += 1;
    }
  }
  // 严格多数才算 CRLF:两种一样多(混合换行)时按 LF 存,与改前一致。
  return crlf > lf ? 'crlf' : 'lf';
}

/**
 * 非 UTF-8 文本解码给人看(只读)。
 *
 * 不能「UTF-8 一失败就整份按 GBK」:截出来的样本、正在写的训练日志(8KB 一刷,末尾常停在半个汉字上)
 * 只坏一两个字节,整份按 GBK 解就成了一屏「涓枃鏃ュ織」(复核实测)。所以:
 * - UTF-16 带 BOM → 按 UTF-16 解;
 * - 按 UTF-8 容错解,解得通的多字节字符不少于替换字符 → 就是坏了几个字节的 UTF-8,照 UTF-8 显示;
 * - 否则 GBK 严格解得通 → GBK(国内 Excel 导出的 csv);
 * - 都不行 → 带替换字符的 UTF-8。
 */
export function decodeForDisplay(buffer: Buffer, sniff: TextSniff = sniffText(buffer)): { content: string; encoding: string } {
  if (sniff.utf16) {
    return { content: new TextDecoder(sniff.utf16 === 'le' ? 'utf-16le' : 'utf-16be').decode(buffer), encoding: `utf-16${sniff.utf16}` };
  }
  const lenient = buffer.toString('utf8');
  // 数一数:解得通的多字节字符(中文等)与替换字符各有多少。GBK 文本几乎拼不出合法的 UTF-8 多字节序列,
  // 所以「合法多字节字符不少于替换字符」就是坏了几处的 UTF-8;反过来才去试 GBK。
  let replacements = 0;
  let validMultibyte = 0;
  for (const ch of lenient) {
    if (ch === '\uFFFD') replacements += 1;
    else if (ch.codePointAt(0)! > 0x7f) validMultibyte += 1;
  }
  if (validMultibyte >= replacements) {
    return { content: lenient, encoding: 'utf-8-damaged' };
  }
  try {
    return { content: new TextDecoder('gbk', { fatal: true }).decode(buffer), encoding: 'gbk' };
  } catch {
    return { content: lenient, encoding: 'unknown' };
  }
}

/** 读一个已存在文件的开头用于判别(保存前用;文件不存在返回 null)。 */
export async function sniffExistingFile(filePath: string, maxBytes = 1024 * 1024): Promise<(TextSniff & { size: number }) | null> {
  let handle: fsPromises.FileHandle | null = null;
  try {
    handle = await fsPromises.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, 0);
    // 只读了开头时,末尾可能截断在一个多字节字符中间 —— 退回到最后一个完整字符的边界再判 UTF-8。
    let end = length;
    if (stat.size > maxBytes) {
      let i = length - 1;
      while (i >= 0 && (buffer[i] & 0xc0) === 0x80) i -= 1;
      if (i >= 0 && buffer[i] >= 0xc0) end = i;
    }
    const probe = buffer.subarray(0, end);
    return { ...sniffText(probe), size: stat.size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
