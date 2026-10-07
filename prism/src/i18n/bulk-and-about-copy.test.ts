import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

/**
 * 批量删除项目弹窗、关于页、标题改名按钮的文案要跟着界面语言走。
 *
 * 批量删除弹窗里解释「什么会被删、不可恢复」的那段是整个确认框最关键的一句,
 * 英文界面下它若还是中文,用户就是在读不懂警告的情况下做不可逆操作。
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const locale = (lang: string, ns: string) => JSON.parse(read(`./locales/${lang}/${ns}.json`));

const translator = async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: false,
    ns: ['common', 'sidebar', 'settings'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    resources: Object.fromEntries(['en', 'zh-CN', 'zh-TW'].map((lang) => [lang, {
      common: locale(lang, 'common'),
      sidebar: locale(lang, 'sidebar'),
      settings: locale(lang, 'settings'),
    }])),
  });
  return instance;
};

/** 去掉注释后,除了 defaultValue / defaults 兜底所在的行,不许再有汉字。 */
const hardcodedHanLines = (source: string): string[] =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line, index) => ({ line: line.replace(/\/\/.*$/, ''), number: index + 1 }))
    .filter(({ line }) => /\p{Script=Han}/u.test(line) && !/defaultValue|defaults=/.test(line))
    .map(({ line, number }) => `${number}: ${line.trim()}`);

describe('批量项目弹窗与关于页不写死中文', () => {
  it('判据能抓到写死的中文', () => {
    expect(hardcodedHanLines("<option value=\"\">选择一位用户…</option>")).toHaveLength(1);
    expect(hardcodedHanLines("{t('a.b', { defaultValue: '兜底' })}\n{/* 注释 */}\n// 注释")).toEqual([]);
  });

  it('ProjectBulkModals.tsx', () => {
    expect(hardcodedHanLines(read('../components/sidebar/view/subcomponents/ProjectBulkModals.tsx'))).toEqual([]);
  });

  it('AboutTab.tsx', () => {
    expect(hardcodedHanLines(read('../components/settings/view/tabs/AboutTab.tsx'))).toEqual([]);
  });
});

describe('文案键', () => {
  it('批量删除说明:en 下带上项目数与会话数,强调部分留给组件', async () => {
    const t = (await translator()).getFixedT('en', 'sidebar');
    const text = t('project.bulk.deleteExplain', { projectCount: 3, sessionCount: 42 });
    expect(text).toContain('(projects: 3; sessions in total: 42)');
    // 只选一个项目、只有一条会话时也不能读成 "1 projects" / "1 sessions"
    const single = t('project.bulk.deleteExplain', { projectCount: 1, sessionCount: 1 });
    expect(single).not.toMatch(/\b1 projects\b|\b1 sessions\b/);
    expect(text).toContain('<strong>This cannot be undone.</strong>');
    expect(text).toMatch(/^<danger>Delete all data<\/danger>/);
    expect(t('project.bulk.archiveExplain')).toMatch(/^<strong>Archive<\/strong>/);
  });

  it('项目行的会话数:en 区分单复数(单数形态是 project.bulk.sessionCount_one),zh-CN 一种', async () => {
    const instance = await translator();
    expect(instance.exists('project.bulk.sessionCount_one', { lng: 'en', ns: 'sidebar' })).toBe(true);
    const en = instance.getFixedT('en', 'sidebar');
    expect(en('project.bulk.sessionCount', { count: 1 })).toBe('1 session');
    expect(en('project.bulk.sessionCount', { count: 5 })).toBe('5 sessions');
    expect(instance.getFixedT('zh-CN', 'sidebar')('project.bulk.sessionCount', { count: 5 })).toBe('5 会话');
  });

  it('标题改名的保存 / 取消按钮用默认命名空间,common 里要有 actions.save / actions.cancel', async () => {
    const title = read('../components/main-content/view/subcomponents/MainContentTitle.tsx');
    expect(title).toMatch(/const \{ t \} = useTranslation\(\);/);
    expect(title).toMatch(/t\('actions\.save'/);
    expect(title).toMatch(/t\('actions\.cancel'/);
    const instance = await translator();
    for (const lang of ['en', 'zh-CN']) {
      expect(instance.exists('actions.save', { lng: lang, ns: 'common' }), lang).toBe(true);
      expect(instance.exists('actions.cancel', { lng: lang, ns: 'common' }), lang).toBe(true);
    }
    expect(instance.getFixedT('en', 'common')('actions.save')).toBe('Save');
  });

  it('关于页的键 en / zh-CN / zh-TW 都有', async () => {
    const instance = await translator();
    const keys = [
      'about.tagline', 'about.visionTitle', 'about.vision',
      ...['entry', 'trusted', 'reuse'].flatMap((pillar) => [`about.pillars.${pillar}.title`, `about.pillars.${pillar}.body`]),
    ];
    for (const lang of ['en', 'zh-CN', 'zh-TW']) {
      for (const key of keys) expect(instance.exists(key, { lng: lang, ns: 'settings' }), `${lang} ${key}`).toBe(true);
    }
  });
});
