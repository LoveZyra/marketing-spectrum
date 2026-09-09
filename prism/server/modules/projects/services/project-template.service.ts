/**
 * 项目模板:新建项目时把一棵现成的目录树复制进去。
 *
 * ## 为什么要有
 *
 * `createProject()` 现在只是 mkdir + 写一行 DB —— 不写 `CLAUDE.md`、不 `git init`、
 * 不建目录结构。每个新项目都从空目录开始,团队的目录约定、数据路径约定,
 * 靠每个人重新讲一遍给 agent 听。审计报告把它列在功能项第 3 条。
 *
 * ## 刻意**不做**模板引擎
 *
 * 没有变量替换、没有条件渲染、没有 `{{project_name}}`。模板就是服务器上一棵普通
 * 文件树,创建时递归 copy。审计报告的原话:目录 copy 覆盖 90% 需求。
 * 剩下 10% 让人自己改两行,比维护一套模板语言便宜得多 —— 而模板语言一旦有了,
 * 就会有人往里塞逻辑,然后它变成第二个需要调试的东西。
 *
 * ## 安全:这个功能的真正难点
 *
 * "按用户给的 id 把服务器上一棵树复制到另一个位置"是个危险的形状。四道门:
 *
 * 1. **模板 id 不许逃出模板根**。只接受单段名字,`..` / `/` / 绝对路径一律拒。
 * 2. **符号链接一律拒,不跟随也不复制**。模板里放一个
 *    `secrets -> ~/.prism/auth.db`:跟随就是把库的内容复制进一个别人看得见的项目,
 *    照抄链接就是在项目里种一条指向库的路。两种都不行,所以**发现即整体拒绝**,
 *    而不是跳过 —— 静默跳过会让人以为模板生效了。
 * 3. **不覆盖已有文件**。新建项目可能是"复活一条归档路径",那个目录里有真东西。
 *    已存在的文件一律跳过,不是覆盖。
 * 4. **有上限**。文件数和总字节都封顶,免得一棵失控的模板(或者有人往模板根里
 *    软链了个大目录)把磁盘写满。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { AppError } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';

const log = createLogger('templates');

/** 一个模板最多这么多文件 / 这么多字节。够放一套脚手架,不够放数据集。 */
export const TEMPLATE_MAX_FILES = 500;
export const TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;

/** 模板目录里这些不复制 —— 它们是模板自己的元数据/垃圾,不是脚手架的一部分。 */
const SKIP_ENTRIES = new Set(['.prism-template.json', '.git', 'node_modules', '.DS_Store']);

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string | null;
  fileCount: number;
  totalBytes: number;
};

/**
 * 模板根目录。默认在数据目录下,而不是 `WORKSPACES_ROOT` 里 ——
 * 放工作区里的话它自己会变成一个"项目",出现在侧栏、能被人改。
 */
export const templatesRoot = (): string =>
  process.env.PRISM_PROJECT_TEMPLATES_DIR?.trim()
  || path.join(os.homedir(), '.prism', 'templates');

/**
 * 校验并解析模板 id。
 *
 * 只接受**单段**名字。这里不做 `path.resolve` 之后再判前缀那种事 —— 那种写法
 * 每次都要重新论证一遍对不对。直接把形状收死:不含分隔符、不是 `.` / `..`、
 * 不以点开头(隐藏目录不作为模板)、长度有限。
 */
export const resolveTemplateDir = (templateId: string): string => {
  const id = String(templateId ?? '').trim();
  const looksSafe = id.length > 0
    && id.length <= 100
    && !id.includes('/')
    && !id.includes('\\')
    && !id.includes('\0')
    && id !== '.'
    && id !== '..'
    && !id.startsWith('.');
  if (!looksSafe) {
    throw new AppError(`模板名不合法: ${id}`, { code: 'INVALID_TEMPLATE_ID', statusCode: 400 });
  }
  return path.join(templatesRoot(), id);
};

