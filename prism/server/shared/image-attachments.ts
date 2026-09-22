import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '../utils/runtime-paths.js';

import { downscaleImageForModel, formatBytes } from './image-downscale.js';
import { createLogger } from './logger.js';
const log = createLogger('attachments');

/**
 * Shared image-attachment plumbing for the Claude runtime.
 *
 * Uploaded chat images are persisted once in the global assets folder under
 * the Prism data directory and referenced by absolute path everywhere else;
 * Claude reads those paths back into base64 `image` content blocks.
 *
 * The chat UI loads them through the dedicated `/api/assets/images/:filename`
 * route, which serves only from this folder.
 */

/**
 * Global storage folder for uploaded chat image attachments.
 *
 * Resolved through getDataDir() rather than hardcoding a home-relative path,
 * so it follows PRISM_DATA_DIR and the one-time ~/.cloudcli -> ~/.prism
 * migration. Hardcoding it here previously meant uploads kept writing to the
 * pre-migration folder while the rest of the app read the new one.
 */
export function getGlobalImageAssetsDir(): string {
  return path.join(getDataDir(), 'assets');
}

/**
 * 项目内附件目录名。与 `shared/attachment-storage.ts` 的同名常量必须一致 ——
 * 这里就地定义是为了不把配额/落盘那一整套依赖拖进 provider 侧的构建路径。
 * 两处不一致会让"上传落哪"和"允许读哪"再次分家,所以那边有一条测试钉住它们相等。
 */
export const ATTACHMENT_DIR_NAME = 'attachments';

export type ImageAttachmentDescriptor = {
  /** Project-relative (preferred) or absolute path to the stored image. */
  path: string;
  name?: string;
  mimeType?: string;
};

/** Media types the Claude Messages API accepts for base64 image blocks. */
const CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Accepts the loosely-typed `options.images` payload from chat.send and
 * returns only well-formed descriptors. Plain path strings are supported so
 * callers can also pass bare path arrays.
 */
export function normalizeImageDescriptors(images: unknown): ImageAttachmentDescriptor[] {
  if (!Array.isArray(images)) {
    return [];
  }

  const descriptors: ImageAttachmentDescriptor[] = [];
  for (const entry of images) {
    if (typeof entry === 'string' && entry.trim()) {
      descriptors.push({ path: entry.trim() });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const entryPath = typeof record.path === 'string' ? record.path.trim() : '';
      if (!entryPath) {
        continue;
      }
      descriptors.push({
        path: entryPath,
        name: typeof record.name === 'string' ? record.name : undefined,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
      });
    }
  }
  return descriptors;
}

/** Normalizes Windows separators so stored references stay portable. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Resolves a project-relative image path against the run's working directory. */
export function resolveImageAbsolutePath(cwd: string | undefined, imagePath: string): string {
  if (path.isAbsolute(imagePath)) {
    return imagePath;
  }
  return path.resolve(cwd || process.cwd(), imagePath);
}

function isPathInsideDirectory(candidate: string, directory: string): boolean {
  // resolve + startsWith(root + separator) is the containment idiom CodeQL
  // recognizes as a path-injection barrier, and matches the check used by
  // resolveImageAssetFile in the assets module. The root itself never
  // matches (no trailing separator after resolve), only entries below it.
  const resolvedRoot = path.resolve(directory) + path.sep;
  return path.resolve(candidate).startsWith(resolvedRoot);
}

function getDirectoryPathVariants(directory: string): string[] {
  const resolvedDirectory = path.resolve(directory);
  try {
    const canonicalDirectory = path.resolve(realpathSync(directory));
    return canonicalDirectory === resolvedDirectory
      ? [resolvedDirectory]
      : [resolvedDirectory, canonicalDirectory];
  } catch {
    return [resolvedDirectory];
  }
}

/**
 * A7:**一张图片可以来自哪些目录 —— 只有这一个答案。**
 *
 * ## 事故
 *
 * 之前"合法的图片路径"在三个地方各定义了一遍,而且互不相同:
 *
 * | 位置 | 允许的根 | 依据来自 |
 * |---|---|---|
 * | 上传落盘(`POST /api/assets/images`) | `<项目根>/attachments/`,解析不到项目才回落全局 | 前端传的 `projectId`(侧栏选中的那个) |
 * | `chat.send` 过滤 | 全局 + `session.project_path + '/attachments'` | `sessions` 表里那条会话的 `project_path` |
 * | 组装给模型(这里) | 全局 + **本轮 cwd** | 运行时的工作目录 |
 *
 * 三个来源不一样,只要有一处对不齐,图片就在那一道门被**静默丢掉** ——
 * 而界面照样显示得好好的(前端按侧栏的 projectId 走
 * `/api/projects/:id/files/content` 取原图)。于是用户看到的是:
 * **图在页面上,模型却说"传不进来"**,日志之外没有任何线索。
 *
 * 最容易踩到的是 root:它对所有项目可见,上传一定落进项目的 `attachments/`
 * (普通用户看不见的项目会回落全局目录,反而三道门都认)。会话行里的
 * `project_path` 与侧栏那个项目只要差一个字符,这一轮的图就全丢。
 *
 * ## 收口
 *
 * 现在只有 `imageSourceRoots()` 一个函数回答这个问题,三处都走它:
 * 全局图库 + 本轮 cwd + **cwd 自己的 `attachments/`** + 显式传入的会话项目根
 * 及其 `attachments/`。判据一致之后,"上传得进去、发不出来"这个组合不再成立。
 *
 * 安全水位不变:这些目录本来就是这个会话读得到的(cwd 是 agent 的工作目录,
 * 项目 attachments/ 在项目里),`~/.ssh` 之类照旧拒绝。
 */
