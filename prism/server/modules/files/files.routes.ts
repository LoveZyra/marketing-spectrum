import crypto from 'node:crypto';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express, { type RequestHandler, type Router } from 'express';
import mime from 'mime-types';
import multer from 'multer';

import { attachmentsDb, projectsDb, resolveVisibleProjectRoot } from '@/modules/database/index.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import {
  getFileTree,
  getFileTreeMaxEntries,
  type FileTreeBudget,
} from '@/modules/files/services/file-tree.service.js';
import {
  resolveReadablePath as resolveReadablePathWith,
  validateFilename,
  validatePathInProject,
  type ProjectPathValidation,
} from '@/modules/files/services/path-validation.service.js';
import { searchProjectFiles } from '@/modules/files/services/project-search.service.js';
import { validateWorkspacePath, WORKSPACES_ROOT } from '@/shared/utils.js';

// The file tree can browse above the project root (see the ?path= parameter on
// GET /api/projects/:projectId/files), but READING a file it lists is a
// separate permission and stays project-scoped by default: listing a directory
// is something /api/browse-filesystem already lets this authenticated user do,
// while streaming arbitrary bytes out of the home directory is not — and a
// leaked token should not turn the file endpoints into a reader for ~/.ssh.
//
// Operators who want the editor to follow the tree everywhere set
// PRISM_FILETREE_ALLOW_EXTERNAL_READ=1, which widens reads — and only reads —
// to the same WORKSPACES_ROOT boundary the tree navigates. Writes, renames,
// deletes and uploads stay project-scoped in both modes.
const FILE_TREE_ALLOW_EXTERNAL_READ = /^(1|true|yes|on)$/i.test(
  process.env.PRISM_FILETREE_ALLOW_EXTERNAL_READ ?? ''
);

// Whole gigabytes read as a typo when spelled in megabytes ("1024MB"), so the
// user-facing labels collapse them. Mirrors the label in the file-tree
// constants module, which the client renders in the upload button tooltip.
const formatUploadSizeLabel = (megabytes: number): string => (
  megabytes % 1024 === 0 ? `${megabytes / 1024}GB` : `${megabytes}MB`
);

/**
 * 允许在浏览器里 inline 呈现的类型:只有位图、音频、视频。
 *
 * 名单之外的一律 `Content-Disposition: attachment` —— 包括 HTML、SVG(能带脚本)、
 * XML、以及任何"看起来无害"的文本类型。这里宁可窄:名单里少一个类型,最坏结果
 * 是直接导航时变成下载(应用内的 blob 读取完全不受影响);名单里多一个能承载
 * 脚本的类型,就是一个同源的存储型 XSS。
 */
export function isInlineSafeContentType(mimeType: string): boolean {
  const type = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (type === 'image/svg+xml') return false;
  return type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/');
}

const MAX_FILE_UPLOAD_SIZE_MB = 1024;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_SIZE_LABEL = formatUploadSizeLabel(MAX_FILE_UPLOAD_SIZE_MB);
const MAX_FILE_UPLOAD_COUNT = 20;

// multer enforces a per-file size and a per-request file count, but has no
// notion of a request total: 20 files each a byte under the per-file cap is a
// legal 20GB write into the temp dir. The per-file limit bounds any one item;
// this is the limit that actually bounds the disk.
//
// Overridable because the right ceiling is a property of the host's disk rather
// than of the code — an operator should be able to tighten it on a small VPS,
// or open it up on a big one, without a rebuild.
const DEFAULT_MAX_FILE_UPLOAD_TOTAL_MB = 2048;

const resolveMaxUploadTotalMb = (raw: string | undefined): number => {
  const parsed = Number.parseInt(raw ?? '', 10);
  // Zero or negative would disable uploads outright rather than uncap them,
  // which is never what setting a *maximum* is meant to express. Treat any
  // unusable value as "unset" so a typo degrades to the default instead of
  // silently breaking every upload.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_FILE_UPLOAD_TOTAL_MB;
  }
  // A total below the per-file cap would make that cap unreachable and its error
  // message a lie ("maximum size is 1GB" on a server that refuses 600MB). Clamp
  // so the two limits can never contradict each other.
  return Math.max(parsed, MAX_FILE_UPLOAD_SIZE_MB);
};

const MAX_FILE_UPLOAD_TOTAL_MB = resolveMaxUploadTotalMb(process.env.PRISM_UPLOAD_MAX_TOTAL_MB);
const MAX_FILE_UPLOAD_TOTAL_BYTES = MAX_FILE_UPLOAD_TOTAL_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_TOTAL_LABEL = formatUploadSizeLabel(MAX_FILE_UPLOAD_TOTAL_MB);
const UPLOAD_TOTAL_EXCEEDED_MESSAGE =
  `Upload too large. Maximum total size is ${MAX_FILE_UPLOAD_TOTAL_LABEL} per upload.`;