const readTemplateMeta = async (dir: string): Promise<{ name?: string; description?: string }> => {
  try {
    const raw = await fs.readFile(path.join(dir, '.prism-template.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
    };
  } catch {
    // 没有元数据文件是正常的 —— 目录名就是模板名。
    return {};
  }
};

/**
 * 走一棵模板树,收集要复制的文件。
 *
 * 返回相对路径列表而不是边走边复制:先全部看一遍再动手,遇到符号链接或超限时
 * **一个文件都还没写**,不会留下半棵树。
 */
async function collectTemplateFiles(
  rootDir: string,
  relative = '',
  accumulator: { files: Array<{ rel: string; bytes: number }>; dirs: string[]; bytes: number } = { files: [], dirs: [], bytes: 0 },
): Promise<typeof accumulator> {
  const absolute = path.join(rootDir, relative);
  const entries = await fs.readdir(absolute, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const rel = relative ? path.join(relative, entry.name) : entry.name;

    if (entry.isSymbolicLink()) {
      /*
       * 整体拒绝,不是跳过。
       *
       * 跟随链接 = 把 `~/.prism/auth.db` 的内容复制进一个别人看得见的项目;
       * 照抄链接 = 在项目里种一条指向库的路。两种都不行。
       * 而**静默跳过**同样不行:模板作者会以为那个文件生效了。
       */
      throw new AppError(
        `模板里有符号链接,拒绝使用:${rel}。模板必须是普通文件和目录。`,
        { code: 'TEMPLATE_HAS_SYMLINK', statusCode: 400 },
      );
    }

    if (entry.isDirectory()) {
      accumulator.dirs.push(rel);
      await collectTemplateFiles(rootDir, rel, accumulator);
      continue;
    }

    if (!entry.isFile()) continue;   // 设备文件、FIFO 之类:不是脚手架的东西

    const stats = await fs.stat(path.join(rootDir, rel));
    accumulator.files.push({ rel, bytes: stats.size });
    accumulator.bytes += stats.size;

    if (accumulator.files.length > TEMPLATE_MAX_FILES) {
      throw new AppError(
        `模板文件数超过 ${TEMPLATE_MAX_FILES} 个,拒绝使用。模板是脚手架,不是数据集。`,
        { code: 'TEMPLATE_TOO_MANY_FILES', statusCode: 400 },
      );
    }
    if (accumulator.bytes > TEMPLATE_MAX_BYTES) {
      throw new AppError(
        `模板总大小超过 ${Math.round(TEMPLATE_MAX_BYTES / 1024 / 1024)}MB,拒绝使用。`,
        { code: 'TEMPLATE_TOO_LARGE', statusCode: 400 },
      );
    }
  }

  return accumulator;
}

/** 列出可用模板。模板根不存在时返回空数组 —— 没配模板不是错误。 */
export async function listProjectTemplates(): Promise<ProjectTemplate[]> {
  const root = templatesRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const templates: ProjectTemplate[] = [];
  for (const entry of entries) {
    // 只认普通目录:符号链接指向的目录不列出来,免得它绕开 resolveTemplateDir 的形状检查
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    const meta = await readTemplateMeta(dir);
    try {
      const collected = await collectTemplateFiles(dir);
      templates.push({
        id: entry.name,
        name: meta.name?.trim() || entry.name,
        description: meta.description?.trim() || null,
        fileCount: collected.files.length,
        totalBytes: collected.bytes,
      });
    } catch (error) {
      // 一个坏模板不该让整个列表挂掉 —— 但要在日志里说清楚是哪个、为什么。
      log.warn(`模板「${entry.name}」不可用:`, (error as Error)?.message ?? error);
    }
  }
  /*
   * 按 **id**(目录名)排,而且**locale 写死 'en'**。
   *
   * 两处都是被测试逼出来的:
   *   - 按 `name` 排的话,显示名可以是中文、可以带前缀,顺序跟着文案走 ——
   *     运维在服务器上看到的目录顺序和界面上的对不上,选错模板很容易;
   *   - 不写 locale 的 `localeCompare` **依赖运行环境的 ICU**。实测这台机器上
   *     `'E'.localeCompare('b') === 1`(E 排在 b 后面),而 small-icu 的 Node
   *     或别的系统 locale 下可能相反。同一个模板列表在两台机器上顺序不同,
   *     这种事查起来极其费劲。
   * `numeric` 让 `tpl2` 排在 `tpl10` 前面,而不是字典序的反过来。
   */
  return templates.sort((left, right) =>
    left.id.localeCompare(right.id, 'en', { numeric: true, sensitivity: 'base' }));
}

export type ApplyTemplateResult = {
  templateId: string;
  filesWritten: number;
  filesSkipped: string[];
};

/**
 * 一份**验过、可以直接铺**的模板计划。
 *
 * ## 为什么要把"验"和"铺"拆成两步
 *
 * 探针里抓到的真事:我第一版在 `createProject` 的**末尾**铺模板,于是
 * `templateId: "../evil"` 这种请求走的是 ——
 *
 *   建目录 → 项目行落库 → 铺模板时才发现名字不合法 → 抛 → 接口回 `success:false`
 *
 * 用户被告知"创建失败",而项目**已经在库里了**,下次刷新就出现在侧栏。
 * 我连打五个非法请求,侧栏就多了五个幽灵项目。
 *
 * 拆开之后:`prepare` 在**动任何东西之前**跑完(名字形状、模板存在、符号链接、
 * 大小上限全在这一步),不合法就在什么都还没建的时候失败。
 * 这比"失败了再回滚"可靠 —— 回滚本身也会失败,而且要考虑"复活归档路径"那种
 * 根本不该回滚的情形。
 */
export type PreparedTemplate = {
  templateId: string;
  templateDir: string;
  dirs: string[];
  files: Array<{ rel: string; bytes: number }>;
};

/**
 * 验一个模板,返回可以直接铺的计划。**不碰目标目录。**
 *
 * 所有拒绝都发生在这里:名字形状、模板存在与否、符号链接、文件数与字节上限。
 */
export async function prepareProjectTemplate(templateId: string): Promise<PreparedTemplate> {
  const templateDir = resolveTemplateDir(templateId);

  const stats = await fs.lstat(templateDir).catch(() => null);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AppError(`模板不存在: ${templateId}`, { code: 'TEMPLATE_NOT_FOUND', statusCode: 404 });
  }

  // 先全部看一遍:遇到符号链接或超限时一个文件都还没写。
  const collected = await collectTemplateFiles(templateDir);
  return { templateId, templateDir, dirs: collected.dirs, files: collected.files };
}

