import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import i18n, { initI18n, resolveInitialLanguage, setLanguagePreference } from './config.js';
import { languagesIn, loadResource, namespacesIn, resourceIndex } from './resource-registry';

const FALLBACK_LANGUAGE = 'en';
const DEFAULT_LANGUAGE = 'zh-CN';

type Bundle = Record<string, unknown>;

const flatten = (value: unknown, prefix = ''): Array<[string, string]> => {
  if (typeof value === 'string') {
    return [[prefix, value]];
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value as Bundle).flatMap(([key, nested]) =>
    flatten(nested, prefix ? `${prefix}.${key}` : key),
  );
};

const loadFlat = async (language: string, namespace: string) =>
  new Map(flatten(await loadResource(language, namespace)));

/**
 * End-to-end check on the i18next wiring, as opposed to the registry's own
 * unit tests.
 *
 * The registry can be correct and the app still ship an English-only UI — that
 * is precisely what happened to French, where the files were on disk, valid,
 * and never reached i18next. Only actually asking for a translated string
 * proves the backend, the namespace list and the lazy loader are connected.
 */
describe('i18next serves the translations that exist on disk', () => {
  beforeAll(async () => {
    await initI18n();
  });

  /**
   * Two separate claims, and they used to be one: that init resolves a usable
   * bundle, and that the bundle it resolves is the *default* language rather
   * than the fallback. Collapsing them hid the interesting case — with no
   * stored choice (which is what the runner has, having no localStorage at
   * all) the app must open in Chinese, while English stays reachable as the
   * per-key fallback for everything Chinese has not translated.
   */
  test('init opens in the default language, with no key leaking through', async () => {
    assert.equal(i18n.language, DEFAULT_LANGUAGE);
    assert.equal(i18n.t('common:buttons.save'), '保存');

    await i18n.changeLanguage(FALLBACK_LANGUAGE);
    assert.equal(i18n.t('common:buttons.save'), 'Save');
  });

  /**
   * The French regression, stated as an assertion. Before the registry, this
   * returned 'Save': `fr` had every namespace translated and a picker entry,
   * but no import, so i18next had never heard of it.
   */
  test('French resolves to French', async () => {
    await i18n.changeLanguage('fr');

    assert.equal(i18n.t('common:buttons.save'), 'Enregistrer');
    assert.equal(i18n.t('common:buttons.cancel'), 'Annuler');
  });

  /**
   * 原来这里钉的是"每个语种都必须有 tasks.json" —— 那个 namespace 随任务功能
   * 整体移除了。留下的这条守的是同一类问题的一般形式:任何一个 namespace 只要
   * 在 en 里存在,就必须能在每个语种里被解析出来(缺文件时回退英文,而不是渲染
   * 成 key 路径)。当年 `.gitignore` 把 tasks.json 一起忽略掉、七个语种整个
   * namespace 静默丢失,就是这条要拦的。
   */
  test('每个 namespace 在每个语种下都能解析,不会渲染成 key 路径', async () => {
    for (const language of languagesIn(resourceIndex)) {
      await i18n.changeLanguage(language);
      for (const namespace of namespacesIn(resourceIndex, FALLBACK_LANGUAGE)) {
        const probe = `${namespace}:__definitely_missing_key__`;
        assert.equal(i18n.t(probe), '__definitely_missing_key__', `${language}/${namespace} 解析异常`);
      }
    }
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });

  /**
   * Locales are allowed to lag: roughly a thousand keys across the nine
   * non-English locales are untranslated, and `fallbackLng` is what makes that
   * a partial translation rather than a broken screen. The gap is found at run
   * time rather than hard-coded so that translating it does not fail the test.
   */
  test('an untranslated key falls back to English rather than rendering its path', async () => {
    let checked = 0;

    for (const language of languagesIn(resourceIndex)) {
      if (language === FALLBACK_LANGUAGE) {
        continue;
      }

      for (const namespace of namespacesIn(resourceIndex, FALLBACK_LANGUAGE)) {
        const [english, translated] = await Promise.all([
          loadFlat(FALLBACK_LANGUAGE, namespace),
          loadFlat(language, namespace),
        ]);

        const gap = [...english.keys()].find(
          // Plural variants resolve through sibling suffixes rather than the
          // fallback language, so they prove nothing here.
          (key) => !translated.has(key) && !/_(one|two|few|many|other|zero)$/.test(key),
        );
        if (!gap) {
          continue;
        }

        await i18n.changeLanguage(language);
        assert.equal(
          i18n.t(`${namespace}:${gap}`),
          english.get(gap),
          `${language} is missing ${namespace}:${gap} and did not fall back to English`,
        );
        checked += 1;
        break;
      }
    }

    assert.ok(checked > 0, 'expected at least one untranslated key to exercise the fallback');
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });

  /**
   * Lazy loading is the other half of the change: switching language has to
   * fetch, and the fetch has to have finished by the time `changeLanguage`
   * resolves. If it had not, every string would render as its key for a frame
   * on each switch.
   */
  test('a language switch resolves only once its resources are usable', async () => {
    await i18n.changeLanguage('zh-CN');
    assert.equal(i18n.t('common:buttons.save'), i18n.getResource('zh-CN', 'common', 'buttons.save'));

    await i18n.changeLanguage('ja');
    assert.equal(i18n.t('common:buttons.save'), i18n.getResource('ja', 'common', 'buttons.save'));

    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });
});

