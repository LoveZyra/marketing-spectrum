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
/**
 * hl(动态 P3 首屏):**首屏只加载当前语言**。
 *
 * i18next 在 init 时会把 `fallbackLng` 的全部 namespace 一起拉下来 —— 默认语言是 zh-CN,
 * 于是每个访客首屏都要多下一整套英文(108KB 源文件)。zh-CN 对 en 是完整的(有测试钉住
 * 「每个 namespace 在每个语种下都能解析」),首屏根本用不到那套英文。
 *
 * 做法:init 时先不挂 fallback,只装当前语言;init 完成后**后台**把 en 拉下来,拉到了再把
 * `fallbackLng` 挂上(LanguageUtils / Translator 持有的是同一个 options 对象,改这一处即生效),
 * 并发一次 `loaded` 让已挂载的组件按新 fallback 重渲。当前语言就是 en 时什么都不用做。
 *
 * 代价:某个不完整的小语种在 en 到达前那几十毫秒里会把缺的键渲染成键路径。zh-CN 没有缺键,
 * 而选了小语种的用户本来就要等它自己的文件 —— 两个请求几乎同时回来。
 * `fallbackReady` 给测试与需要确定性的调用方等这一步。
 */
let fallbackReady = Promise.resolve();

const attachFallbackLanguage = () => {
  if (i18n.options.fallbackLng) return Promise.resolve();
  const attach = () => {
    i18n.options.fallbackLng = FALLBACK_LANGUAGE;
    i18n.emit('loaded');
  };
  if (i18n.language === FALLBACK_LANGUAGE) {
    attach();
    return Promise.resolve();
  }
  return i18n
    .loadLanguages(FALLBACK_LANGUAGE)
    .catch((error) => {
      console.error('[i18n] Failed to load fallback language:', error);
    })
    .then(attach);
};

/** 等 fallback 语言(en)挂好 —— 只有测试和"必须确定回退可用"的地方需要等。 */
export const whenFallbackReady = () => fallbackReady;

export const initI18n = () =>
  i18n
    .use(lazyResourceBackend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      lng: resolveInitialLanguage(readStorage()),
      // 见 attachFallbackLanguage:先不挂,init 之后后台补上。
      fallbackLng: false,

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
    })
    .then((t) => {
      fallbackReady = attachFallbackLanguage();
      return t;
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
