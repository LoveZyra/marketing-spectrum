/**
 * Discovery of translation resources.
 *
 * `import.meta.glob` enumerates the locale files themselves, so there is no
 * hand-written list to drift from the directory tree and "present on disk but
 * unreachable at runtime" is unrepresentable. That failure would be silent: an
 * unregistered locale falls back to English, which looks like a missing
 * translation rather than a wiring bug.
 *
 * Files load lazily, one chunk per locale/namespace, so a visitor downloads
 * only the languages actually used.
 */

/** Resolves to the parsed JSON module for one locale/namespace pair. */
export type ResourceLoader = () => Promise<unknown>;

export type ResourceIndex = ReadonlyMap<string, ResourceLoader>;

const LOCALE_MODULE_PATH = /^\.{0,2}\/?(?:.*\/)?locales\/([^/]+)\/([^/]+)\.json$/;

/**
 * Pulls the language and namespace out of a glob key.
 *
 * Language codes here are directory names, so they keep their exact casing:
 * `zh-CN` and `zh-TW` must match the picker values in `languages.js` and
 * i18next's language codes character for character.
 */
export function parseLocaleModulePath(
  path: string,
): { language: string; namespace: string } | null {
  const match = LOCALE_MODULE_PATH.exec(path);
  if (!match) {
    return null;
  }

  const [, language, namespace] = match;
  if (!language || !namespace) {
    return null;
  }

  return { language, namespace };
}

export function resourceKey(language: string, namespace: string): string {
  return `${language}/${namespace}`;
}

export function buildResourceIndex(modules: Record<string, ResourceLoader>): ResourceIndex {
  const index = new Map<string, ResourceLoader>();

  for (const [path, loader] of Object.entries(modules)) {
    const parsed = parseLocaleModulePath(path);
    if (!parsed) {
      continue;
    }
    index.set(resourceKey(parsed.language, parsed.namespace), loader);
  }

  return index;
}

/** Every language that has at least one namespace file on disk. */
export function languagesIn(index: ResourceIndex): string[] {
  const languages = new Set<string>();
  for (const key of index.keys()) {
    languages.add(key.slice(0, key.indexOf('/')));
  }
  return [...languages].sort();
}

/** Every namespace a given language has a file for. */
export function namespacesIn(index: ResourceIndex, language: string): string[] {
  const prefix = `${language}/`;
  const namespaces: string[] = [];
  for (const key of index.keys()) {
    if (key.startsWith(prefix)) {
      namespaces.push(key.slice(prefix.length));
    }
  }
  return namespaces.sort();
}

/**
 * One chunk per locale/namespace file, resolved at build time by Vite.
 *
 * Deliberately not `{ eager: true }`: that would put every language into every
 * visitor's first download.
 */
const localeModules = import.meta.glob('./locales/*/*.json') as Record<string, ResourceLoader>;

export const resourceIndex: ResourceIndex = buildResourceIndex(localeModules);

/**
 * Loads one namespace, or returns null when the file does not exist.
 *
 * Null rather than a throw: every namespace added to `en` is absent from the
 * other locales until someone translates it, and that gap is ordinary
 * rather than exceptional. i18next's `fallbackLng` already handles it by
 * serving English for those keys. Failing the load instead would take down the
 * whole language over one absent file.
 */
export async function loadResource(language: string, namespace: string): Promise<unknown | null> {
  const loader = resourceIndex.get(resourceKey(language, namespace));
  if (!loader) {
    return null;
  }

  const module = (await loader()) as { default?: unknown };
  return module?.default ?? module;
}