/**
 * 把一份验过的计划铺进目标目录。
 *
 * **已存在的文件跳过,不覆盖。** 新建项目也可能是"复活一条归档路径",
 * 那个目录里有真东西 —— 拿模板盖上去就是数据丢失。跳过的清单会返回给调用方,
 * 让界面能如实说"这几个文件已存在,没动"。
 */
export async function writePreparedTemplate(
  prepared: PreparedTemplate,
  targetDir: string,
): Promise<ApplyTemplateResult> {
  const { templateId, templateDir } = prepared;
  const collected = { dirs: prepared.dirs, files: prepared.files };

  for (const dir of collected.dirs) {
    await fs.mkdir(path.join(targetDir, dir), { recursive: true });
  }

  const skipped: string[] = [];
  let written = 0;
  for (const file of collected.files) {
    const destination = path.join(targetDir, file.rel);
    // COPYFILE_EXCL:目标已存在就抛 EEXIST,而不是覆盖。用 flag 而不是先 stat 再写,
    // 是因为后者中间有窗口(而且要多一次 syscall)。
    try {
      await fs.copyFile(path.join(templateDir, file.rel), destination, fs.constants.COPYFILE_EXCL);
      written += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        skipped.push(file.rel);
        continue;
      }
      throw error;
    }
  }

  log.info(`模板「${templateId}」已铺到 ${targetDir}:写入 ${written} 个文件`
    + (skipped.length > 0 ? `,跳过 ${skipped.length} 个已存在的` : ''));

  return { templateId, filesWritten: written, filesSkipped: skipped };
}

/**
 * 验 + 铺,一步到位。给测试和"目标目录已经确定存在"的调用点用。
 *
 * `createProject` **不走这个** —— 它必须先 `prepareProjectTemplate` 把校验做完,
 * 再去建目录和写库,否则非法模板名会留下一个"接口说失败、库里却有"的幽灵项目。
 */
export async function applyProjectTemplate(
  templateId: string,
  targetDir: string,
): Promise<ApplyTemplateResult> {
  return writePreparedTemplate(await prepareProjectTemplate(templateId), targetDir);
}
