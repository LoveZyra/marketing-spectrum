import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 项目的展示名 —— 优先用 package.json 的 name,否则取路径最后一段。
 *
 * ## 为什么住在 shared/ 而不是 projects 模块里
 *
 * 项目列表、sessions-watcher、chat-run-registry 都要用它。projects 模块的服务 import 了
 * providers 与 websocket 两个 barrel,它要是放进 projects 模块,providers / websocket 再来取它就会把
 * projects → providers → websocket 连成环。它只依赖 `node:fs` 和 `node:path`,是纯叶子,
 * 放在 shared/ 之后各模块都只向下引用(与 `prism-internal-transcripts.ts` 同理)。
 *
 * 成环不一定立刻出错:函数声明会提升,环上的模块拿到它时它已经存在。但 `provider.registry.ts`
 * 顶层有 `claude: new ClaudeProvider()`,环上任一模块改成箭头函数常量或加一个顶层 `new`,
 * 就会在加载期报 `is not a constructor`,而类型检查看不出来。
 */

/**
 * package.json 名字的缓存。
 *
 * 项目列表接口会对每个项目调一次,即 N 次磁盘 IO。按 (mtimeMs, size) 指纹
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