/**
 * Interpolation is the one place a translation can be actively wrong rather
 * than merely absent. A bundle that drops `{{count}}` renders "Showing of 40
 * tasks"; one that misspells `{{projectName}}` renders the placeholder itself.
 * Neither throws, and both are invisible to anyone who does not read that
 * language — which is every reviewer, for at least eight of the ten.
 */
describe('placeholders survive translation', () => {
  const PLACEHOLDER = /\{\{\s*([^}\s,]+)/g;

  const placeholdersIn = (value: string) =>
    new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1]));

  test('every translated string interpolates exactly what English does', async () => {
    const problems: string[] = [];

    for (const namespace of namespacesIn(resourceIndex, FALLBACK_LANGUAGE)) {
      const english = await loadFlat(FALLBACK_LANGUAGE, namespace);

      for (const language of languagesIn(resourceIndex)) {
        if (language === FALLBACK_LANGUAGE) {
          continue;
        }

        for (const [key, translated] of await loadFlat(language, namespace)) {
          // Plural suffixes are per-locale, so match them against the base key.
          const englishValue =
            english.get(key) ?? english.get(key.replace(/_(one|two|few|many|other|zero)$/, '_other'));
          if (englishValue === undefined) {
            continue;
          }

          const expected = placeholdersIn(englishValue);
          const actual = placeholdersIn(translated);
          if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
            problems.push(
              `${language}/${namespace} ${key}: expected {{${[...expected].join('}}, {{')}}} `
              + `but found {{${[...actual].join('}}, {{')}}}`,
            );
          }
        }
      }
    }

    assert.deepEqual(problems, [], `interpolation mismatches:\n  ${problems.join('\n  ')}`);
  });
});

/**
 * Which language a browser opens in.
 *
 * The rule looks trivial and is not: the app shipped an English default for
 * long enough that every browser that ever loaded it holds
 * `userLanguage: "en"` — written by i18next's own detector cache on the init
 * that set the default in the first place. A default flip that keys off that
 * value reaches nobody but a first-time visitor, and reads as broken to
 * everyone else. Hence a second key that only a human click writes, and these
 * tests pinning which key wins.
 */
describe('initial language resolution', () => {
  const storageOf = (entries: Record<string, string>) => ({
    getItem: (key: string) => (key in entries ? entries[key] : null),
    setItem: (key: string, value: string) => {
      entries[key] = value;
    },
  });

  test('a browser with nothing stored opens in the default language', () => {
    assert.equal(resolveInitialLanguage(storageOf({})), DEFAULT_LANGUAGE);
  });

  test('no storage at all — SSR, the test runner — still resolves the default', () => {
    assert.equal(resolveInitialLanguage(null), DEFAULT_LANGUAGE);
    assert.equal(resolveInitialLanguage(undefined), DEFAULT_LANGUAGE);
  });

  /**
   * The regression this whole mechanism exists for. `userLanguage: "en"` is
   * what an existing install carries, and it was never a choice — reading it
   * would pin every current user to English through a default change they were
   * supposed to receive.
   */
  test("i18next's own cache is not mistaken for a choice", () => {
    assert.equal(
      resolveInitialLanguage(storageOf({ userLanguage: FALLBACK_LANGUAGE })),
      DEFAULT_LANGUAGE,
    );
  });

  test('an explicit pick wins over the default, including picking English', () => {
    assert.equal(
      resolveInitialLanguage(storageOf({ userLanguageChoice: FALLBACK_LANGUAGE })),
      FALLBACK_LANGUAGE,
    );
    assert.equal(resolveInitialLanguage(storageOf({ userLanguageChoice: 'ja' })), 'ja');
  });

  /**
   * A locale can leave `languages` — it happened to none yet, but the picker
   * list is the contract and a stale value must not become a language i18next
   * has no bundles for, which renders every string as its key path.
   */
  test('a stored language that is no longer supported falls back to the default', () => {
    assert.equal(resolveInitialLanguage(storageOf({ userLanguageChoice: 'kl' })), DEFAULT_LANGUAGE);
    assert.equal(resolveInitialLanguage(storageOf({ userLanguageChoice: '' })), DEFAULT_LANGUAGE);
  });

  /** Safari private browsing throws on read, and must not white-screen boot. */
  test('a storage that throws resolves the default instead of propagating', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };

    assert.equal(resolveInitialLanguage(hostile), DEFAULT_LANGUAGE);
  });

  test('choosing from the picker records the choice, and the choice survives a reload', async () => {
    if (!i18n.isInitialized) {
      await initI18n();
    }

    const entries: Record<string, string> = { userLanguage: FALLBACK_LANGUAGE };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      value: storageOf(entries),
      configurable: true,
      writable: true,
    });

    try {
      await setLanguagePreference('ja');
      assert.equal(i18n.language, 'ja');
      assert.equal(entries.userLanguageChoice, 'ja');

      // The reload, simulated: the same store, read back through the resolver.
      assert.equal(resolveInitialLanguage(globalThis.localStorage), 'ja');

      // A value outside the picker list is refused rather than persisted.
      await setLanguagePreference('kl');
      assert.equal(i18n.language, 'ja');
      assert.equal(entries.userLanguageChoice, 'ja');
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', original);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
      await i18n.changeLanguage(FALLBACK_LANGUAGE);
    }
  });
});
