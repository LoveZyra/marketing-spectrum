/**
 * 非聊天页签的顶栏标题。
 *
 * 2026-09-15 实测:中文界面下点开「定时任务」,顶栏写着英文 **Project** ——
 * `getTabTitle` 除了 files / notebook 之外一律回落到一个写死的 `'Project'`。
 * 终端页签同样。侧栏那排页签早就有 `tabs.*` 这组键,只是这里没用。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import type { AppTab } from '../../../../types/app';

import { getTabTitle } from './tabTitle';

const here = path.dirname(fileURLToPath(import.meta.url));
const localeDir = path.join(here, '../../../../i18n/locales');
const readLocale = (lang: string) =>
  JSON.parse(readFileSync(path.join(localeDir, lang, 'common.json'), 'utf8')) as Record<string, Record<string, string>>;

/** 按 locale 文件真取值的翻译器(取不到就用兜底),这样断言的是**用户真会看到的字**。 */
const translatorFor = (lang: string) => {
  const dict = readLocale(lang);
  return (key: string, fallback: string) => {
    const value = key.split('.').reduce<unknown>((node, part) => (
      node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
    ), dict);
    return typeof value === 'string' ? value : fallback;
  };
};

const TABS: AppTab[] = ['chat', 'tasks', 'files', 'shell', 'notebook'];

describe('getTabTitle', () => {
  it('中文界面下没有一个页签回落成英文 Project', () => {
    const t = translatorFor('zh-CN');
    for (const tab of TABS) {
      expect(getTabTitle(tab, t), tab).not.toBe('Project');
    }
  });

  it('定时任务 / 终端 用的就是侧栏那排页签的字', () => {
    const zh = translatorFor('zh-CN');
    expect(getTabTitle('tasks', zh)).toBe('定时任务');
    expect(getTabTitle('shell', zh)).toBe('终端');
    expect(getTabTitle('files', zh)).toBe('项目文件');

    const en = translatorFor('en');
    expect(getTabTitle('tasks', en)).toBe('Tasks');
    expect(getTabTitle('shell', en)).toBe('Shell');
  });

  it('每个页签在两个 locale 里都真有键,不靠兜底', () => {
    for (const lang of ['zh-CN', 'en']) {
      const dict = readLocale(lang);
      for (const tab of TABS) {
        expect(dict.tabs?.[tab], `${lang} 缺 tabs.${tab}`).toBeTypeOf('string');
      }
      expect(dict.mainContent?.projectFiles, `${lang} 缺 mainContent.projectFiles`).toBeTypeOf('string');
    }
  });

  it('Notebook 保持 JupyterLab 这个产品名(不翻译)', () => {
    expect(getTabTitle('notebook', translatorFor('zh-CN'))).toBe('JupyterLab');
  });
});
