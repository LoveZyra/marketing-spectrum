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
export async function realpathAllowingMissingLeaf(targetPath: string): Promise<string> {
  let current = targetPath;
  const suffix: string[] = [];
  let hops = 0;

  for (;;) {
    try {
      const real = await fsPromises.realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }

      /**
       * 悬空软链不能当「还不存在的路径」处理。
       *
       * `proj/evil.txt -> /项目外/pwned.txt` 的目标不存在时 realpath 报 ENOENT;若退到父目录
       * `proj/` 去判断就会放行,而随后的 writeFile 会跟着软链在项目外建出文件。软链可以来自
       * git clone 的仓库,也可以是 agent 建的。所以这一段本身是软链时,读出它的目标、按指向的
       * 位置接着往下解析:指向项目内的悬空软链照常可写,指向项目外的会在最后的包含判断里被拒。
       */
      let linkTarget: string | null = null;
      try {
        const stat = await fsPromises.lstat(current);
        if (stat.isSymbolicLink()) linkTarget = await fsPromises.readlink(current);
      } catch {
        linkTarget = null;
      }
      if (linkTarget !== null) {
        hops += 1;
        if (hops > 40) {
          throw Object.assign(new Error('Too many symbolic links'), { code: 'ELOOP' });
        }
        // 相对软链按真实父目录解析,不是字面父目录 —— 父路径里本身有软链时两者不同
        // (`deep/sub -> s`,`s/evil -> ../../outside/x`:按字面算会以为还在项目里)。
        // 父目录这一段本身也可能是悬空的,所以递归调本函数。
        const realParent = path.isAbsolute(linkTarget)
          ? ''
          : await realpathAllowingMissingLeaf(path.dirname(current));
        current = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(realParent, linkTarget);
        continue;
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
  } catch (error) {
    // 软链环(或刻意造的超长软链链)不是「文件系统解析不了」,是可疑输入,拒绝。
    if ((error as NodeJS.ErrnoException)?.code === 'ELOOP') {
      return { valid: false, error: CONTAINMENT_ERROR };
    }
    // Realpath resolution itself failed (not a containment violation). Fall
    // back to the lexical result; the actual fs call will report the same
    // error it did before this hardening existed.
  }

  return lexical;
}

/**
 * 校验一个目录项本身(删除、改名的源路径),不跟随最后一段软链。
 *
 * 删除 / 改名作用在软链这个目录项上,不是它指向的东西:`rm link` 删的是链接,`rename link`
 * 挪的是链接。按目标判的话,指向项目外的软链(git 仓库里常见的绝对路径软链)和软链环
 * 就既删不掉也改不了名。所以这里只要求:词法上在项目里,且父目录的真实路径在项目里。
 */
export async function validateEntryInProject(
  projectRoot: string,
  targetPath: string,
): Promise<ProjectPathValidation> {
  const lexical = resolveLexicalPathInProject(projectRoot, targetPath);
  if (!lexical.valid) {
    return lexical;
  }
  try {
    const rootReal = await fsPromises.realpath(path.resolve(projectRoot));
    const parentReal = await realpathAllowingMissingLeaf(path.dirname(lexical.resolved));
    const entryReal = path.join(parentReal, path.basename(lexical.resolved));
    if (entryReal !== rootReal && !entryReal.startsWith(rootReal + path.sep)) {
      return { valid: false, error: CONTAINMENT_ERROR };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ELOOP') {
      return { valid: false, error: CONTAINMENT_ERROR };
    }
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
