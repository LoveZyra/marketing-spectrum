import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import i18n, { initI18n } from './config.js';
import { languagesIn, loadResource, namespacesIn, resourceIndex } from './resource-registry';

const FALLBACK_LANGUAGE = 'en';

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

  test('the fallback language renders after init, with no key leaking through', async () => {
    assert.equal(i18n.t('common:buttons.save'), 'Save');
    assert.equal(i18n.t('tasks:notConfigured.title'), 'TaskMaster AI is not configured');
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
   * `tasks` is the namespace three locales were missing: `ko` and `zh-CN` had
   * no file at all, and `zh-TW`'s was translated but gitignored, so a fresh
   * clone rendered the whole TaskMaster UI in English for all three. Asserting
   * on the namespace list rather than on those three names keeps this honest
   * when the eighth namespace arrives.
   */
  test('every language has the TaskMaster namespace', async () => {
    for (const language of languagesIn(resourceIndex)) {
      assert.ok(
        namespacesIn(resourceIndex, language).includes('tasks'),
        `${language} has no tasks.json, so the TaskMaster UI renders in English`,
      );
    }

    await i18n.changeLanguage('ko');
    assert.equal(i18n.t('tasks:views.kanban'), '칸반 보기');

    await i18n.changeLanguage('zh-CN');
    assert.equal(i18n.t('tasks:views.kanban'), '看板视图');
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
