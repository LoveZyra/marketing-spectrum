import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, test } from 'vitest';

/**
 * The file tree can now walk out of the project directory (the ?path= parameter
 * on GET /api/projects/:projectId/files). These tests pin where that walk has
 * to stop.
 *
 * Two boundaries, deliberately different:
 *
 *   LISTING is bounded by WORKSPACES_ROOT — validateWorkspacePath. Widening it
 *   this far exposes nothing new, because /api/browse-filesystem already
 *   enumerates the same root for the same authenticated user. Anything above
 *   it, and every system directory, must be refused.
 *
 *   READING file content stays bounded by the project root —
 *   validatePathInProject — unless an operator opts in with
 *   PRISM_FILETREE_ALLOW_EXTERNAL_READ. The server listens on 0.0.0.0 in this
 *   deployment, so a leaked token must not turn the file endpoints into a
 *   reader for ~/.ssh; being able to *see* a filename up there is not
 *   permission to stream its bytes.
 *
 * WORKSPACES_ROOT is captured at module load, so the fixture root is planted in
 * the environment before the first import and the modules are pulled in
 * dynamically.
 */

/**
 * Somewhere the validator has no pre-existing opinion about.
 *
 * Both `/tmp` and `/root` are on FORBIDDEN_WORKSPACE_PATHS, so a fixture in
 * either (os.tmpdir() and os.homedir() respectively, when the tests run as root
 * in a container) would be refused for that reason and prove nothing about the
 * boundary under test. `/var/tmp` is carved out of that list explicitly;
 * elsewhere — Windows, and macOS with its /var/folders tmpdir — os.tmpdir() is
 * already fine.
 */
function fixtureBase(): string {
  const tmp = path.resolve(os.tmpdir());
  return process.platform !== 'win32' && tmp === '/tmp' ? '/var/tmp' : tmp;
}

let workspaceRoot: string;
let outsideRoot: string;
let projectRoot: string;
let siblingDir: string;

let validateWorkspacePath: typeof import('@/shared/utils.js').validateWorkspacePath;
let validatePathInProject: typeof import('@/modules/files/services/path-validation.service.js').validatePathInProject;
let resolveReadablePath: typeof import('@/modules/files/services/path-validation.service.js').resolveReadablePath;

beforeAll(async () => {
  const base = fixtureBase();
  workspaceRoot = await realpath(await mkdtemp(path.join(base, 'prism-tree-root-')));
  outsideRoot = await realpath(await mkdtemp(path.join(base, 'prism-tree-outside-')));

  projectRoot = path.join(workspaceRoot, 'project');
  siblingDir = path.join(workspaceRoot, 'sibling');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'index.ts'), 'export {};\n');
  await writeFile(path.join(siblingDir, 'notes.txt'), 'sibling\n');
  await writeFile(path.join(outsideRoot, 'id_rsa'), 'PRIVATE\n');
  await symlink(outsideRoot, path.join(workspaceRoot, 'escape-hatch'), 'dir');

  process.env.WORKSPACES_ROOT = workspaceRoot;
  const utils = await import('@/shared/utils.js');
  const service = await import('@/modules/files/services/path-validation.service.js');
  validateWorkspacePath = utils.validateWorkspacePath;
  validatePathInProject = service.validatePathInProject;
  resolveReadablePath = service.resolveReadablePath;

  assert.equal(utils.WORKSPACES_ROOT, workspaceRoot, 'fixture root did not take effect');
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

