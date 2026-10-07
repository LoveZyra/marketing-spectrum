import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

/**
 * 用户看得见的文案里不出现内部版本代号(ha、hd、hj 这类两个小写字母的迭代名)。
 *
 * 代号对用户没有意义;要说明时间界线,写「早期版本」或正式版本号、日期。
 *
 * 判据只在不会误报的地方用:中文文案里单独出现的 f/g/h 开头两字母小写词(中文里合法的
 * 两字母词只有 px、id、ms、rm 这类,都不以 f/g/h 开头);英文文案只认「before hd」
 * 「hj release」这种明确的版本说法。源码里只看含中文的字符串字面量(defaultValue 等),跳过注释行。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(HERE, 'locales');
const SRC_DIR = path.resolve(HERE, '..');

const STANDALONE_CODENAME = /(?<![A-Za-z0-9_$.\-/{])([f-h][a-z])(?![A-Za-z0-9_\-/}(])/;
const ENGLISH_VERSION_PHRASE = /\b(?:before|after|since|predates|prior to)\s+(?:the\s+)?[f-h][a-z]\b|\b[f-h][a-z]\s+(?:release|version|build)\b/i;

const flatten = (value: unknown, prefix = ''): Array<[string, unknown]> => {
  if (value === null || typeof value !== 'object') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flatten(nested, prefix ? `${prefix}.${key}` : key),
  );
};

const localeStrings = (lang: string): Array<[string, string]> => {
  const dir = path.join(LOCALES_DIR, lang);
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => flatten(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [`${lang}/${file}:${key}`, value] as [string, string]));
};

const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'locales' ? [] : sourceFiles(full);
  return /\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
});

describe('文案里没有内部版本代号', () => {
  test('中文 locale', () => {
    const hits = ['zh-CN', 'zh-TW']
      .flatMap(localeStrings)
      .filter(([, value]) => STANDALONE_CODENAME.test(value))
      .map(([where, value]) => `${where} → ${value}`);
    expect(hits).toEqual([]);
  });

  test('英文 locale', () => {
    const hits = localeStrings('en')
      .filter(([, value]) => ENGLISH_VERSION_PHRASE.test(value))
      .map(([where, value]) => `${where} → ${value}`);
    expect(hits).toEqual([]);
  });

  test('源码里的中文字符串(defaultValue、兜底文案)', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, 'utf8');
      const lines = source.split('\n');
      for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1).)*?[一-鿿](?:\\.|(?!\1).)*?)\1/g)) {
        if (!STANDALONE_CODENAME.test(match[2])) continue;
        const lineNumber = source.slice(0, match.index).split('\n').length;
        const line = lines[lineNumber - 1].trim();
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
        hits.push(`${path.relative(SRC_DIR, file)}:${lineNumber} → ${match[2]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
