import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Test runner configuration.
 *
 * Prism has two source trees that both use the `@/` alias but resolve it to
 * different roots: `@/` means `server/` inside server code (per
 * server/tsconfig.json) and `src/` inside client code (per tsconfig.json).
 * A single alias map cannot express that, so the suites run as two projects,
 * each with its own resolver. Without this, every server test importing
 * `@/modules/...` failed to collect.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('./server', import.meta.url)),
          },
        },
        test: {
          name: 'server',
          environment: 'node',
          // `shared/` is imported by both trees, so it belongs to neither
          // project. It runs here because its modules are plain Node ESM with
          // no JSX and no `@/` alias, so the server resolver is the one that
          // needs no special casing. Without this line nothing under shared/
          // was collected by either project and could not be tested at all.
          include: ['server/**/*.test.{js,ts}', 'shared/**/*.test.{js,ts}'],
          // Several suites write to os.tmpdir() and patch process-wide state
          // (os.homedir, env vars), so they must not share a worker.
          pool: 'forks',
          poolOptions: {
            forks: { singleFork: false },
          },
          testTimeout: 30_000,
        },
      },
      {
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
          },
        },
        test: {
          name: 'client',
          environment: 'node',
          include: ['src/**/*.test.{js,ts,jsx,tsx}'],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
