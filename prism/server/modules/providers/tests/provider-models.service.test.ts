import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import {
  createProviderModelsService,
} from '@/modules/providers/services/provider-models.service.js';
import type {
  ProviderChangeActiveModelInput,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { writeProviderSessionActiveModelChange } from '@/shared/utils.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({
  model,
});

const createSessionActiveModelChange = (
  provider: LLMProvider,
  input: ProviderChangeActiveModelInput,
): ProviderSessionActiveModelChange => ({
  provider,
  sessionId: input.sessionId,
  supported: true,
  changed: true,
  model: input.model,
});

const createEphemeralCachePath = (): string => path.join(
  os.tmpdir(),
  `provider-model-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

test('provider models service delegates to the resolved provider model adapter', async () => {
  const calls: LLMProvider[] = [];
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => {
      calls.push(provider);
      return {
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      };
    },
  });

  const models = await service.getProviderModels('claude', { bypassCache: true });

  assert.deepEqual(calls, ['claude']);
  assert.equal(models.models.DEFAULT, 'claude-models');
  assert.equal(models.cache.source, 'fresh');
});

test('provider models service returns each provider adapter result without rewriting it', async () => {
  const expectedModels: ProviderModelsDefinition = {
    OPTIONS: [
      { value: 'model-a', label: 'Model A' },
      { value: 'model-b', label: 'Model B' },
    ],
    DEFAULT: 'model-b',
  };

  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => expectedModels,
        getCurrentActiveModel: async () => createCurrentActiveModel('model-active'),
        changeActiveModel: async (input) => createSessionActiveModelChange('claude', input),
      },
    }),
  });

  const models = await service.getProviderModels('claude', { bypassCache: true });

  assert.deepEqual(models.models, expectedModels);
});

test('claude provider models are always loaded directly from the provider', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-claude-direct-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    const second = await service.getProviderModels('claude');

    assert.equal(loadCount, 2);
    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(second.models.DEFAULT, 'claude-2');
    assert.equal(second.cache.source, 'fresh');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent provider model requests share one load operation', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-pending-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return createModels('claude-cached');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('claude-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('claude', input),
        },
      }),
    });

    const [first, second] = await Promise.all([
      service.getProviderModels('claude'),
      service.getProviderModels('claude'),
    ]);

    assert.equal(loadCount, 1);
    assert.equal(first.models.DEFAULT, 'claude-cached');
    assert.equal(second.models.DEFAULT, 'claude-cached');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('bypassCache forces a fresh provider fetch and updates cache metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-refresh-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active-${loadCount}`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    currentTime += 50;
    const refreshed = await service.getProviderModels('claude', { bypassCache: true });

    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(refreshed.models.DEFAULT, 'claude-2');
    assert.equal(refreshed.cache.source, 'fresh');
    assert.notEqual(refreshed.cache.updatedAt, first.cache.updatedAt);
    assert.equal(loadCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('provider models service delegates current active model lookups to the provider adapter', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const service = createProviderModelsService({
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async (sessionId) => {
          calls.push({ provider, sessionId });
          return createCurrentActiveModel(`${provider}-${sessionId}`);
        },
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  const activeModel = await service.getCurrentActiveModel('claude', 'session-123');

  assert.deepEqual(calls, [{ provider: 'claude', sessionId: 'session-123' }]);
  assert.equal(activeModel.model, 'claude-session-123');
});

test('provider models service delegates active model change requests to the provider adapter', async () => {
  const calls: Array<{ provider: LLMProvider; input: ProviderChangeActiveModelInput }> = [];
  const service = createProviderModelsService({
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => {
          calls.push({ provider, input });
          return createSessionActiveModelChange(provider, input);
        },
      },
    }),
  });

  const changedModel = await service.changeActiveModel('claude', {
    sessionId: 'session-123',
    model: 'opus',
  });

  assert.deepEqual(calls, [{
    provider: 'claude',
    input: {
      sessionId: 'session-123',
      model: 'opus',
    },
  }]);
  assert.equal(changedModel.changed, true);
  assert.equal(changedModel.model, 'opus');
});

test('resolveResumeModel prefers a stored changed model over the requested one', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-change-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      activeModelChangesPath,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    await writeProviderSessionActiveModelChange('claude', {
      sessionId: 'session-456',
      model: 'opus',
    }, {
      filePath: activeModelChangesPath,
    });

    const model = await service.resolveResumeModel('claude', 'session-456', 'sonnet');
    assert.equal(model, 'opus');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