// 分片上传:给"Prism 挂在请求体受限的反向代理后面"这类部署用。nginx/openresty 的
// client_max_body_size 在请求到达 Node 之前就把超限的体砍掉、回自己的 413 HTML 页,
// 上游允许 1GB 也没用,而且那层拒绝在应用日志里不留痕迹。把文件切成小于代理上限的片
// 逐个发,服务端按序追加还原,最后落到与批量上传完全相同的目标路径。
// 默认 15MB 为本部署实测通过的值;用 PRISM_UPLOAD_CHUNK_MB 调,不必改代码。
const parseChunkMb = (raw: string | undefined): number => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
};
const UPLOAD_CHUNK_MB = parseChunkMb(process.env.PRISM_UPLOAD_CHUNK_MB);
const UPLOAD_CHUNK_BYTES = UPLOAD_CHUNK_MB * 1024 * 1024;
// 单个分片请求的硬上限:分片本体 + multipart 边界与字段的余量。
const UPLOAD_CHUNK_REQUEST_BYTES = UPLOAD_CHUNK_BYTES + 1024 * 1024;
// 未完成会话的保留时长:断网/关页面留下的 .part 必须有人收,否则临时盘只涨不落。
const UPLOAD_CHUNK_TTL_MS = 60 * 60 * 1000;

type ChunkSession = {
  name: string;
  relativePath: string;
  targetPath: string;
  projectId: string;
  partPath: string;
  received: number;
  declaredSize: number;
  nextIndex: number;
  updatedAt: number;
};

const uploadChunkSessions = new Map<string, ChunkSession>();

// uploadId 只能是服务端签发的 32 位十六进制:它要拼进文件路径,任何来自客户端的
// 自由字符串都是一条路径穿越的口子。
const isValidUploadId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

const dropUploadChunkSession = (uploadId: string): void => {
  const session = uploadChunkSessions.get(uploadId);
  uploadChunkSessions.delete(uploadId);
  if (session) fsPromises.unlink(session.partPath).catch(() => {});
};

/** 追加一个分片到 .part。流式拼接,不把 15MB 拎进堆里。 */
const appendChunkFile = (partPath: string, chunkPath: string): Promise<void> => (
  new Promise<void>((resolve, reject) => {
    const source = fs.createReadStream(chunkPath);
    const sink = fs.createWriteStream(partPath, { flags: 'a' });
    source.on('error', reject);
    sink.on('error', reject);
    sink.on('close', () => resolve());
    source.pipe(sink);
  })
);

// 过期会话清扫。unref() 保证它不会把进程钉在事件循环里。
const uploadChunkSweeper = setInterval(() => {
  const cutoff = Date.now() - UPLOAD_CHUNK_TTL_MS;
  for (const [uploadId, session] of uploadChunkSessions) {
    if (session.updatedAt < cutoff) dropUploadChunkSession(uploadId);
  }
}, 10 * 60_000);
if (typeof uploadChunkSweeper.unref === 'function') uploadChunkSweeper.unref();

const chunkUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { cb(null, os.tmpdir()); },
    filename: (_req, _file, cb) => cb(null, `chunkpart-${Date.now()}-${Math.round(Math.random() * 1E9)}`),
  }),
  limits: { fileSize: UPLOAD_CHUNK_REQUEST_BYTES, files: 1 },
});

type FilesRouterDependencies = {
  /**
   * JWT auth middleware (server/middleware/auth.js). Injected by the
   * composition root: the eslint boundaries config classifies middleware as
   * outside the module graph, so modules receive it instead of importing it.
   */
  authenticateToken: RequestHandler;
};

const expandWorkspacePath = (inputPath: string): string => {
  if (!inputPath) return inputPath;
  if (inputPath === '~') {
    return WORKSPACES_ROOT;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(WORKSPACES_ROOT, inputPath.slice(2));
  }
  return inputPath;
};

/** Bound `resolveReadablePath` to this deployment's opt-in setting. */
const resolveReadablePath = (
  projectRoot: string,
  filePath: string,
): Promise<ProjectPathValidation> =>
  resolveReadablePathWith(projectRoot, filePath, FILE_TREE_ALLOW_EXTERNAL_READ);

/**
 * Tell the client where the tree it just received is rooted and how far up it
 * may walk from there.
 *
 * This rides in headers, next to X-Prism-Truncated, because the body is a bare
 * array that four separate call sites already destructure as one. Values are
 * percent-encoded: header values are latin-1 and real project paths contain
 * non-ASCII directory names.
 *
 * The parent is resolved here rather than in the browser so the boundary rule
 * lives in exactly one place — the server that enforces it. An absent
 * X-Prism-Tree-Parent means "this is as far up as you go", which is the only
 * thing the client needs to know to render the control correctly.
 */
async function setTreeLocationHeaders(
  res: Parameters<RequestHandler>[1],
  listedPath: string,
  projectRoot: string,
): Promise<void> {
  res.setHeader('X-Prism-Tree-Root', encodeURIComponent(listedPath));
  res.setHeader('X-Prism-Tree-Project-Root', encodeURIComponent(projectRoot));
  if (FILE_TREE_ALLOW_EXTERNAL_READ) {
    res.setHeader('X-Prism-Tree-External-Read', '1');
  }

  const parent = path.dirname(listedPath);
  if (!parent || parent === listedPath) {
    return;
  }
  const parentValidation = await validateWorkspacePath(parent);
  if (parentValidation.valid) {
    res.setHeader('X-Prism-Tree-Parent', encodeURIComponent(parentValidation.resolvedPath || parent));
  }
}

/**
 * All project file + tree endpoints, moved verbatim from server/index.js.
 * Paths, methods, auth placement, status codes, and response shapes are
 * unchanged; the only behavioral additions are the symlink-safe realpath
 * containment inside validatePathInProject and the file-tree entry cap
 * (surfaced via the X-Prism-Truncated response header).
 *
 * The router carries FULL paths (it is mounted at the app root) so the
 * original route declaration order relative to other middleware could be
 * preserved exactly.
 */
