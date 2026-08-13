import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import { upgradeInstruction } from './upgrade-instruction';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('what to tell the user about upgrading', () => {
  test('the only install mode is a tar package, and it gets the tar command', () => {
    const { command } = upgradeInstruction();

    assert.equal(command, 'tar -xzf prism-<version>.tar.gz && npm ci && npm run build');
  });

  /**
   * What was offered before, for installs with no `.git`, was
   * `npm install -g @cloudcli-ai/cloudcli@latest` — that installs the upstream
   * project this one was forked from, over the top of this one. It looks like
   * it works.
   */
  test('the command names no package this project does not publish', () => {
    const { command } = upgradeInstruction();

    assert.ok(!/npm\s+install\s+-g/.test(command), `offers a global install: ${command}`);
  });

  /**
   * The button and the endpoint have to agree. There is no longer a self-update
   * endpoint, so there must be no self-update button; asserted against the
   * server source rather than a copy of the rule, so re-adding the endpoint
   * without revisiting the button fails here.
   */
  test('no self-update endpoint exists to put a button in front of', () => {
    const routes = fs.readFileSync(
      path.join(repoRoot, 'server/modules/system/system.routes.ts'),
      'utf8',
    );

    assert.ok(
      !routes.includes('/api/system/update'),
      'the self-update endpoint is back; VersionUpgradeModal needs its Update Now button again',
    );

    const modal = fs.readFileSync(
      path.join(repoRoot, 'src/components/version-upgrade/view/VersionUpgradeModal.tsx'),
      'utf8',
    );

    assert.ok(
      !modal.includes('/api/system/update'),
      'the modal calls an endpoint the server no longer mounts',
    );
  });
});
