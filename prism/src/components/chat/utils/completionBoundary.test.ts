import { describe, expect, it } from 'vitest';

import { completionTokenEnd, replaceCompletionToken } from './completionBoundary';

/**
 * fj:这一组钉的是「补全不许吃掉用户正文」。
 *
 * 修之前的判据是 `indexOf(' ')`,下面每一条**都会红**:
 *   - 换行/中文之后没有半角空格 ⇒ 余下正文被整段丢弃;
 *   - 斜杠命令那侧还多丢一截:空格**之前**的内容(含换行和那一行的正文)。
 */

const FILE = 'src/Readme.md';

describe('fj:@ 文件提及只替换「@ 到光标」这一段', () => {
  it('中文单行:后半句必须留着 —— 中文里没有半角空格,这是最常见的形状', () => {
    // 「参考@Rea这个文件改一下」,光标停在 @Rea 之后
    expect(replaceCompletionToken('参考@Rea这个文件改一下', 2, FILE, 6).text)
      .toBe('参考src/Readme.md 这个文件改一下');
  });

  it('多行:第一行的提及不许把后面几行吃掉', () => {
    expect(replaceCompletionToken('@Rea\n第二行\n第三行', 0, FILE, 4).text)
      .toBe('src/Readme.md\n第二行\n第三行');
  });

  it('换行紧跟其后时不补空格 —— 余下正文自己带着分隔符', () => {
    expect(replaceCompletionToken('看 @Rea\n然后改这里', 2, FILE, 6).text)
      .toBe('看 src/Readme.md\n然后改这里');
  });

  it('行尾:补完留一个空格接着打', () => {
    expect(replaceCompletionToken('看 @Rea', 2, FILE, 6).text).toBe('看 src/Readme.md ');
  });

  it('光标越过了空白(回头点旧提及)时按空白截,不吃后面的词', () => {
    expect(replaceCompletionToken('看 @Rea 后面', 2, FILE, 9).text).toBe('看 src/Readme.md 后面');
  });

  it('没给光标时退回"第一个空白"这条客观边界', () => {
    expect(replaceCompletionToken('看 @Rea 后面', 2, FILE).text).toBe('看 src/Readme.md 后面');
  });
});

describe('fj:token 边界本身', () => {
  it('半角空格、换行、全角空格都算边界', () => {
    expect(completionTokenEnd('a@b c', 1)).toBe(3);
    expect(completionTokenEnd('a@b\nc', 1)).toBe(3);
    expect(completionTokenEnd('a@b　c', 1)).toBe(3);
  });

  it('整段没有空白时边界是结尾(由光标收窄)', () => {
    expect(completionTokenEnd('a@bcd', 1)).toBe(5);
    expect(completionTokenEnd('a@bcd', 1, 3)).toBe(3);
  });
});
