/**
 * fj:补全时「要替换掉哪一段」的判据 —— `@` 文件提及与 `/` 斜杠命令共用。
 *
 * 两处原来各写了一遍 `indexOf(' ')`,而且都错在同一个地方:**半角空格不是
 * token 的边界**。换行不是半角空格,中文正文里也几乎没有半角空格,于是
 * "找不到空格 ⇒ 后面全丢掉"这条兜底,在中文多行提示词里就是静默吃掉用户正文。
 *
 * 抽成纯函数是为了能钉测试 —— 这类"少数输入形状才炸"的 bug,靠人眼复查复查不出来。
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