export function createFilesRouter(dependencies: FilesRouterDependencies): Router {
  const { authenticateToken } = dependencies;
  const router = express.Router();

  // Browse filesystem endpoint for project suggestions - uses existing getFileTree
  router.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
      const dirPath = req.query.path as string | undefined;

      console.log('[API] Browse filesystem request for path:', dirPath);
      console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
      // Default to home directory if no path provided
      const defaultRoot = WORKSPACES_ROOT;
      let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

      // Resolve and normalize the path
      targetPath = path.resolve(targetPath);

      // Security check - ensure path is within allowed workspace root
      const validation = await validateWorkspacePath(targetPath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const resolvedPath = validation.resolvedPath || targetPath;

      // Security check - ensure path is accessible
      try {
        await fs.promises.access(resolvedPath);
        const stats = await fs.promises.stat(resolvedPath);

        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Path is not a directory' });
        }
      } catch {
        return res.status(404).json({ error: 'Directory not accessible' });
      }

      // Use existing getFileTree function with shallow depth (only direct children)
      const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

      // Filter only directories and format for suggestions
      const directories = fileTree
        .filter(item => item.type === 'directory')
        .map(item => ({
          path: item.path,
          name: item.name,
          type: 'directory'
        }))
        .sort((a, b) => {
          const aHidden = a.name.startsWith('.');
          const bHidden = b.name.startsWith('.');
          if (aHidden && !bHidden) return 1;
          if (!aHidden && bHidden) return -1;
          return a.name.localeCompare(b.name);
        });

      // Add common directories if browsing home directory
      const suggestions = [];
      let resolvedWorkspaceRoot = defaultRoot;
      try {
        resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
      } catch {
        // Use default root as-is if realpath fails
      }
      if (resolvedPath === resolvedWorkspaceRoot) {
        const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
        const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
        const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

        suggestions.push(...existingCommon, ...otherDirs);
      } else {
        suggestions.push(...directories);
      }

      res.json({
        path: resolvedPath,
        suggestions: suggestions
      });

    } catch (error) {
      console.error('Error browsing filesystem:', error);
      res.status(500).json({ error: 'Failed to browse filesystem' });
    }
  });

  router.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
      const { path: folderPath } = req.body;
      if (!folderPath) {
        return res.status(400).json({ error: 'Path is required' });
      }
      const expandedPath = expandWorkspacePath(folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await validateWorkspacePath(resolvedInput);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const targetPath = validation.resolvedPath || resolvedInput;
      const parentDir = path.dirname(targetPath);
      try {
        await fs.promises.access(parentDir);
      } catch {
        return res.status(404).json({ error: 'Parent directory does not exist' });
      }
      try {
        await fs.promises.access(targetPath);
        return res.status(409).json({ error: 'Folder already exists' });
      } catch {
        // Folder doesn't exist, which is what we want
      }
      try {
        await fs.promises.mkdir(targetPath, { recursive: false });
        res.json({ success: true, path: targetPath });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code === 'EEXIST') {
          return res.status(409).json({ error: 'Folder already exists' });
        }
        throw mkdirError;
      }
    } catch (error) {
      console.error('Error creating folder:', error);
      res.status(500).json({ error: 'Failed to create folder' });
    }
  });

  // Read file content endpoint
  router.get('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
      // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const projectId = req.params.projectId as string;
      const filePath = req.query.filePath as string | undefined;

      // Security: ensure the requested path is inside the project root
      if (!filePath) {
        return res.status(400).json({ error: 'Invalid file path' });
      }

      // Resolve the absolute project root via the DB-backed helper; the
      // caller passes the DB-assigned `projectId`, not a folder name.
      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
      if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Handle both absolute and relative paths (+ symlink-safe containment).
      const validation = await resolveReadablePath(projectRoot, filePath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const resolved = validation.resolved;

      const content = await fsPromises.readFile(resolved, 'utf8');
      // 带上 mtime 作保存冲突检测的基线(D1)。前端保存时回传,不一致就 409。
      let mtimeMs: number | null = null;
      try { mtimeMs = (await fsPromises.stat(resolved)).mtimeMs; } catch { /* 读得到内容通常也 stat 得到,取不到就置空、退化为不检测 */ }
      res.json({ content, path: resolved, mtimeMs });
    } catch (error) {
      console.error('Error reading file:', error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else if (code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  });

  // Serve raw file bytes for previews and downloads.
  router.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
      // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const projectId = req.params.projectId as string;
      const filePath = req.query.path as string | undefined;

      // Security: ensure the requested path is inside the project root
      if (!filePath) {
        return res.status(400).json({ error: 'Invalid file path' });
      }

      // Projects are now addressed by DB `projectId`, resolved to their path here.
      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
      if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Match the text reader endpoint so callers can pass either project-relative
      // or absolute paths without changing how the bytes are served.
      const validation = await resolveReadablePath(projectRoot, filePath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const resolved = validation.resolved;

      // Check if file exists
      try {
        await fsPromises.access(resolved);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }

      /**
       * 类型照实报,但**只有媒体类才允许 inline 呈现**,其余一律按附件下发。
       *
       * 加固之前这里是 `mime.lookup()` 直出、不带 Content-Disposition、也没有 CSP:
       * 项目里放一个 `evil.html`,这个路由就会把它以 `text/html` 内联渲染在应用
       * **同源**下。`nosniff` 挡不住 —— 类型是我们自己显式声明的。实测那份 HTML
       * 里的脚本确实执行了,并把 localStorage 里的整个 JWT 读了出来。
       *
       * 同仓的 assets 与 preview 两个模块早就为同一件事加过固(见
       * image-assets.service.ts 的注释、static-content.service.ts 的白名单 + CSP),
       * 只有这条没跟上。
       *
       * 应用内的调用方全部是 `authenticatedFetch` + blob(图片查看器、媒体预览、
       * 下载、打包 zip),fetch 根本不看 Content-Disposition,所以这里加了不影响
       * 任何现有功能 —— 变的只是"直接导航到这个 URL"时的行为:从渲染变成下载。
       */
      const mimeType = mime.lookup(resolved) || 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!isInlineSafeContentType(mimeType)) {
        res.setHeader('Content-Disposition', 'attachment');
      }

      // Stream the file
      const fileStream = fs.createReadStream(resolved);
      fileStream.pipe(res);

      fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error reading file' });
        }
      });

    } catch (error) {
      console.error('Error serving binary file:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  });

  // Save file content endpoint
  router.put('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
      // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const projectId = req.params.projectId as string;
      const { filePath, content, baseMtimeMs } = req.body;

      // Security: ensure the requested path is inside the project root
      if (!filePath) {
        return res.status(400).json({ error: 'Invalid file path' });
      }

      if (content === undefined) {
        return res.status(400).json({ error: 'Content is required' });
      }

      // Projects are now addressed by DB `projectId`, resolved to their path here.
      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
      if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Handle both absolute and relative paths (+ symlink-safe containment).
      const validation = await validatePathInProject(projectRoot, filePath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const resolved = validation.resolved;

      // 保存冲突检测(D1):前端加载时拿到的 mtime 作基线,保存时回传。若磁盘上的
      // 当前 mtime 与基线不符,说明这期间别人(Claude / 另一用户 / 外部编辑)改过 ——
      // 无条件 writeFile 就是"最后写入者赢"、悄悄覆盖别人的改动(多用户 IDE 高频
      // 事故)。回 409 让前端提示"磁盘已变化:重载 / 仍覆盖"。基线缺省(旧前端 / 新建
      // 文件)时退化为不检测,保持兼容。
      if (typeof baseMtimeMs === 'number') {
        try {
          const currentMtimeMs = (await fsPromises.stat(resolved)).mtimeMs;
          // 留 1ms 容差:某些文件系统 mtime 精度有限。
          if (Math.abs(currentMtimeMs - baseMtimeMs) > 1) {
            return res.status(409).json({
              error: '文件在你编辑期间被改动过,保存已中止以免覆盖。请重载后再改,或选择仍然覆盖。',
              code: 'FILE_MODIFIED',
              currentMtimeMs,
            });
          }
        } catch {
          // stat 失败(文件被删等):交给下面的 writeFile 处理/报错。
        }
      }

      // Write the new content
      await fsPromises.writeFile(resolved, content, 'utf8');
      let newMtimeMs: number | null = null;
      try { newMtimeMs = (await fsPromises.stat(resolved)).mtimeMs; } catch { /* 忽略 */ }

      res.json({
        success: true,
        path: resolved,
        mtimeMs: newMtimeMs,
        message: 'File saved successfully'
      });
    } catch (error) {
      console.error('Error saving file:', error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: 'File or directory not found' });
      } else if (code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  });

  router.get('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {
      // Resolve the project's absolute path through the DB (projectId is the
      // primary key of the `projects` table after the identifier migration).
      const actualPath = resolveVisibleProjectRoot(readRequestViewer(req), req.params.projectId as string);
      if (!actualPath) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Optional ?path= lets the tree walk out of the project directory, which
      // is the only way to reach a sibling folder or a file one level up.
      // WORKSPACES_ROOT bounds it — the same boundary /api/browse-filesystem
      // has always enumerated for this authenticated user, so navigating up
      // reveals no directory the client could not already list.
      const requestedPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
      let listedPath = actualPath;

      if (requestedPath) {
        const resolvedRequest = path.resolve(expandWorkspacePath(requestedPath));
        const validation = await validateWorkspacePath(resolvedRequest);
        if (!validation.valid) {
          return res.status(403).json({ error: validation.error });
        }
        listedPath = validation.resolvedPath || resolvedRequest;

        try {
          const stats = await fsPromises.stat(listedPath);
          if (!stats.isDirectory()) {
            return res.status(400).json({ error: 'Path is not a directory' });
          }
        } catch {
          return res.status(404).json({ error: 'Directory not accessible' });
        }
      } else {
        // Check if path exists
        try {
          await fsPromises.access(actualPath);
        } catch {
          return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }
      }

      // Bounded traversal: the frontend consumes this response as a bare
      // array (src/components/file-tree/hooks/useFileTreeData.ts), so the
      // truncation signal travels in a response header instead of a wrapper
      // object to stay backward-compatible.
      const budget: FileTreeBudget = { remaining: getFileTreeMaxEntries(), truncated: false };
      const files = await getFileTree(listedPath, 10, 0, true, budget);
      if (budget.truncated) {
        res.setHeader('X-Prism-Truncated', '1');
      }
      await setTreeLocationHeaders(res, listedPath, actualPath);
      res.json(files);
    } catch (error) {
      console.error('[ERROR] File tree error:', (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ==========================================================================
  // FILE OPERATIONS API ENDPOINTS
  // ==========================================================================

  // POST /api/projects/:projectId/files/create - Create new file or directory
  router.post('/api/projects/:projectId/files/create', authenticateToken, async (req, res) => {
    try {
      // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const projectId = req.params.projectId as string;
      const { path: parentPath, type, name } = req.body;

      // Validate input
      if (!name || !type) {
        return res.status(400).json({ error: 'Name and type are required' });
      }

      if (!['file', 'directory'].includes(type)) {
        return res.status(400).json({ error: 'Type must be "file" or "directory"' });
      }

      const nameValidation = validateFilename(name);
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }

      // Resolve the project directory through the DB using the new projectId.
      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
      if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Build and validate target path
      const targetDir = parentPath || '';
      const targetPath = targetDir ? path.join(targetDir, name) : name;
      const validation = await validatePathInProject(projectRoot, targetPath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }

      const resolvedPath = validation.resolved;

      // Check if already exists
      try {
        await fsPromises.access(resolvedPath);
        return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
      } catch {
        // Doesn't exist, which is what we want
      }

      // Create file or directory
      if (type === 'directory') {
        await fsPromises.mkdir(resolvedPath, { recursive: false });
      } else {
        // Ensure parent directory exists
        const parentDir = path.dirname(resolvedPath);
        try {
          await fsPromises.access(parentDir);
        } catch {
          await fsPromises.mkdir(parentDir, { recursive: true });
        }
        await fsPromises.writeFile(resolvedPath, '', 'utf8');
      }

      res.json({
        success: true,
        path: resolvedPath,
        name,
        type,
        message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
      });
    } catch (error) {
      console.error('Error creating file/directory:', error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
      } else if (code === 'ENOENT') {
        res.status(404).json({ error: 'Parent directory not found' });
      } else {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  });

  // PUT /api/projects/:projectId/files/rename - Rename file or directory
  router.put('/api/projects/:projectId/files/rename', authenticateToken, async (req, res) => {
    try {
      // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const projectId = req.params.projectId as string;
      const { oldPath, newName } = req.body;

      // Validate input
      if (!oldPath || !newName) {
        return res.status(400).json({ error: 'oldPath and newName are required' });
      }

      const nameValidation = validateFilename(newName);
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }

      // Resolve the project directory through the DB using the new projectId.
      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
      if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Validate old path
      const oldValidation = await validatePathInProject(projectRoot, oldPath);
      if (!oldValidation.valid) {
        return res.status(403).json({ error: oldValidation.error });
      }

      const resolvedOldPath = oldValidation.resolved;

      // Check if old path exists
      try {
        await fsPromises.access(resolvedOldPath);
      } catch {
        return res.status(404).json({ error: 'File or directory not found' });
      }

      // Build and validate new path
      const parentDir = path.dirname(resolvedOldPath);
      const resolvedNewPath = path.join(parentDir, newName);
      const newValidation = await validatePathInProject(projectRoot, resolvedNewPath);
      if (!newValidation.valid) {
        return res.status(403).json({ error: newValidation.error });
      }

      // Check if new path already exists
      try {
        await fsPromises.access(resolvedNewPath);
        return res.status(409).json({ error: 'A file or directory with this name already exists' });
      } catch {
        // Doesn't exist, which is what we want
      }

      // Rename
      await fsPromises.rename(resolvedOldPath, resolvedNewPath);

      res.json({
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName,
        message: 'Renamed successfully'
      });
    } catch (error) {
      console.error('Error renaming file/directory:', error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
      } else if (code === 'ENOENT') {
        res.status(404).json({ error: 'File or directory not found' });
      } else if (code === 'EXDEV') {
        res.status(400).json({ error: 'Cannot move across different filesystems' });
      } else {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  });

  // DELETE /api/projects/:projectId/files - Delete file or directory
  router.delete('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {
      // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const projectId = req.params.projectId as string;
      const { path: targetPath } = req.body;

      // Validate input
      if (!targetPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      // Resolve the project directory through the DB using the new projectId.
      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
      if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Validate path
      const validation = await validatePathInProject(projectRoot, targetPath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }

      const resolvedPath = validation.resolved;

      // Check if path exists and get stats
      let stats;
      try {
        stats = await fsPromises.stat(resolvedPath);
      } catch {
        return res.status(404).json({ error: 'File or directory not found' });
      }

      // Prevent deleting the project root itself
      if (resolvedPath === path.resolve(projectRoot)) {
        return res.status(403).json({ error: 'Cannot delete project root directory' });
      }

      // Delete based on type
      if (stats.isDirectory()) {
        await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        // 附件台账按绝对路径记账;删掉整个目录就把它名下所有附件行一并收走,
        // 否则用户手删了 attachments/ 里的东西,配额与设置页用量会一直挂着
        // 幽灵条目,直到 30 天 TTL 才消(forget() 此前是死代码,没有任何调用点)。
        attachmentsDb.forgetUnder(resolvedPath);
      } else {
        await fsPromises.unlink(resolvedPath);
        attachmentsDb.forget(resolvedPath);
      }

      res.json({
        success: true,
        path: resolvedPath,
        type: stats.isDirectory() ? 'directory' : 'file',
        message: 'Deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting file/directory:', error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
      } else if (code === 'ENOENT') {
        res.status(404).json({ error: 'File or directory not found' });
      } else if (code === 'ENOTEMPTY') {
        res.status(400).json({ error: 'Directory is not empty' });
      } else {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  });

  // POST /api/projects/:projectId/files/upload - Upload files
  const uploadFilesHandler: RequestHandler = (req, res) => {
    // Content-Length lets us refuse an oversized batch before multer opens a
    // single temp file. It counts multipart boundaries and part headers as well
    // as payload, so it slightly overstates the bytes that would land on disk —
    // that only ever biases toward rejecting a request already at the ceiling,
    // never toward accepting one past it.
    const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_UPLOAD_TOTAL_BYTES) {
      // The client is mid-transfer of a body we are about to stop reading.
      // Closing the connection is what actually stops it (the same thing a
      // reverse proxy does when it enforces its own body limit); without this
      // the socket sits half-consumed until a timeout fires.
      res.set('Connection', 'close');
      return res.status(413).json({ error: UPLOAD_TOTAL_EXCEEDED_MESSAGE });
    }

    const uploadMiddleware = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
          cb(null, os.tmpdir());
        },
        filename: (_req, _file, cb) => {
          // Use a unique temp name, but preserve original name in file.originalname
          // Note: file.originalname may contain path separators for folder uploads
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
          // For temp file, just use a safe unique name without the path
          cb(null, `upload-${uniqueSuffix}`);
        }
      }),
      limits: {
        fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
        files: MAX_FILE_UPLOAD_COUNT
      }
    });

    // Use multer middleware
    uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, async (err: unknown) => {
      if (err) {
        console.error('Multer error:', err);
        const errCode = (err as { code?: string }).code;
        if (errCode === 'LIMIT_FILE_SIZE') {
          // 413 rather than 400: the request is well-formed, it is the size that
          // is refused. Matches the aggregate check below and /api/documents/land
          // so a client never has to learn two status codes for one condition.
          return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_LABEL}.` });
        }
        if (errCode === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
        }
        return res.status(500).json({ error: (err as Error).message });
      }

      const uploadedRequestFiles = Array.isArray(req.files) ? req.files : [];

      // Second gate, for requests that arrive chunked and therefore carry no
      // Content-Length for the pre-check above to read. The bytes are already on
      // disk by the time we get here, so this cannot prevent the write — it
      // bounds how long they survive, and keeps the limit honest for clients
      // that stream. Both gates together mean the only way to exceed the cap on
      // disk is transiently, within a single chunked request.
      const totalUploadedBytes = uploadedRequestFiles.reduce((sum, file) => sum + (file.size || 0), 0);
      if (totalUploadedBytes > MAX_FILE_UPLOAD_TOTAL_BYTES) {
        await Promise.all(
          uploadedRequestFiles.map(file => fsPromises.unlink(file.path).catch(() => {})),
        );
        return res.status(413).json({ error: UPLOAD_TOTAL_EXCEEDED_MESSAGE });
      }

      try {
        // Named route params are always plain strings at runtime; the express
      // typings widen them to string | string[] (repeatable params).
      const projectId = req.params.projectId as string;
        const { targetPath, relativePaths, requestedFileCount: requestedFileCountRaw } = req.body;

        // Parse relative paths if provided (for folder uploads)
        let filePaths: string[] = [];
        if (relativePaths) {
          try {
            filePaths = JSON.parse(relativePaths);
          } catch {
            console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
          }
        }

        console.log('[DEBUG] File upload request:', {
          projectId,
          targetPath: JSON.stringify(targetPath),
          targetPathType: typeof targetPath,
          filesCount: uploadedRequestFiles.length,
          relativePaths: filePaths
        });

        if (uploadedRequestFiles.length === 0) {
          return res.status(400).json({ error: 'No files provided' });
        }

        const parsedRequestedFileCount = Number.parseInt(requestedFileCountRaw, 10);
        const requestedFileCount = Number.isFinite(parsedRequestedFileCount) && parsedRequestedFileCount > 0
          ? parsedRequestedFileCount
          : uploadedRequestFiles.length;

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
        if (!projectRoot) {
          return res.status(404).json({ error: 'Project not found' });
        }

        console.log('[DEBUG] Project root:', projectRoot);

        // Validate and resolve target path
        // If targetPath is empty or '.', use project root directly
        const targetDir = targetPath || '';
        let resolvedTargetDir;

        console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

        if (!targetDir || targetDir === '.' || targetDir === './') {
          // Empty path means upload to project root
          resolvedTargetDir = path.resolve(projectRoot);
          console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
        } else {
          const validation = await validatePathInProject(projectRoot, targetDir);
          if (!validation.valid) {
            console.log('[DEBUG] Path validation failed:', validation.error);
            return res.status(403).json({ error: validation.error });
          }
          resolvedTargetDir = validation.resolved;
          console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
        }

        // Ensure target directory exists
        try {
          await fsPromises.access(resolvedTargetDir);
        } catch {
          await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
        }

        // Move uploaded files from temp to target directory
        const uploadedFiles = [];
        console.log('[DEBUG] Processing files:', uploadedRequestFiles.map(f => ({ originalname: f.originalname, path: f.path })));
        for (let i = 0; i < uploadedRequestFiles.length; i++) {
          const file = uploadedRequestFiles[i];
          // Use relative path if provided (for folder uploads), otherwise use originalname
          const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
          console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
          const destPath = path.join(resolvedTargetDir, fileName);

          // Validate destination path
          const destValidation = await validatePathInProject(projectRoot, destPath);
          if (!destValidation.valid) {
            console.log('[DEBUG] Destination validation failed for:', destPath);
            // Clean up temp file
            await fsPromises.unlink(file.path).catch(() => {});
            continue;
          }

          // Ensure parent directory exists (for nested files from folder upload)
          const parentDir = path.dirname(destPath);
          try {
            await fsPromises.access(parentDir);
          } catch {
            await fsPromises.mkdir(parentDir, { recursive: true });
          }

          // Move file (copy + unlink to handle cross-device scenarios)
          await fsPromises.copyFile(file.path, destPath);
          await fsPromises.unlink(file.path);

          uploadedFiles.push({
            name: fileName,
            path: destPath,
            size: file.size,
            mimeType: file.mimetype
          });
        }

        res.json({
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount,
          targetPath: resolvedTargetDir,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
        });
      } catch (error) {
        console.error('Error uploading files:', error);
        // Clean up any remaining temp files
        for (const file of uploadedRequestFiles) {
          await fsPromises.unlink(file.path).catch(() => {});
        }
        if ((error as NodeJS.ErrnoException).code === 'EACCES') {
          res.status(403).json({ error: 'Permission denied' });
        } else {
          res.status(500).json({ error: (error as Error).message });
        }
      }
    });
  };

  /**
   * F10:跨文件全局搜索(内容,不是文件名)。
   *
   * 搜索根**必须**是调用者可见的项目目录 —— `resolveVisibleProjectRoot` 同时做
   * 归属校验与路径解析,拿不到就是 404(与"项目不存在"同形,不做存在性预言机)。
   */
  router.get('/api/projects/:projectId/search', authenticateToken, async (req, res) => {
    const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), req.params.projectId);
    if (!projectRoot) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (!query.trim()) {
      return res.status(400).json({ error: '搜索内容不能为空' });
    }
    // 单字符搜索几乎必然命中上限然后被截断 —— 与其给一屏噪音,不如直说。
    if (query.trim().length < 2) {
      return res.status(400).json({ error: '搜索内容至少 2 个字符' });
    }

    const result = await searchProjectFiles(projectRoot, query, {
      caseSensitive: req.query.caseSensitive === 'true',
      regex: req.query.regex === 'true',
      wholeWord: req.query.wholeWord === 'true',
      glob: typeof req.query.glob === 'string' && req.query.glob.trim() ? req.query.glob.trim() : undefined,
    });

    res.json({
      query,
      matches: result.matches,
      truncated: result.truncated,
      error: result.error,
    });
  });

  // 前端据此决定"多大才分片"以及每片多大。硬编码在前端的副本会随部署漂移。
  router.get('/api/projects/:projectId/files/upload/limits', authenticateToken, (_req, res) => {
    res.json({
      chunkBytes: UPLOAD_CHUNK_BYTES,
      chunkMb: UPLOAD_CHUNK_MB,
      maxFileBytes: MAX_FILE_UPLOAD_SIZE_BYTES,
      maxTotalBytes: MAX_FILE_UPLOAD_TOTAL_BYTES,
    });
  });

  /** 取出并校验会话;失败时已写完响应,调用方直接返回。 */
  const takeChunkSession = (req: express.Request, res: express.Response) => {
    const uploadId = (req.body?.uploadId ?? req.query?.uploadId) as unknown;
    if (!isValidUploadId(uploadId)) {
      res.status(400).json({ error: 'Invalid uploadId' });
      return null;
    }
    const session = uploadChunkSessions.get(uploadId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired. Please retry the upload.' });
      return null;
    }
    // 会话与项目绑定:换个 projectId 拿同一个 uploadId 收尾,等于把文件写到别的项目里。
    if (session.projectId !== req.params.projectId) {
      res.status(403).json({ error: 'Upload session belongs to another project' });
      return null;
    }
    return { uploadId, session };
  };

  // 第一步:换 uploadId,建 .part 占位。
  router.post('/api/projects/:projectId/files/upload/start', authenticateToken, async (req, res) => {
    try {
      const declaredSize = Number(req.body?.size);
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        return res.status(400).json({ error: 'size is required' });
      }
      if (declaredSize > MAX_FILE_UPLOAD_SIZE_BYTES) {
        return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_LABEL}.` });
      }
      const projectId = req.params.projectId as string;
      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), projectId);
      if (!projectRoot) return res.status(404).json({ error: 'Project not found' });

      // 目标目录在 start 就校验一次:让越权路径在传字节之前失败,而不是传完 1GB 才被拒。
      const targetPath = typeof req.body?.targetPath === 'string' ? req.body.targetPath : '';
      if (targetPath && targetPath !== '.' && targetPath !== './') {
        const validation = await validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) return res.status(403).json({ error: validation.error });
      }

      const uploadId = crypto.randomBytes(16).toString('hex');
      const partPath = path.join(os.tmpdir(), `chunkasm-${uploadId}.part`);
      await fsPromises.writeFile(partPath, '');   // 占位,后续一律追加
      uploadChunkSessions.set(uploadId, {
        name: typeof req.body?.name === 'string' && req.body.name ? req.body.name : 'upload',
        relativePath: typeof req.body?.relativePath === 'string' ? req.body.relativePath : '',
        targetPath,
        projectId,
        partPath,
        received: 0,
        declaredSize,
        nextIndex: 0,
        updatedAt: Date.now(),
      });
      res.json({ uploadId, chunkBytes: UPLOAD_CHUNK_BYTES });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // 第二步:逐片追加。必须按序 —— 乱序拼出来的文件是坏的,而且坏得很安静。
  router.post('/api/projects/:projectId/files/upload/chunk', authenticateToken, (req, res) => {
    chunkUploadMiddleware.single('chunk')(req, res, async (uploadError: unknown) => {
      const discardTempFile = () => {
        const tempPath = (req.file as Express.Multer.File | undefined)?.path;
        if (tempPath) fsPromises.unlink(tempPath).catch(() => {});
      };

      if (uploadError) {
        discardTempFile();
        if ((uploadError as { code?: string }).code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `Chunk too large. Maximum chunk size is ${UPLOAD_CHUNK_MB}MB.` });
        }
        return res.status(500).json({ error: (uploadError as Error).message || 'Chunk upload failed' });
      }

      const found = takeChunkSession(req, res);
      if (!found) { discardTempFile(); return; }
      const { uploadId, session } = found;
      if (!req.file) return res.status(400).json({ error: 'No chunk uploaded' });

      const index = Number(req.body?.index);
      if (!Number.isInteger(index) || index < 0) {
        discardTempFile();
        return res.status(400).json({ error: 'index must be a non-negative integer' });
      }
      // 已收过的分片重复到达(客户端重试时很常见):幂等地当成功,不重复追加。
      if (index < session.nextIndex) {
        discardTempFile();
        return res.json({ received: session.received, nextIndex: session.nextIndex });
      }
      if (index !== session.nextIndex) {
        discardTempFile();
        return res.status(409).json({ error: `Out-of-order chunk: expected ${session.nextIndex}, got ${index}` });
      }
      // 上限在服务端累加校验 —— 客户端声明的 size 只是提示,不能当约束。
      const chunkSize = req.file.size || 0;
      if (session.received + chunkSize > MAX_FILE_UPLOAD_SIZE_BYTES) {
        discardTempFile();
        dropUploadChunkSession(uploadId);
        return res.status(413).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_LABEL}.` });
      }

      try {
        await appendChunkFile(session.partPath, req.file.path);
        session.received += chunkSize;
        session.nextIndex = index + 1;
        session.updatedAt = Date.now();
        res.json({ received: session.received, nextIndex: session.nextIndex });
      } catch (error) {
        dropUploadChunkSession(uploadId);
        res.status(500).json({ error: (error as Error).message });
      } finally {
        discardTempFile();
      }
    });
  });

  // 第三步:收尾。目标路径解析与校验和批量上传逐条对齐,写入结果结构也一致。
  router.post('/api/projects/:projectId/files/upload/complete', authenticateToken, async (req, res) => {
    const found = takeChunkSession(req, res);
    if (!found) return;
    const { uploadId, session } = found;
    try {
      if (session.received === 0) {
        dropUploadChunkSession(uploadId);
        return res.status(400).json({ error: 'No chunks received' });
      }
      // 声明大小与实收不符 = 中途掉了片。宁可整单作废,也不把残缺文件写进项目目录 ——
      // 半截文件不会报错,只会在后面被当成完整的用。
      if (session.declaredSize && session.received !== session.declaredSize) {
        dropUploadChunkSession(uploadId);
        return res.status(400).json({
          error: `Incomplete upload: expected ${session.declaredSize} bytes, received ${session.received}.`,
        });
      }

      const projectRoot = resolveVisibleProjectRoot(readRequestViewer(req), session.projectId);
      if (!projectRoot) {
        dropUploadChunkSession(uploadId);
        return res.status(404).json({ error: 'Project not found' });
      }

      const targetDir = session.targetPath || '';
      let resolvedTargetDir: string;
      if (!targetDir || targetDir === '.' || targetDir === './') {
        resolvedTargetDir = path.resolve(projectRoot);
      } else {
        const validation = await validatePathInProject(projectRoot, targetDir);
        if (!validation.valid) {
          dropUploadChunkSession(uploadId);
          return res.status(403).json({ error: validation.error });
        }
        resolvedTargetDir = validation.resolved as string;
      }
      await fsPromises.mkdir(resolvedTargetDir, { recursive: true });

      const fileName = session.relativePath || session.name;
      const destPath = path.join(resolvedTargetDir, fileName);
      const destValidation = await validatePathInProject(projectRoot, destPath);
      if (!destValidation.valid) {
        dropUploadChunkSession(uploadId);
        return res.status(403).json({ error: destValidation.error });
      }
      await fsPromises.mkdir(path.dirname(destPath), { recursive: true });

      // copy + unlink:分片是攒在 os.tmpdir() 的,与项目目录很可能不在同一设备上。
      await fsPromises.copyFile(session.partPath, destPath);
      await fsPromises.unlink(session.partPath).catch(() => {});
      uploadChunkSessions.delete(uploadId);

      res.json({
        success: true,
        files: [{ name: fileName, path: destPath, size: session.received, mimeType: mime.lookup(fileName) || 'application/octet-stream' }],
        uploadedCount: 1,
        requestedFileCount: 1,
        targetPath: resolvedTargetDir,
        message: `Uploaded ${fileName} successfully`,
      });
    } catch (error) {
      dropUploadChunkSession(uploadId);
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        res.status(403).json({ error: 'Permission denied' });
      } else {
        res.status(500).json({ error: (error as Error).message });
      }
    }
  });

  // 客户端放弃时主动收尸:没有这条,失败会话的 .part 要挂到 TTL 到期才被清扫走。
  router.post('/api/projects/:projectId/files/upload/abort', authenticateToken, (req, res) => {
    const found = takeChunkSession(req, res);
    if (!found) return;
    dropUploadChunkSession(found.uploadId);
    res.json({ aborted: true });
  });

  router.post('/api/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

  return router;
}
