import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test } from 'vitest';

import {
  LEGACY_MANAGED_MCP_SERVER_NAMES,
  MANAGED_MCP_SERVER_NAME,
  isManagedMcpServerName,
} from './managedMcpServers.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('managed MCP server names', () => {
  test('the server Prism registers is recognised as managed', () => {
    assert.equal(isManagedMcpServerName(MANAGED_MCP_SERVER_NAME), true);
  });

  /**
   * The settings UI hides Edit and Delete for managed entries. A config written
   * by an older build still carries the old name until the toggle's cleanup
   * runs, and offering to delete it in the meantime is the same desync.
   */
  test('names from older builds are still managed', () => {
    assert.ok(LEGACY_MANAGED_MCP_SERVER_NAMES.length > 0, 'expected at least one legacy name');

    for (const name of LEGACY_MANAGED_MCP_SERVER_NAMES) {
      assert.equal(isManagedMcpServerName(name), true, `${name} should be managed`);
    }
  });

  /**
   * The bug this replaced matched on a `cloudcli-` prefix. A prefix rule spelled
   * `prism-` would be the same mistake pointed at the new name: it would take a
   * server the user configured and named themselves and strip its Edit and
   * Delete buttons, with no way to get them back.
   */
  test('a server the user named is theirs, even under the same prefix', () => {
    assert.equal(isManagedMcpServerName('prism-notes'), false);
    assert.equal(isManagedMcpServerName('prism-browser-staging'), false);
    assert.equal(isManagedMcpServerName('cloudcli-something-else'), false);
    assert.equal(isManagedMcpServerName('playwright'), false);
  });

  test('a missing name is not managed rather than a crash', () => {
    assert.equal(isManagedMcpServerName(undefined), false);
    assert.equal(isManagedMcpServerName(null), false);
    assert.equal(isManagedMcpServerName(''), false);
  });

  /**
   * The point of the shared module: both trees import these names instead of
   * spelling them out. This asserts nobody reintroduces a second copy, which is
   * how the UI came to be looking for `cloudcli-` while the backend wrote
   * `prism-browser` — a divergence that produced no error anywhere, only a
   * Delete button that should not have been there.
   */
  test('neither tree hardcodes a managed name of its own', () => {
    const sources = [
      'server/modules/browser-use/browser-use.service.ts',
      'src/components/mcp/view/McpServers.tsx',
    ];

    for (const relativePath of sources) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

      for (const name of [MANAGED_MCP_SERVER_NAME, ...LEGACY_MANAGED_MCP_SERVER_NAMES]) {
        assert.ok(
          !source.includes(`'${name}'`) && !source.includes(`"${name}"`),
          `${relativePath} spells out ${name} instead of importing it from shared/managedMcpServers.js`,
        );
      }
    }
  });
});
