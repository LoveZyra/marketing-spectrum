/**
 * 补全时「要替换掉哪一段」的判据,`@` 文件提及与 `/` 斜杠命令共用。
 *
 * token 的边界是任意空白或光标,不能只找半角空格:换行不是半角空格,中文正文里也几乎没有半角空格,
 * 只找半角空格会在中文多行提示词里把后面的正文整段吞掉。抽成纯函数以便单测钉住这类输入形状。
 */

/** 从 `start` 起,token 到哪里结束(相对整段输入的下标)。 */
export function completionTokenEnd(
  input: string,
  start: number,
  caret?: number,
): number {
  const rest = input.slice(start);
  const whitespace = rest.match(/\s/);
  // 客观边界:第一个空白字符;没有空白就是到结尾。
  const whitespaceEnd = start + (whitespace?.index ?? rest.length);
  // 主观边界:光标 —— 用户认为自己正在打的那个 token 到此为止。
  // 光标在 start 之前(异常/未提供)时不参与,只用客观边界。
  const caretEnd = typeof caret === 'number' && caret > start ? caret : whitespaceEnd;
  return Math.min(caretEnd, whitespaceEnd);
}

/**
 * 用 `replacement` 换掉 `[start, tokenEnd)`,余下正文原样保留。
 *
 * 余下正文自己带前导空白时不再补分隔符(补了就是双空格);完全没有余下正文时
 * 补一个空格,方便接着打字。
 */
export function replaceCompletionToken(
  input: string,
  start: number,
  replacement: string,
  caret?: number,
): { text: string; caret: number } {
  const before = input.slice(0, start);
  const after = input.slice(completionTokenEnd(input, start, caret));
  const joiner = after && /^\s/.test(after) ? '' : ' ';
  return {
    text: `${before}${replacement}${joiner}${after}`,
    caret: before.length + replacement.length + 1,
  };
}