export function imageSourceRoots(cwd?: string, projectRoots: readonly string[] = []): string[] {
  const workingDir = cwd || process.cwd();
  const roots = [
    getGlobalImageAssetsDir(),
    workingDir,
    path.join(workingDir, ATTACHMENT_DIR_NAME),
  ];
  for (const projectRoot of projectRoots) {
    if (typeof projectRoot === 'string' && projectRoot.trim()) {
      roots.push(projectRoot, path.join(projectRoot, ATTACHMENT_DIR_NAME));
    }
  }
  return roots;
}

/**
 * Second layer of the image trust boundary (the first is the chat.send filter
 * in the websocket gateway): provider builders only reference files that live
 * in one of `imageSourceRoots()` — places the agent could already access on
 * its own. Anything else (e.g. `~/.ssh`) is refused, so a caller-supplied
 * descriptor can never leak arbitrary files.
 */
export function isAllowedImageSourcePath(
  resolvedPath: string,
  cwd?: string,
  projectRoots: readonly string[] = [],
): boolean {
  return imageSourceRoots(cwd, projectRoots).some((directory) =>
    getDirectoryPathVariants(directory).some((directoryVariant) =>
      isPathInsideDirectory(resolvedPath, directoryVariant)
    )
  );
}

/**
 * Resolves the media type for one image, preferring the uploaded mime type and
 * falling back to the file extension.
 */
export function resolveImageMediaType(descriptor: ImageAttachmentDescriptor): string | null {
  if (descriptor.mimeType) {
    return descriptor.mimeType;
  }
  const extension = path.extname(descriptor.path).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[extension] || null;
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Builds the Claude user-message content list: the prompt text followed by one
 * base64 `image` block per attachment. Images the Claude API cannot accept
 * (e.g. SVG) or that fail to read are skipped with a warning so the prompt
 * itself still goes through.
 */
export async function buildClaudeUserContent(
  prompt: string,
  images: unknown,
  cwd?: string,
  /**
   * A7:会话所属项目根 —— 与 `chat.send` 那道门用的是**同一个来源**。
   *
   * cwd 通常就是项目根,但不是必然:分叉出来的会话、外部 API 起的回合、
   * 以及 cwd 被显式指过的运行时都会不一样。传进来才能保证两道门判据一致。
   */
  projectRoots: readonly string[] = [],
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [{ type: 'text', text: prompt }];

  for (const descriptor of normalizeImageDescriptors(images)) {
    const mediaType = resolveImageMediaType(descriptor);
    if (!mediaType || !CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType)) {
      log.warn(`[Images] Skipping unsupported Claude image type for ${descriptor.path}`);
      continue;
    }

    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd, projectRoots)) {
      log.warn(`[Images] Refusing to read image outside allowed roots: ${descriptor.path} (cwd=${cwd ?? '-'}, projectRoots=${projectRoots.join(',') || '-'})`);
      continue;
    }

    try {
      const canonicalPath = await fs.realpath(resolvedPath);
      if (!isAllowedImageSourcePath(canonicalPath, cwd, projectRoots)) {
        log.warn(`[Images] Refusing to read symlinked image outside allowed roots: ${descriptor.path}`);
        continue;
      }

      const bytes = await fs.readFile(canonicalPath);
      /**
       * 发给模型之前在内存里缩一遍(长边 1568、~1MB),**磁盘原图不动**。
       * 用户贴什么就传什么的话,一张手机原图就是 3.6MB 的 base64,而且它会跟着
       * transcript 每一轮重发;把 base64 当文本计数的网关直接给你算出一百万 token。
       * 详见 image-downscale.ts。
       */
      const scaled = await downscaleImageForModel(bytes, mediaType);
      if (scaled.changed) {
        log.info(
          `[Images] 发给模型前缩图 ${path.basename(canonicalPath)}:`
          + ` ${formatBytes(scaled.original.bytes)} ${scaled.original.width}×${scaled.original.height}`
          + ` → ${formatBytes(scaled.output.bytes)} ${scaled.output.width}×${scaled.output.height}`,
        );
      }
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: scaled.mediaType,
          data: scaled.bytes.toString('base64'),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[Images] Failed to read image ${descriptor.path}: ${message}`);
    }
  }

  return blocks;
}
