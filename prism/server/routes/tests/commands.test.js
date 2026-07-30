import assert from 'node:assert/strict';
import { test } from 'vitest';

import { executeModelsCommand } from '../commands.js';
import { providerModelsService } from '../../modules/providers/services/provider-models.service.js';

test('models command reports the catalog for the active provider', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;
  let getCurrentActiveModelCalls = 0;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [{ value: 'sonnet', label: 'Sonnet' }],
      DEFAULT: 'sonnet',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => {
    getCurrentActiveModelCalls += 1;
    return {
      model: 'opus',
    };
  };

  try {
    const result = await executeModelsCommand([], {
      provider: 'claude',
      model: 'sonnet',
    });

    assert.equal(result.type, 'builtin');
    assert.equal(result.action, 'models');
    assert.equal(result.data.current.provider, 'claude');
    assert.equal(result.data.current.providerLabel, 'Claude');
    assert.equal(result.data.current.model, 'sonnet');
    assert.deepEqual(Object.keys(result.data.available), ['claude']);
    assert.deepEqual(result.data.available.claude, result.data.availableModels);
    assert.ok(result.data.availableModels.includes('sonnet'));
    // Without a concrete session id the command must trust the model passed in
    // the context rather than querying the provider for a live active model.
    assert.equal(getCurrentActiveModelCalls, 0);
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});

/**
 * Claude Code CLI is the only provider Prism supports. A `provider` field left
 * over from an older client or a session row written before Codex/Cursor/
 * OpenCode were removed must normalize to claude instead of being echoed back
 * into the response, where it would produce an `available` key no provider
 * serves.
 */
test('models command normalizes unsupported providers to claude', async () => {
  const originalGetProviderModels = providerModelsService.getProviderModels;
  const originalGetCurrentActiveModel = providerModelsService.getCurrentActiveModel;

  providerModelsService.getProviderModels = async () => ({
    models: {
      OPTIONS: [{ value: 'default', label: 'Default (recommended)' }],
      DEFAULT: 'default',
    },
    cache: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      source: 'fresh',
    },
  });
  providerModelsService.getCurrentActiveModel = async () => ({
    model: 'default',
  });

  try {
    for (const provider of ['codex', 'cursor', 'opencode', 'unknown-provider', '', null]) {
      const result = await executeModelsCommand([], { provider });

      assert.equal(result.data.current.provider, 'claude', `provider=${String(provider)}`);
      assert.deepEqual(Object.keys(result.data.available), ['claude']);
      assert.equal(result.data.current.providerLabel, 'Claude');
    }
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    providerModelsService.getCurrentActiveModel = originalGetCurrentActiveModel;
  }
});
