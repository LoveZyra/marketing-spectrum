import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express, { type RequestHandler, type Router } from 'express';
import mime from 'mime-types';
import multer from 'multer';

import { projectsDb } from '@/modules/database/index.js';
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
      const projectRoot = await projectsDb.getProjectPathById(projectId);
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
      res.json({ content, path: resolved });
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
      const projectRoot = await projectsDb.getProjectPathById(projectId);
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

      // Get file extension and set appropriate content type
      const mimeType = mime.lookup(resolved) || 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);

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
      const { filePath, content } = req.body;

      // Security: ensure the requested path is inside the project root
      if (!filePath) {
        return res.status(400).json({ error: 'Invalid file path' });
      }

      if (content === undefined) {
        return res.status(400).json({ error: 'Content is required' });
      }

      // Projects are now addressed by DB `projectId`, resolved to their path here.
      const projectRoot = await projectsDb.getProjectPathById(projectId);
      if (!projectRoot) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Handle both absolute and relative paths (+ symlink-safe containment).
      const validation = await validatePathInProject(projectRoot, filePath);
      if (!validation.valid) {
        return res.status(403).json({ error: validation.error });
      }
      const resolved = validation.resolved;

      // Write the new content
      await fsPromises.writeFile(resolved, content, 'utf8');

      res.json({
        success: true,
        path: resolved,
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
      const actualPath = await projectsDb.getProjectPathById(req.params.projectId as string);
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
      const projectRoot = await projectsDb.getProjectPathById(projectId);
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
      const projectRoot = await projectsDb.getProjectPathById(projectId);
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
      const projectRoot = await projectsDb.getProjectPathById(projectId);
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
      } else {
        await fsPromises.unlink(resolvedPath);
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
        const projectRoot = await projectsDb.getProjectPathById(projectId);
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

  router.post('/api/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

  return router;
}
