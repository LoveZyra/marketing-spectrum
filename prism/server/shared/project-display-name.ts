import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 项目的**展示名** —— 优先用 package.json 的 name,否则取路径最后一段。
 *
 * ## 为什么住在 shared/ 而不是 projects 模块里
 *
 * 它本身只依赖 `node:fs` 和 `node:path`,是个纯叶子。但它原来待在
 * `projects/services/projects-with-sessions-fetch.service.ts` 里 —— 那个文件
 * import 了 providers 与 websocket 两个 barrel。于是三个消费者(项目列表、
 * sessions-watcher、chat-run-registry)只要通过 `@/modules/projects/index.js`
 * 取它,就把 projects → providers → websocket 三个模块连成了环。
 *
 * `madge --circular --ts-config server/tsconfig.json server` 实测 4 个环,
 * 每一个都以这条边为骨。
 *
 * **这是同一个坑的第三次。** en 轮为 `isPrismInternalTranscript` 做过一模一样的搬迁
 * (provider 反向 import watcher,导致 `ClaudeSessionSynchronizer is not a constructor`,
 * 整个 provider 层起不来,而类型检查看不出来)。当时的结论写在
 * `prism-internal-transcripts.ts` 的注释里:判据落在**谁也不依赖**的叶子模块上,
 * 两边都往下引,不互相引。
 *
 * 那次之所以没根治,是因为只搬了那一个函数;`generateDisplayName` 走的是同一条
 * barrel 边,原样留着。这次一起搬走。
 *
 * ## 为什么现在还没炸
 *
 * `generateDisplayName` 是**函数声明**,会提升 —— 环上的模块拿到它时它已经存在。
 * 但 `provider.registry.ts` 顶层有一句 `claude: new ClaudeProvider()`:只要有人把它
 * 改成箭头函数常量,或在环上任一模块加一个顶层 `new`,就是 en 那次的原样复现。
 * 不能靠"碰巧是函数声明"活着。
 */

/**
 * package.json 名字的缓存。
 *
 * 项目列表接口会对**每个项目**调一次,即 N 次磁盘 IO。按 (mtimeMs, size) 指纹
 * 失效:文件没动就不重读,动了自然换指纹。
 */
const packageNameCache = new Map<string, { fingerprint: string; name: string | null }>();

async function readPackageNameCached(packageJsonPath: string): Promise<string | null> {
  let fingerprint: string;
  try {
    const stat = await fs.stat(packageJsonPath);
    fingerprint = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    packageNameCache.delete(packageJsonPath);
    return null;
  }

  const cached = packageNameCache.get(packageJsonPath);
  if (cached && cached.fingerprint === fingerprint) return cached.name;

  let name: string | null = null;
  try {
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };
    name = typeof packageJson.name === 'string' && packageJson.name ? packageJson.name : null;
  } catch {
    name = null;
  }
  packageNameCache.set(packageJsonPath, { fingerprint, name });
  return name;
}

export async function generateDisplayName(
  projectName: string,
  actualProjectDir: string | null = null,
): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const cachedName = await readPackageNameCached(packageJsonPath);
    if (cachedName) return cachedName;
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path — return only the last folder name.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}
