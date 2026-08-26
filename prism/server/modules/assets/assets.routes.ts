import fsSync, { promises as fs } from 'node:fs';

import express from 'express';
import multer from 'multer';

import {
  buildAttachmentFilename,
  buildStoredImageRecords,
  inlineContentTypeForFile,
  isAllowedImageMimeType,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';
import { attachmentsDb, resolveVisibleProjectRoot } from '@/modules/database/index.js';
import {
  checkQuota,
  commitAttachmentWithinQuota,
  ensureAttachmentDir,
  quotaExceededMessage,
} from '@/shared/attachment-storage.js';
import { readRequestViewer } from '@/shared/project-visibility.js';

const router = express.Router();

/**
 * 这次上传该落到哪个目录。
 *
 * `projectId` 走 **query** 而不是 multipart 字段:multer 是流式解析的,
 * `req.body` 要等整个 body 收完才齐,而 `destination` 在**第一个文件字节到达前**
 * 就要给出答案。放 query 里就不依赖字段与文件在 multipart 里的先后顺序。
 *
 * 解析不出可见项目时回落全局目录 —— 会话还没落到项目上是正常状态,不能因此
 * 不让人传图。
 */
function resolveUploadTarget(req: express.Request): { dir: string; projectPath: string | null } {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  const projectRoot = projectId
    ? resolveVisibleProjectRoot(readRequestViewer(req), projectId)
    : null;
  return ensureAttachmentDir(projectRoot);
}

// 落盘目录按会话所属项目走(拿不到项目时回落全局);文件名由服务生成。
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      cb(null, resolveUploadTarget(req).dir);
    } catch (error) {
      cb(error as Error, '');
    }
  },
  filename: (req, file, cb) => {
    cb(null, buildAttachmentFilename(file.originalname, file.mimetype));
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (isAllowedImageMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 5,
  },
});

/**
 * Stores chat image attachments in the global `~/.prism/assets` folder and
 * returns their absolute paths for use in provider prompts and chat history.
 */
router.post('/images', (req, res) => {
  const viewer = readRequestViewer(req);
  const declaredBytes = Number(req.headers['content-length']) || 0;
  const verdict = checkQuota(viewer.userId as number | null, declaredBytes);
  if (!verdict.ok) {
    return res.status(413).json({ error: quotaExceededMessage(verdict) });
  }

  upload.array('images', 5)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : '上传失败';
      return res.status(400).json({ error: message });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: '没有收到图片文件' });
    }

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
    const target = resolveUploadTarget(req);

    // 落盘后按真实字节逐个把关(预检那道 Content-Length 挡不住 chunked 与并发)。
    // 一批图要么全部入账,要么全部删掉回滚 —— composer 是把这几张当一组附件的,
    // 半成功只会让人困惑。
    const committed: { absPath: string; userId: number | null }[] = [];
    let failure: { reason?: 'quota' | 'error'; usedBytes: number; quotaBytes: number } | null = null;
    for (const file of files) {
      const absPath = `${file.destination}/${file.filename}`;
      const commit = commitAttachmentWithinQuota({
        userId: viewer.userId as number | null,
        sessionId,
        projectPath: target.projectPath,
        kind: 'image',
        absPath,
        bytes: file.size,
      });
      if (!commit.ok) { failure = commit; break; }
      committed.push({ absPath, userId: viewer.userId as number | null });
    }

    if (failure) {
      // 回滚:删掉本批已记账的行与其文件,以及还没记账的剩余文件。
      for (const done of committed) attachmentsDb.forget(done.absPath);
      for (const file of files) {
        fs.unlink(`${file.destination}/${file.filename}`).catch(() => {});
      }
      return failure.reason === 'quota'
        ? res.status(413).json({ error: quotaExceededMessage(failure) })
        : res.status(500).json({ error: '图片保存失败,请重试' });
    }

    res.json({ images: buildStoredImageRecords(files) });
  });
});

/**
 * Serves one stored image asset by filename. Only files directly inside the
 * global assets folder are reachable; traversal attempts resolve to null.
 */
router.get('/images/:filename', async (req, res) => {
  const resolved = resolveImageAssetFile(req.params.filename);
  if (!resolved) {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }

  try {
    await fs.access(resolved);
  } catch {
    return res.status(404).json({ error: 'Asset not found' });
  }

  // 类型来自白名单,不来自 `mime.lookup(任意扩展名)`。白名单之外的一律按
  // 二进制附件下发 —— 本次加固之前落盘的历史文件可能仍带着上传方选定的扩展名。
  const inlineType = inlineContentTypeForFile(resolved);
  const contentType = inlineType ?? 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  if (!inlineType) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  // Stored-XSS hardening: never let the browser sniff a different type, and
  // force SVGs (which can carry scripts when rendered as a document) to
  // download instead of rendering inline. The chat UI is unaffected — it
  // fetches assets as blobs and shows them through <img>, where SVG scripts
  // never execute.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (contentType === 'image/svg+xml') {
    res.setHeader('Content-Disposition', 'attachment');
  }
  const fileStream = fsSync.createReadStream(resolved);
  fileStream.pipe(res);
  fileStream.on('error', (error) => {
    console.error('Error streaming image asset:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading asset' });
    }
  });
});

export default router;
