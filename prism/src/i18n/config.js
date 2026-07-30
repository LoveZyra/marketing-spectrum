/**
 * i18n configuration.
 *
 * Translation files are discovered and loaded by `resource-registry.ts` rather
 * than listed here as imports — see that file for why the hand-written list was
 * a bug and not just a chore. This module is only the i18next wiring.
 */

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { languages } from './languages.js';
import { loadResource, namespacesIn, resourceIndex } from './resource-registry';

const FALLBACK_LANGUAGE = 'en';

/**
 * Namespaces come from whatever `en` has on disk.
 *
 * English is the fallback language, so it is the one locale that must be
 * complete; deriving the list from it means adding `src/i18n/locales/en/foo.json`
 * is all it takes to register a namespace, with no second list to update.
 */
const namespaces = namespacesIn(resourceIndex, FALLBACK_LANGUAGE);

/**
 * Loads one namespace on demand.
 *
 * A missing file resolves to `{}` rather than an error: a locale that has not
 * translated a namespace yet should fall back to English for those keys, which
 * is exactly what an empty bundle plus `fallbackLng` produces. Reporting it as
 * a failure would make i18next retry the load on a file that is never going to
 * appear.
 */
const lazyResourceBackend = {
  type: 'backend',
  init: () => {},
  read: (language, namespace, callback) => {
    loadResource(language, namespace)
      .then((resource) => callback(null, resource ?? {}))
      .catch((error) => {
        console.error(`[i18n] Failed to load ${language}/${namespace}:`, error);
        callback(error, false);
      });
  },
};

const getSavedLanguage = () => {
  try {
    const saved = localStorage.getItem('userLanguage');
    if (saved && languages.some((language) => language.value === saved)) {
      return saved;
    }
    return FALLBACK_LANGUAGE;
  } catch {
    return FALLBACK_LANGUAGE;
  }
};

/**
 * Initializes i18next and resolves once the active language is usable.
 *
 * Callers must await this before rendering. `useSuspense` is off — this app has
 * no Suspense boundary anywhere in its tree, so a component suspending on a
 * translation load would white-screen it rather than show a fallback. Awaiting
 * the initial load here means nothing ever needs to suspend: by first render
 * the active language and the English fallback are both in memory, and later
 * language switches keep displaying the previous language until the new one has
 * finished loading.
 */
export const initI18n = () =>
  i18n
    .use(lazyResourceBackend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      lng: getSavedLanguage(),
      fallbackLng: FALLBACK_LANGUAGE,

      debug: false,

      ns: namespaces,
      defaultNS: 'common',

      keySeparator: '.',
      nsSeparator: ':',

      // Missing keys are reviewed and translated by hand, not collected.
      saveMissing: false,

      interpolation: {
        // React escapes interpolated values already.
        escapeValue: false,
      },

      react: {
        useSuspense: false,
        bindI18n: 'languageChanged loaded',
        bindI18nStore: false,
      },

      detection: {
        order: ['localStorage'],
        lookupLocalStorage: 'userLanguage',
        caches: ['localStorage'],
      },
    });

i18n.on('languageChanged', (language) => {
  // Guarded rather than only caught: this also runs under the test runner and
  // any non-browser import, where a thrown-and-logged error on every language
  // change is noise, not a signal. The catch stays for the cases that are real
  // — a full quota, or Safari private browsing.
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem('userLanguage', language);
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
});

export default i18n;
