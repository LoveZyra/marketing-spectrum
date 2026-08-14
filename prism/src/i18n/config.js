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

/**
 * The locale every other one falls back to, key by key.
 *
 * Deliberately not the same knob as `DEFAULT_LANGUAGE`: English is the only
 * locale required to be complete, so it has to stay the fallback even when the
 * UI opens in another language. Pointing `fallbackLng` at a partial locale
 * would render raw key paths for whatever that locale has not translated yet,
 * which is strictly worse than an English string.
 */
const FALLBACK_LANGUAGE = 'en';

/**
 * The locale a browser opens in when its user has never picked one.
 */
const DEFAULT_LANGUAGE = 'zh-CN';

/**
 * Where an *explicit* pick from the language selector is recorded.
 *
 * This key, not `userLanguage`, is what `resolveInitialLanguage` reads — and
 * the distinction is the whole point. i18next writes `userLanguage` on every
 * `changeLanguage`, including the one `init` itself performs, so every browser
 * that had ever loaded the app already held `userLanguage: "en"` from the old
 * default. Keying the initial language off that would have pinned every
 * existing user to English forever and made this constant a no-op for
 * everyone but a fresh browser.
 *
 * The trade-off, stated plainly: someone who had explicitly chosen a language
 * before this key existed also has no record of it and gets moved to the
 * default once. Re-picking it writes this key and is then honoured for good.
 */
const LANGUAGE_CHOICE_STORAGE_KEY = 'userLanguageChoice';

/** i18next's detector cache. Written by us, authoritative for nothing. */
const LANGUAGE_CACHE_STORAGE_KEY = 'userLanguage';

const isSupportedLanguage = (language) =>
  Boolean(language) && languages.some((entry) => entry.value === language);

/**
 * Returns `localStorage`, or `null` where there isn't one.
 *
 * `typeof` rather than a try/catch around the access: under the test runner
 * and SSR the identifier is simply not declared, and a bare reference is a
 * ReferenceError rather than something a property-access guard would catch.
 */
const readStorage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/**
 * Picks the language i18next starts in.
 *
 * Exported and storage-injected so the precedence rule is testable without a
 * DOM: an explicit, still-supported choice wins, and everything else — no
 * choice, an unreadable store, a locale that has since been removed from
 * `languages` — falls to the default.
 */
export const resolveInitialLanguage = (storage) => {
  if (!storage) {
    return DEFAULT_LANGUAGE;
  }

  try {
    const chosen = storage.getItem(LANGUAGE_CHOICE_STORAGE_KEY);
    return isSupportedLanguage(chosen) ? chosen : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
};

/**
 * Switches language *and* records that a human asked for it.
 *
 * The language selector must go through here rather than calling
 * `i18n.changeLanguage` directly, otherwise the pick is indistinguishable from
 * the default and gets overwritten the next time the default moves.
 */
export const setLanguagePreference = (language) => {
  if (!isSupportedLanguage(language)) {
    return Promise.resolve();
  }

  const storage = readStorage();
  if (storage) {
    try {
      storage.setItem(LANGUAGE_CHOICE_STORAGE_KEY, language);
    } catch (error) {
      // A full quota or Safari private browsing: the switch below still works
      // for this tab, it just will not be remembered.
      console.error('Failed to save language preference:', error);
    }
  }

  return i18n.changeLanguage(language);
};

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
      lng: resolveInitialLanguage(readStorage()),
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

      // Inert while `lng` is supplied — i18next only runs detection when it is
      // not. Configured anyway, and configured to read the *choice* key with
      // caching off, so that the two code paths can never disagree: were `lng`
      // ever dropped in a refactor, the detector would resolve exactly what
      // `resolveInitialLanguage` resolves instead of reviving the old
      // `userLanguage` cache and snapping every existing browser to English.
      // `caches: []` because a detector write would stamp a choice the user
      // never made, and an unasked-for choice is permanent by design.
      detection: {
        order: ['localStorage'],
        lookupLocalStorage: LANGUAGE_CHOICE_STORAGE_KEY,
        caches: [],
      },
    });

i18n.on('languageChanged', (language) => {
  // Keeps `<html lang>` truthful. It is not decoration: screen readers pick
  // the pronunciation dictionary from it, and CJK line breaking and font
  // fallback differ from the Latin defaults, so a page serving Chinese while
  // declaring `lang="en"` is read and wrapped as if it were English.
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language;
  }

  // Guarded rather than only caught: this also runs under the test runner and
  // any non-browser import, where a thrown-and-logged error on every language
  // change is noise, not a signal. The catch stays for the cases that are real
  // — a full quota, or Safari private browsing.
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    // Compatibility cache only — nothing reads it back (see
    // LANGUAGE_CHOICE_STORAGE_KEY for why the initial language must not).
    // Kept so that rolling back to an older build does not lose the language.
    localStorage.setItem(LANGUAGE_CACHE_STORAGE_KEY, language);
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
});

export default i18n;
