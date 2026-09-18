#!/usr/bin/env node
/**
 * 构建前自检:`t('…')` 用到的键,两个 locale 里必须都有。
 *
 * ## 起因
 *
 * 2026-09-15 在测试环境上逐页看界面,发现**删除确认框里「归档」和「永久删除」
 * 两个按钮都是英文**,而框里其余文字是中文 —— 用户要在"藏起来"和"不可逆的
 * 永久删除"之间做选择,偏偏这两个按钮没翻译。全仓扫下来这样的键有 **69 个**,
 * 其中 9 个**连兜底都没有**,界面上直接画出 `search.matches` 这样的键名。
 *
 * 根因不是谁偷懒:`t('x', '兜底')` 在键缺失时**静默**回落到兜底串,
 * 开发时看不出任何异常,只有换了语言才现形。补一次不解决问题 —— 下一个人
 * 加一句文案照样会漏。所以在构建前挡一道,把"静默回落"变成一句红字。
 *
 * ## 判据
 *
 * - 只认**字面量**键(`t('a.b')`);模板串 `t(\`tabs.${x}\`)` 一律跳过 ——
 *   它的取值范围要靠人看,不是扫描能定的;
 * - **不猜命名空间**:一个键只要在该语言的任意一个命名空间里存在就算有。
 *   原因是 `t` 经常是**从父组件传下来的 prop**(`SidebarSessionItem` 就是),
 *   文件里根本没有 `useTranslation` 可读 —— 按文件猜命名空间会造出上百条误报,
 *   而一个天天误报的守卫等于没有守卫。这道闸门管的是"这个键在 locale 里
 *   压根不存在"(那 69 个全属于此类,界面上直接画键名或退回英文);
 *   唯一的例外是下面那张 `PROP_T_NAMESPACES` —— **收 `t` 当 prop 的组件**
 *   逐个登记它拿到的是谁的 `t`,这些文件改成**严格查那几个命名空间**。
 *   这类文件全仓只有十来个,一次点清就不会再退化(有自检兜着,见文件尾)。
 * - 两个 locale(zh-CN / en)都要有,缺一边就算缺 —— 只补中文是这次的病根之一。
 *
 * 加不了键又必须放行的,写进 `ALLOWED_MISSING` 并注明理由。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const LOCALES = path.join(SRC, 'i18n', 'locales');
const LANGS = ['zh-CN', 'en'];
const DEFAULT_NS = 'common';

/**
 * **`t` 是从父组件传下来的那些文件**,各自登记它拿到的是谁的 `t`。
 *
 * 起因:2026-09-15 补那 69 个键时,`deleteConfirmation.*` 只加进了 `common`,
 * 而删除确认框的 `t` 来自 AppContent 的 `useTranslation('sidebar')` ——
 * 上面那道闸门"任意命名空间里有就算有",于是全绿放行,界面上
 * 「Archive session」「Delete permanently」照样是英文。
 *
 * 值按 i18next 的解析顺序写:`useTranslation(['sidebar','common'])` 传下来的
 * 就是 `['sidebar','common']`;`useTranslation('sidebar')` 传下来的只有
 * `['sidebar']`。**一个组件被多处渲染时取交集** —— SessionDeleteDialog 两条
 * 入口(AppContent 的 `tSidebar`、SidebarModals 的 sidebar+common)交出来就是
 * `['sidebar']`,这也正是那次漏网的地方。
 */
