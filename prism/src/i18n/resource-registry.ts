/**
 * Discovery of translation resources.
 *
 * The config used to name every locale/namespace pair twice: once as a
 * hand-written `import`, once as a hand-written entry in i18next's `resources`
 * object — seventy imports kept in sync with a directory tree by memory alone.
 * Nothing checked that the two lists agreed with what was on disk, and they did
 * not. `fr` was offered in the language picker and had all seven namespaces
 * translated — the most complete locale after English — with no import and no
 * `resources` entry, so choosing Français produced an entirely English UI.
 *
 * The same shape of bug lived in `.gitignore`, which ignored `tasks.json` at
 * every depth to catch TaskMaster's state file and then negated it once per
 * locale — for seven of the ten. `zh-TW/tasks.json` was translated in full and
 * had never been committed.
 *
 * That failure mode is silent by construction: an unregistered locale falls
 * back to English, which looks like a missing translation rather than a wiring
 * bug, and an unregistered file produces no warning at all.
 *
 * So the list is no longer written by hand. `import.meta.glob` enumerates the
 * files themselves, which makes "present on disk but unreachable at runtime"
 * unrepresentable. Loading them lazily is the second reason: the eager imports
 * put all ten languages in the initial bundle, so every visitor downloaded
 * nine translations they had not asked for.
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
 * Deliberately not `{ eager: true }` — eager is what the hand-written imports
 * already were, and is what put ten languages into every visitor's first
 * download.
 */
const localeModules = import.meta.glob('./locales/*/*.json') as Record<string, ResourceLoader>;

export const resourceIndex: ResourceIndex = buildResourceIndex(localeModules);

/**
 * Loads one namespace, or returns null when the file does not exist.
 *
 * Null rather than a throw: every namespace added to `en` is absent from the
 * other nine locales until someone translates it, and that gap is ordinary
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
