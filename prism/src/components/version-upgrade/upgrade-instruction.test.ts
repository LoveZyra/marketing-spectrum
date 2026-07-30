import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import { upgradeInstruction } from './upgrade-instruction';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('what to tell the user about upgrading', () => {
  test('a git checkout gets a command that updates a git checkout', () => {
    const { command, canSelfUpdate } = upgradeInstruction('git', false);

    assert.equal(command, 'git checkout main && git pull && npm install');
    assert.equal(canSelfUpdate, true);
  });

  test('the platform build gets its own update script', () => {
    const { command, canSelfUpdate } = upgradeInstruction('git', true);

    assert.equal(command, 'npm run update:platform');
    assert.equal(canSelfUpdate, true);
  });

  /**
   * `installMode` is `npm` whenever the app root has no `.git` — a downloaded
   * archive, say. Prism is not published to a registry, so there is no command
   * that upgrades that copy in place, and the honest answer is to offer none.
   *
   * What was offered before was `npm install -g @cloudcli-ai/cloudcli@latest`,
   * which installs the upstream project this one was forked from. It looks like
   * it works.
   */
  test('an install with no git checkout is offered no command at all', () => {
    const { command, canSelfUpdate } = upgradeInstruction('npm', false);

    assert.equal(command, null);
    assert.equal(canSelfUpdate, false);
  });

  test('no command names a package this project does not publish', () => {
    for (const isPlatform of [true, false]) {
      for (const mode of ['git', 'npm'] as const) {
        const { command } = upgradeInstruction(mode, isPlatform);

        assert.ok(
          command === null || !/npm\s+install\s+-g/.test(command),
          `${mode}/${isPlatform} offers a global install: ${command}`,
        );
      }
    }
  });

  /**
   * The button and the endpoint have to agree. `POST /api/system/update`
   * refuses unless the install is the platform build or a git checkout; a
   * button shown outside that set can only ever produce an error.
   *
   * Asserted against the server source rather than a copy of the rule, so
   * loosening the endpoint without revisiting the button fails here.
   */
  test('Update Now is offered exactly where the endpoint accepts it', () => {
    const routes = fs.readFileSync(
      path.join(repoRoot, 'server/modules/system/system.routes.ts'),
      'utf8',
    );

    assert.ok(
      routes.includes("if (!isPlatform && installMode !== 'git')"),
      'the update endpoint no longer guards on isPlatform/installMode; re-derive canSelfUpdate from its new rule',
    );

    for (const isPlatform of [true, false]) {
      for (const mode of ['git', 'npm'] as const) {
        const endpointAccepts = isPlatform || mode === 'git';

        assert.equal(
          upgradeInstruction(mode, isPlatform).canSelfUpdate,
          endpointAccepts,
          `${mode}/${isPlatform}: button and endpoint disagree`,
        );
      }
    }
  });
});
