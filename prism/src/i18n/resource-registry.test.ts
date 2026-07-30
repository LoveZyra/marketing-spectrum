import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { languages } from './languages.js';
import {
  buildResourceIndex,
  languagesIn,
  loadResource,
  namespacesIn,
  parseLocaleModulePath,
  resourceIndex,
} from './resource-registry';

const FALLBACK_LANGUAGE = 'en';

describe('glob key parsing', () => {
  test('language and namespace come from the directory layout', () => {
    assert.deepEqual(parseLocaleModulePath('./locales/en/chat.json'), {
      language: 'en',
      namespace: 'chat',
    });
  });

  /**
   * `zh-CN` and `zh-TW` differ only in the region suffix, and i18next matches
   * language codes exactly. Lower-casing or truncating either one collapses
   * Traditional and Simplified Chinese into one language.
   */
  test('regional codes keep their exact casing', () => {
    assert.deepEqual(parseLocaleModulePath('./locales/zh-CN/common.json'), {
      language: 'zh-CN',
      namespace: 'common',
    });
    assert.deepEqual(parseLocaleModulePath('./locales/zh-TW/common.json'), {
      language: 'zh-TW',
      namespace: 'common',
    });
  });

  test('anything that is not a locale file is ignored', () => {
    assert.equal(parseLocaleModulePath('./languages.js'), null);
    assert.equal(parseLocaleModulePath('./locales/en/nested/chat.json'), null);
    assert.equal(parseLocaleModulePath('./locales/en.json'), null);
  });

  test('the index keys on both language and namespace', () => {
    const loader = async () => ({ default: {} });
    const index = buildResourceIndex({
      './locales/en/chat.json': loader,
      './locales/en/common.json': loader,
      './locales/fr/chat.json': loader,
      './not-a-locale.json': loader,
    });

    assert.deepEqual(languagesIn(index), ['en', 'fr']);
    assert.deepEqual(namespacesIn(index, 'en'), ['chat', 'common']);
    assert.deepEqual(namespacesIn(index, 'fr'), ['chat']);
    assert.equal(index.size, 3, 'the non-locale path must not be indexed');
  });
});

describe('the picker and the files on disk agree', () => {
  /**
   * The regression this file exists for. `fr` shipped with all seven
   * namespaces translated and was listed in the language picker, but the
   * config's hand-written imports never mentioned it, so selecting Français
   * produced an entirely English UI and no error anywhere. An offered language
   * with no resources is indistinguishable from an untranslated one at
   * runtime, which is why it survived so long.
   */
  test('every language offered in the picker has translations', () => {
    const onDisk = new Set(languagesIn(resourceIndex));

    for (const language of languages) {
      assert.ok(
        onDisk.has(language.value),
        `the picker offers ${language.value} (${language.nativeName}) but `
        + `src/i18n/locales/${language.value}/ has no translation files`,
      );
    }
  });

  /**
   * The same divergence in the other direction: a translated locale nobody can
   * select is work already done and shipped to no one.
   */
  test('every translated language is reachable from the picker', () => {
    const offered = new Set(languages.map((language) => language.value));

    for (const language of languagesIn(resourceIndex)) {
      assert.ok(
        offered.has(language),
        `src/i18n/locales/${language}/ is translated but no picker entry `
        + 'in languages.js selects it',
      );
    }
  });

  /**
   * Every other locale is allowed gaps — `fallbackLng` covers them with
   * English. English itself has nothing to fall back to, so a namespace
   * missing there renders as raw key paths.
   */
  test('the fallback language is complete', () => {
    const fallbackNamespaces = new Set(namespacesIn(resourceIndex, FALLBACK_LANGUAGE));
    const everyNamespace = new Set(
      languagesIn(resourceIndex).flatMap((language) => namespacesIn(resourceIndex, language)),
    );

    for (const namespace of everyNamespace) {
      assert.ok(
        fallbackNamespaces.has(namespace),
        `some locale translates "${namespace}" but ${FALLBACK_LANGUAGE} has no `
        + `${namespace}.json, so those keys have no fallback`,
      );
    }
  });
});

describe('loading', () => {
  test('a namespace resolves to its parsed contents', async () => {
    const common = (await loadResource(FALLBACK_LANGUAGE, 'common')) as Record<string, unknown>;

    assert.ok(common && typeof common === 'object', 'expected a parsed object');
    assert.ok(Object.keys(common).length > 0, 'expected a non-empty bundle');
  });

  /**
   * Null, not a rejection: a namespace added to `en` is missing from the other
   * nine locales until it is translated, and the backend turns null into an
   * empty bundle so `fallbackLng` serves English for those keys. A throw here
   * would take down the entire language over one absent file.
   */
  test('an untranslated namespace resolves to null instead of failing', async () => {
    assert.equal(await loadResource(FALLBACK_LANGUAGE, 'no-such-namespace'), null);
    assert.equal(await loadResource('no-such-language', 'common'), null);
  });
});
