import path from 'node:path';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';
import { recoverUploadFilename } from '@/shared/upload-filename.js';

/**
 * 聊天图片附件接受的 mime。
 *
 * 不收 SVG:发送给模型时 SVG 会被跳过,用户看到图已附上、模型却说没看到。
 * 上传即拒、当场给出理由,比传上去再静默丢掉诚实得多。
 * SVG 还有存储型 XSS 风险,资源路由对它强制 `attachment` 下发。
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path: the project's `attachments/` folder or the global fallback. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  /** multer 实际写入的目录;项目 attachments/ 或全局回落目录。 */
  destination?: string;
  size: number;
  mimetype: string;
};

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * MIME → 规范扩展名。
 *
 * 落盘文件名的扩展名必须由这张表决定,不能沿用上传方给的文件名:若扩展名由上传方决定、
 * 取文件时又按扩展名定 Content-Type,声明 `image/png` 的分片配上 `x.html` 的文件名,
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
 * `mime.lookup` 从任意扩展名里猜 —— 早期上传的文件可能仍带着上传方选定的
 * 扩展名,那些必须走附件下载而不是 inline 渲染。
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

/**
 * 落盘文件名:原名主干(最多 60 字符)+ 随机后缀 + 规范扩展名。
 *
 * 附件目录明放在项目文件树里,名字得让人认得出来;但可读不能以放松约束为代价:
 *   1. 扩展名只由已校验的 MIME 决定(理由见 CANONICAL_EXTENSION_BY_MIME_TYPE)。
 *   2. 不留任何路径分隔符,`basename` 之后再洗一遍。
 *   3. 必带随机后缀,否则同名文件会互相覆盖(两个人各传一张 `截图.png`)。
 */
export function buildAttachmentFilename(originalName: string, mimeType: string): string {
  // 先恢复编码,再洗:multer 把 multipart 的 filename 按 latin1 读,`附件.png`
  // 到这里是 `é™„ä»¶.png`,直接洗就会以乱码落盘 —— 而附件目录明放在项目文件树里。
  const raw = recoverUploadFilename(typeof originalName === 'string' ? originalName : '');
  // 先取 basename 去掉目录部分,再把控制字符、分隔符、以及各系统的保留字符洗掉。
  const base = path.basename(raw.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const stem = (base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base).slice(0, 60) || 'attachment';
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stem}-${suffix}${canonicalExtensionForMimeType(mimeType)}`;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  return files.map((file) => ({
    // 与落盘名走同一道恢复(buildAttachmentFilename 里那一道),否则文件树里是
    // 中文、附件卡片上是乱码 —— 两个名字漂开比两个都乱码更难查。
    name: recoverUploadFilename(file.originalname),
    // 目录由 multer 的 destination 决定(项目 attachments/ 或全局回落),
    // 不能假定就是全局目录 —— 假定错了,历史里存的路径会指向不存在的文件。
    path: toPosixPath(path.join(file.destination || getGlobalImageAssetsDir(), file.filename)),
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