describe('tree navigation boundary (?path=)', () => {
  test('lists the project directory itself', async () => {
    const result = await validateWorkspacePath(projectRoot);
    assert.equal(result.valid, true);
    assert.equal(result.resolvedPath, projectRoot);
  });

  test('lists the directory above the project — this is the feature', async () => {
    const result = await validateWorkspacePath(path.dirname(projectRoot));
    assert.equal(result.valid, true);
    assert.equal(result.resolvedPath, workspaceRoot);
  });

  test('lists a sibling of the project', async () => {
    const result = await validateWorkspacePath(siblingDir);
    assert.equal(result.valid, true);
  });

  test('refuses the directory above WORKSPACES_ROOT', async () => {
    const result = await validateWorkspacePath(path.dirname(workspaceRoot));
    assert.equal(result.valid, false);
    // Either refusal is correct — containment, or the system-directory list if
    // the fixture's parent happens to be on it.
    assert.match(String(result.error), /workspace root|system director/i);
  });

  test('refuses a ".." climb dressed up as a path under the project', async () => {
    const traversal = path.join(projectRoot, '..', '..', path.basename(outsideRoot));
    const result = await validateWorkspacePath(traversal);
    assert.equal(result.valid, false);
  });

  test('refuses system directories outright', async () => {
    for (const systemPath of ['/etc', '/etc/ssh', '/root', '/']) {
      const result = await validateWorkspacePath(systemPath);
      assert.equal(result.valid, false, `${systemPath} must not be listable`);
    }
  });

  test('refuses a symlink inside the root that points outside it', async () => {
    // Without the realpath check this reads as "under WORKSPACES_ROOT" purely
    // because of where the link file sits.
    const result = await validateWorkspacePath(path.join(workspaceRoot, 'escape-hatch'));
    assert.equal(result.valid, false);
  });

  test('resolves an accepted path so the client is told where it actually landed', async () => {
    // The header the tree reads (X-Prism-Tree-Root) carries this value, which
    // is why "up" from a symlinked directory goes somewhere sensible.
    const result = await validateWorkspacePath(path.join(projectRoot, '..', 'sibling'));
    assert.equal(result.valid, true);
    assert.equal(result.resolvedPath, siblingDir);
  });
});

describe('content reads stay project-scoped by default', () => {
  const inProjectFile = () => path.join(projectRoot, 'src', 'index.ts');
  const outOfProjectFile = () => path.join(siblingDir, 'notes.txt');

  test('a file inside the project is readable in either mode', async () => {
    for (const allowExternal of [false, true]) {
      const result = await resolveReadablePath(projectRoot, inProjectFile(), allowExternal);
      assert.equal(result.valid, true);
      assert.equal(result.resolved, inProjectFile());
    }
  });

  test('a file the tree can list but the project does not own is refused by default', async () => {
    const result = await resolveReadablePath(projectRoot, outOfProjectFile(), false);
    assert.equal(result.valid, false);
    // Frozen string: the routes turn this into the 403 the frontend matches on.
    assert.equal(result.error, 'Path must be under project root');
  });

  test('the operator opt-in widens reads to the same root the tree navigates', async () => {
    const result = await resolveReadablePath(projectRoot, outOfProjectFile(), true);
    assert.equal(result.valid, true);
    assert.equal(result.resolved, outOfProjectFile());
  });

  test('the opt-in does not widen past WORKSPACES_ROOT', async () => {
    const result = await resolveReadablePath(projectRoot, path.join(outsideRoot, 'id_rsa'), true);
    assert.equal(result.valid, false);
    // Reported as the project-scoped refusal: the wider boundary is an operator
    // setting the client knows nothing about.
    assert.equal(result.error, 'Path must be under project root');
  });

  test('the opt-in does not widen to system files', async () => {
    for (const systemPath of ['/etc/passwd', '/root/.ssh/id_rsa']) {
      const result = await resolveReadablePath(projectRoot, systemPath, true);
      assert.equal(result.valid, false, `${systemPath} must not be readable`);
    }
  });

  test('relative paths are never reinterpreted against the wider root', async () => {
    // A relative path is resolved against the project root by definition, so
    // "../sibling/notes.txt" is a traversal attempt, not a request for a
    // directory the tree happens to be showing.
    const result = await resolveReadablePath(projectRoot, '../sibling/notes.txt', true);
    assert.equal(result.valid, false);
    assert.equal(result.error, 'Path must be under project root');
  });

  test('writes are never widened — validatePathInProject knows only the project', async () => {
    const result = await validatePathInProject(projectRoot, outOfProjectFile());
    assert.equal(result.valid, false);
    assert.equal(result.error, 'Path must be under project root');
  });
});