const PROP_T_NAMESPACES = new Map([
  // AppContent: t={tSidebar}(只有 sidebar) / SidebarModals: Sidebar 的 sidebar+common
  ['src/shared/view/SessionDeleteDialog.tsx', ['sidebar']],
  // 以下整棵侧栏子树的 t 都来自 Sidebar.tsx 的 useTranslation(['sidebar','common'])
  ['src/components/sidebar/hooks/useSidebarController.ts', ['sidebar', 'common']],
  ['src/components/sidebar/utils/utils.ts', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/RecentlyDeletedSection.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarContent.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarFooter.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarHeader.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarModals.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarProjectList.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarProjectsState.tsx', ['sidebar', 'common']],
  ['src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx', ['sidebar', 'common']],
  // FileTree.tsx 的 useTranslation() —— 默认命名空间
  ['src/components/file-tree/utils/fileTreeUtils.ts', ['common']],
]);

/** 明知缺失、但有理由放行的键。写清楚为什么,别当垃圾桶用。 */
const ALLOWED_MISSING = new Set([]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const loadLocale = (lang) => {
  const dir = path.join(LOCALES, lang);
  const namespaces = {};
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.json')) namespaces[entry.replace(/\.json$/, '')] = readJson(path.join(dir, entry));
  }
  return namespaces;
};

const lookup = (dict, key) => {
  let node = dict;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
};

/** 这个键在**指定的那几个**命名空间里存在吗(`PROP_T_NAMESPACES` 用)。 */
const hasKeyIn = (namespaces, nsList, key) =>
  nsList.some((ns) => namespaces[ns] && typeof lookup(namespaces[ns], key) === 'string');

/** 这个键在这门语言的**任意**命名空间里存在吗(理由见文件头)。 */
const hasKeyAnywhere = (namespaces, preferredNs, key) => {
  if (preferredNs && namespaces[preferredNs] && typeof lookup(namespaces[preferredNs], key) === 'string') return true;
  return Object.values(namespaces).some((dict) => typeof lookup(dict, key) === 'string');
};

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'locales' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

/** 这个文件里 `t()` 默认走哪个命名空间(只用于排错信息,判定不靠它)。 */
const defaultNamespaceOf = (source) => {
  const match = /useTranslation\(\s*(\[[^\]]*\]|['"][^'"]+['"])/.exec(source);
  if (!match) return DEFAULT_NS;
  const first = /['"]([^'"]+)['"]/.exec(match[1]);
  return first ? first[1] : DEFAULT_NS;
};

const locales = Object.fromEntries(LANGS.map((lang) => [lang, loadLocale(lang)]));

const missing = [];
let scannedFiles = 0;
let scannedKeys = 0;

const seenPropTFiles = new Set();

for (const file of walk(SRC)) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('t(')) continue;
  scannedFiles += 1;
  const rel = path.relative(root, file).split(path.sep).join('/');
  const strictNs = PROP_T_NAMESPACES.get(rel);
  if (strictNs) seenPropTFiles.add(rel);
  const fileNs = strictNs ? strictNs[0] : defaultNamespaceOf(source);
  // `t('a.b'` / `tSidebar('a.b'` —— 前缀是 t 或 tXxx,后面紧跟单引号或双引号的字面量
  const calls = source.matchAll(/\bt[A-Za-z]*\(\s*(['"])([^'"`$]+?)\1/g);
  for (const call of calls) {
    const raw = call[2];
    if (!raw.includes('.') && !raw.includes(':')) continue;      // 不像键的普通字符串
    if (/[\s<>{}]/.test(raw)) continue;                           // 句子,不是键
    const [maybeNs, ...rest] = raw.split(':');
    const explicit = rest.length > 0;
    const ns = explicit ? maybeNs : fileNs;
    const key = explicit ? rest.join(':') : raw;
    if (ALLOWED_MISSING.has(`${ns}:${key}`)) continue;
    scannedKeys += 1;
    for (const lang of LANGS) {
      // 登记在册的文件按它真实的那几个命名空间严格查;其余仍然是"任意命名空间里有就算有"
      const ok = !explicit && strictNs
        ? hasKeyIn(locales[lang], strictNs, key)
        : hasKeyAnywhere(locales[lang], explicit ? ns : fileNs, key);
      if (!ok) {
        missing.push({ lang, ns, key, file: rel, strictNs: !explicit && strictNs ? strictNs : null });
      }
    }
  }
}

if (missing.length > 0) {
  const byKey = new Map();
  for (const item of missing) {
    const id = `${item.ns}:${item.key}`;
    if (!byKey.has(id)) byKey.set(id, { langs: [], file: item.file, strictNs: item.strictNs });
    byKey.get(id).langs.push(item.lang);
  }
  console.error('\n[i18n] 这些键在 locale 里缺失 —— 界面会静默回落到代码兜底串(或直接画出键名):\n');
  for (const [id, info] of byKey) {
    const where = info.strictNs ? `  —— 这个文件的 t 只认 ${info.strictNs.join(' / ')}` : '';
    console.error(`  ${id}  (缺:${info.langs.join(' / ')})  ← ${info.file}${where}`);
  }
  console.error(`\n共 ${byKey.size} 个。补进 src/i18n/locales/<语言>/<命名空间>.json,`);
  console.error('确有理由放行的写进 scripts/check-i18n-keys.mjs 的 ALLOWED_MISSING 并注明原因。\n');
  process.exit(1);
}

/*
 * 表自己的自检:**登记过的文件得还在,该登记的不能漏。**
 *
 * 这张表是靠人维护的,烂掉了上面那道严格检查就悄悄失效 —— 所以两头都钉住:
 * 表里指到一个已经不存在(或不再用 t)的文件 → 报错;
 * 谁又写了一个"收 t 当 prop"的组件却没登记 → 也报错,顺手提醒他查一下 t 是谁的。
 */
const staleEntries = [...PROP_T_NAMESPACES.keys()].filter((rel) => !seenPropTFiles.has(rel));
const unregistered = [];
for (const file of walk(SRC)) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (PROP_T_NAMESPACES.has(rel)) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (!/\bt:\s*TFunction/.test(source)) continue;
  if (!/\bt[A-Za-z]*\(\s*(['"])[^'"`$]+\.[^'"`$]*\1/.test(source)) continue; // 没有字面量键就不用登记
  unregistered.push(rel);
}

if (staleEntries.length > 0 || unregistered.length > 0) {
  console.error('\n[i18n] PROP_T_NAMESPACES 这张表和代码对不上了:\n');
  for (const rel of staleEntries) console.error(`  多余:${rel}(文件没了,或者它已经不再用 t)`);
  for (const rel of unregistered) {
    console.error(`  漏了:${rel}(收 t 当 prop 且用了字面量键 —— 去看渲染它的地方传的是谁的 t)`);
  }
  console.error('\n改 scripts/check-i18n-keys.mjs 里的 PROP_T_NAMESPACES。\n');
  process.exit(1);
}

console.log(`[i18n] ok —— ${scannedFiles} 个文件里的 ${scannedKeys} 处字面量键,两个 locale 都有;${PROP_T_NAMESPACES.size} 个传 t 的文件按真实命名空间严格查过`);
