import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { validateWorkspacePath } from '@/shared/utils.js';

/**
 * Result shape shared by the project-path validators. `resolved` is the
 * lexically resolved absolute path (NOT the realpath) so that success
 * responses keep returning exactly the same path strings as before the
 * symlink hardening was added.
 */
export type ProjectPathValidation =
  | { valid: true; resolved: string }
  | { valid: false; resolved?: undefined; error: string };

/**
 * Rejection message used by every containment failure. The exact text (and
 * the 403 status the routes attach to it) predates this module and is part of
 * the frontend contract — do not reword it.
 */
const CONTAINMENT_ERROR = 'Path must be under project root';

/**
 * Lexical containment check — same algorithm the old inline validators used:
 * resolve relative paths against the project root and require the result to
 * start with `<root><sep>`.
 */
function resolveLexicalPathInProject(projectRoot: string, targetPath: string): ProjectPathValidation {
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedRoot = path.resolve(projectRoot) + path.sep;
  if (!resolved.startsWith(normalizedRoot)) {
    return { valid: false, error: CONTAINMENT_ERROR };
  }
  return { valid: true, resolved };
}

/**
 * Resolves the realpath of `targetPath`, tolerating paths that do not exist
 * yet (creates/uploads): walk up to the nearest existing ancestor, resolve
 * that, then re-append the not-yet-existing suffix. For an existing file this
 * is exactly `realpath(target)`; for a pending create it is
 * `realpath(parentDir) + basename` (recursively, so `mkdir -p`-style nested
 * creates are covered too).
 */
async function realpathAllowingMissingLeaf(targetPath: string): Promise<string> {
  let current = targetPath;
  const suffix: string[] = [];

  for (;;) {
    try {
      const real = await fsPromises.realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        throw error;
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Symlink-safe validation that a path stays inside the project root.
 *
 * Mirrors the stricter `validateWorkspacePath` from `@/shared/utils.js`, but
 * scoped to a project root and returning the legacy `{ valid, resolved,
 * error }` shape the file routes were built around:
 *
 * 1. lexical containment (identical to the previous behavior), then
 * 2. `fs.realpath` containment of the FINAL target — for existing files the
 *    realpath of the file itself, for pending creates the realpath of the
 *    nearest existing ancestor plus the remaining segments — against
 *    `realpath(projectRoot)`.
 *
 * Rejections reuse the exact legacy message so the routes keep answering
 * 403 "Path must be under project root" and the frontend contract holds.
 *
 * If the filesystem itself cannot resolve realpaths (project root vanished
 * mid-request, permission failure, …) the lexical result is returned and the
 * subsequent fs operation surfaces the same ENOENT/EACCES error codes it
 * always did — this keeps non-symlink error behavior byte-identical.
 */
export async function validatePathInProject(
  projectRoot: string,
  targetPath: string,
): Promise<ProjectPathValidation> {
  const lexical = resolveLexicalPathInProject(projectRoot, targetPath);
  if (!lexical.valid) {
    return lexical;
  }

  try {
    const rootReal = await fsPromises.realpath(path.resolve(projectRoot));
    const targetReal = await realpathAllowingMissingLeaf(lexical.resolved);
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
      return { valid: false, error: CONTAINMENT_ERROR };
    }
  } catch {
    // Realpath resolution itself failed (not a containment violation). Fall
    // back to the lexical result; the actual fs call will report the same
    // error it did before this hardening existed.
  }

  return lexical;
}

/**
 * Resolve a path the client asked to READ.
 *
 * Listing a directory and reading the bytes inside it are separate permissions
 * in Prism. The file tree may navigate up to WORKSPACES_ROOT (nothing
 * /api/browse-filesystem did not already enumerate for the same authenticated
 * user), but streaming file content from up there is a wider grant, so it is
 * off unless an operator sets PRISM_FILETREE_ALLOW_EXTERNAL_READ — `allowExternal`
 * here is that setting, passed in rather than read from the environment so the
 * decision can be exercised in both states.
 *
 * Project containment is tried first and its verdict is what callers get in
 * every case that matters: when the path is inside the project it wins, and
 * when it is outside and external reads are disabled its rejection (the frozen
 * 403 "Path must be under project root") is returned unchanged. The
 * WORKSPACES_ROOT fallback only runs when an operator has opted in, and only
 * for absolute paths — a relative path is resolved against the project root by
 * definition, so re-checking it against a wider root would just re-ask the
 * question that was already answered.
 *
 * Writes, renames, deletes and uploads never come through here: they call
 * validatePathInProject directly and stay project-scoped in both modes.
 */
export async function resolveReadablePath(
  projectRoot: string,
  filePath: string,
  allowExternal: boolean,
): Promise<ProjectPathValidation> {
  const inProject = await validatePathInProject(projectRoot, filePath);
  if (inProject.valid || !allowExternal || !path.isAbsolute(filePath)) {
    return inProject;
  }

  const absolute = path.resolve(filePath);
  const workspace = await validateWorkspacePath(absolute);
  if (!workspace.valid) {
    // Report the project-scoped rejection rather than the workspace one: the
    // client's contract is with the project boundary, and the wider boundary
    // is an operator setting the client knows nothing about.
    return inProject;
  }
  return { valid: true, resolved: workspace.resolvedPath || absolute };
}

/**
 * Validate filename - check for invalid characters. (Moved verbatim from
 * server/index.js; also duplicated historically in routes/git.js.)
 */
export function validateFilename(name: string): { valid: boolean; error?: string } {
  if (!name || !name.trim()) {
    return { valid: false, error: 'Filename cannot be empty' };
  }
  // Check for invalid characters (Windows + Unix)
  const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
  if (invalidChars.test(name)) {
    return { valid: false, error: 'Filename contains invalid characters' };
  }
  // Check for reserved names (Windows)
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reserved.test(name)) {
    return { valid: false, error: 'Filename is a reserved name' };
  }
  // Check for dots only
  if (/^\.+$/.test(name)) {
    return { valid: false, error: 'Filename cannot be only dots' };
  }
  return { valid: true };
}
