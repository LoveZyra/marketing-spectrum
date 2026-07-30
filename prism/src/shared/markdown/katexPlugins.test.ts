import { describe, expect, it } from 'vitest';

import { containsMath } from './katexPlugins';

// `containsMath` is the gate that decides whether a ~600 kB typesetting library
// gets fetched. Both directions of a wrong answer are user-visible: a false
// negative renders `$x^2$` as literal text, and a false positive means every
// message containing a shell variable pays for KaTeX.
describe('containsMath', () => {
  it('detects inline and display maths', () => {
    expect(containsMath('The identity $e^{i\\pi} + 1 = 0$ is neat.')).toBe(true);
    expect(containsMath('$$\n\\sum_{i=1}^{n} i\n$$')).toBe(true);
  });

  it('ignores content with no dollar sign at all', () => {
    expect(containsMath('')).toBe(false);
    expect(containsMath('Just some prose with `code` and a [link](https://example.com).')).toBe(false);
  });

  it('ignores shell syntax in fenced code blocks', () => {
    const source = ['Run this:', '', '```bash', 'echo "$HOME and $PATH"', '```', '', 'Then reload.'].join('\n');
    expect(containsMath(source)).toBe(false);
  });

  it('ignores shell syntax in inline code spans', () => {
    expect(containsMath('Set `$EDITOR` before running `$ npm run dev`.')).toBe(false);
  });

  it('ignores a lone dollar sign and prices spanning a line break', () => {
    expect(containsMath('That costs $5.')).toBe(false);
    expect(containsMath('It was $5\nor maybe $6.')).toBe(false);
  });

  it('still detects maths outside a code block in the same document', () => {
    const source = ['```js', 'const price = "$9.99";', '```', '', 'so $a^2 + b^2 = c^2$ holds.'].join('\n');
    expect(containsMath(source)).toBe(true);
  });

  it('does not treat a single-line price range as maths', () => {
    // "$5 to $7" has whitespace right after the opening delimiter of the second
    // pair, which is exactly what remark-math requires to be absent.
    expect(containsMath('Between $5 and $7 per seat.')).toBe(false);
  });
});
