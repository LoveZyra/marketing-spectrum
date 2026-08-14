import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * 每种放行 MIME 对应的规范扩展名。
 *
 * 落盘文件名的扩展名必须由这张表决定,**不能沿用上传方给的文件名**。原先的清洗
 * 规则是 `originalname.replace(/[^a-zA-Z0-9.-]/g, '_')` —— 点号被保留,于是扩展名
 * 完全由上传方决定;而取文件的路由用 `mime.lookup(扩展名)` 定 Content-Type。
 * 两件事合起来:带一个 `Content-Type: image/png` 的分片、文件名写成 `x.html`,
 * 就能在应用同源下拿到一个 inline 的 HTML 文档,而 JWT 就存在 localStorage 里。
 * `nosniff` 挡不住这个 —— 声明出去的类型本身就是 text/html。
 */
const CANONICAL_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

/** 放行 MIME 对应的扩展名;未知类型回落到 `.bin`(取文件时会被当附件下载)。 */
export function canonicalExtensionForMimeType(mimeType: string): string {
  return CANONICAL_EXTENSION_BY_MIME_TYPE[mimeType] ?? '.bin';
}

/**
 * 允许 inline 呈现的扩展名 → Content-Type。取文件的路由据此定类型,而不是让
 * `mime.lookup` 从任意扩展名里猜 —— 早于本次加固上传的历史文件可能仍带着
 * 攻击者选定的扩展名,那些必须走附件下载而不是 inline 渲染。
 */
export function inlineContentTypeForFile(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  for (const [mimeType, canonical] of Object.entries(CANONICAL_EXTENSION_BY_MIME_TYPE)) {
    if (canonical === ext) {
      return mimeType;
    }
  }
  // .jpeg 与 .jpg 同义,单独收一下。
  return ext === '.jpeg' ? 'image/jpeg' : null;
}

/** Creates the global `~/.prism/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = getGlobalImageAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so nothing outside `~/.prism/assets` can ever be read through it.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  const resolved = path.resolve(assetsDir, trimmed);
  if (!resolved.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return resolved;
}
