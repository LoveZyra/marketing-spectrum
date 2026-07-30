# Providers Module Guide

Documents the provider contract in `server/modules/providers`. Keep it current
whenever provider wiring, skill discovery, or session sync behavior changes.

> **Scope of this fork.** Claude Code is the only provider. Upstream shipped
> `codex`, `cursor` and `opencode` as well; they were removed here — code,
> folders and dependencies — so anything below describing "the provider" is
> describing Claude. The abstraction itself was kept, because the facet split
> is what keeps SDK-format handling out of the shared services, but it now has
> exactly one implementation. See "Adding a second provider" if that changes.

## Current Provider Shape

`server/shared/types.ts` and `src/types/app.ts` both declare:

```ts
export type LLMProvider = 'claude';
```

A provider wrapper extends `AbstractProvider` and exposes **six** facets. Each
maps to an interface in `server/shared/interfaces.ts` and is consumed by one
service:

| Facet | Interface | Consumed by | Responsibility |
| --- | --- | --- | --- |
| `models` | `IProviderModels` | `providerModelsService` | Report the supported model catalog and the active model |
| `auth` | `IProviderAuth` | `providerAuthService` | Report install/auth state for the provider runtime |
| `mcp` | `IProviderMcp` | `providerMcpService` | Read, list, write and remove provider-native MCP config |
| `skills` | `IProviderSkills` | `providerSkillsService` | Discover provider-native skill markdown files |
| `sessions` | `IProviderSessions` | `sessionsService` | Normalize live events and fetch session history |
| `sessionSynchronizer` | `IProviderSessionSynchronizer` | `sessionSynchronizerService` | Scan transcript artifacts and upsert session metadata |

`sessions` and `sessionSynchronizer` stay separate on purpose: the first
handles runtime event normalization and history fetches, the second handles
file-backed session indexing into `sessionsDb`. A provider can have one without
the other being meaningful.

## Current File Layout

```text
server/modules/providers/
  provider.registry.ts          # id -> instance, throws UNSUPPORTED_PROVIDER
  provider.routes.ts            # /api/providers/*
  index.ts
  list/claude/
    claude.provider.ts                       # wrapper, wires the six facets
    claude-auth.provider.ts
    claude-models.provider.ts
    claude-mcp.provider.ts
    claude-skills.provider.ts
    claude-sessions.provider.ts
    claude-session-synchronizer.provider.ts
    history-cache.ts                         # Claude-specific, not a facet
  shared/                       # base classes + helpers the facets build on
  services/                     # the consumers listed in the table above
  tests/
```

`history-cache.ts` has no counterpart in the contract — it exists because
Claude's history reads are expensive enough to memoize. Provider-local helpers
like this belong in the provider folder, not in `shared/`.

## Claude Specifics

MCP config, declared in `claude-mcp.provider.ts` via
`super('claude', ['user', 'local', 'project'], ['stdio', 'http', 'sse'])`:

| Storage | Scopes | Transports |
| --- | --- | --- |
| `.mcp.json` in user / local / project locations | `user`, `local`, `project` | `stdio`, `http`, `sse` |

Skill discovery roots (`claude-skills.provider.ts`):

| Scope | Root | Command form |
| --- | --- | --- |
| `user` | `~/.claude/skills` | `/skill-name` |
| `project` | `<workspace>/.claude/skills` | `/skill-name` |
| `plugin` | enabled plugin installs, scanned recursively | `/plugin-name:skill-name` |

Skills come from `SKILL.md` files.
`readProviderSkillMarkdownDefinition(...)` reads front-matter `name` and
`description`, falling back to the parent directory name when `name` is absent.
Plugin skills are discovered differently from user/project folders — command
skills live under `commands/`, markdown skills under `skills/`.

Session synchronization (`claude-session-synchronizer.provider.ts`):

| Scan root | Metadata helpers |
| --- | --- |
| `~/.claude/projects/**/*.jsonl` | `~/.claude/history.jsonl` for name lookup; trailing `ai-title`, `last-prompt` or `custom-title` entries for title recovery |

Subagent transcripts sit at
`~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.

## Facet Implementation Rules

These are the invariants the shared services rely on. They apply to Claude
today and to anything added later.

**Auth.** Return a full `ProviderAuthStatus`. Treat `not installed` and
`not authenticated` as data, not exceptions. Keep credential discovery inside
the auth facet.

**MCP.** Extend `McpProvider`, pass supported scopes and transports to
`super(...)`, and implement `readScopedServers`, `writeScopedServers`,
`buildServerConfig` and `normalizeServerConfig`. Use the shared validation and
normalization; keep the config file format local to the implementation.

**Skills.** Extend `SkillsProvider` and implement
`getSkillSources(workspacePath)` with the real discovery roots. Use
`recursive: true` only where skills genuinely nest. Keep the emitted `command`
string aligned with the runtime's actual skill syntax.

**Sessions.** Implement `normalizeMessage(raw, sessionId)` and
`fetchHistory(sessionId, options)`, building messages with
`createNormalizedMessage(...)` and `generateMessageId(...)`. Normalized ids must
be unique — when one raw event yields several text parts, append a
discriminator. Pagination contract: `limit: null` is unbounded, `limit: 0` is an
empty page, and every paginated response returns `total`, `hasMore`, `offset`
and `limit`. Sanitize filesystem-derived ids before they reach a path or query.

**Session synchronizer.** Implement `synchronize(since?: Date)` and
`synchronizeFile(filePath)`. Reuse `buildLookupMap(...)`,
`extractFirstValidJsonlData(...)`, `findFilesRecursivelyCreatedAfter(...)`,
`normalizeSessionName(...)` and `readFileTimestamps(...)` where they fit. Stay
resilient to partial, malformed and missing files: the orchestration service
only advances `scan_state.last_scanned_at` when every synchronizer succeeds, so
one throwing provider stalls the scan cursor for all of them.

## Adding a Second Provider

Nothing in the module hardcodes a single provider, but the shared layer has now
only ever been exercised against Claude — expect to find Claude-shaped
assumptions in `shared/` that were invisible while three other providers kept
them honest. Budget for fixing those rather than only writing the new folder.

The wiring points, all of which currently say `'claude'` and nothing else:

- `server/shared/types.ts` — the `LLMProvider` union
- `src/types/app.ts` — the frontend `LLMProvider` union
- `server/modules/providers/provider.registry.ts` — id → instance
- `server/modules/providers/provider.routes.ts` — provider parsing
- `server/routes/agent.js` and `server/index.js` — if it runs live chat
- `public/api-docs.html` — the `PROVIDER_ORDER` list
- `src/components/chat/hooks/useChatProviderState.ts` and
  `src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx` — if
  it should be selectable in chat
- `src/components/provider-auth/view/ProviderLoginModal.tsx` — if it has a
  login flow
- `src/components/mcp/constants.ts` — MCP UI affordances

Then create `list/<provider>/<provider>.provider.ts` extending
`AbstractProvider`, calling `super('<provider>')` and implementing all six
facets. The single-provider UI is worth a look before starting: with one
provider the selector is collapsed, so re-introducing a choice is a frontend
change, not just a backend registration.

```ts
export class <Provider>Provider extends AbstractProvider {
  readonly models: IProviderModels = new <Provider>ProviderModels();
  readonly mcp = new <Provider>McpProvider();
  readonly auth: IProviderAuth = new <Provider>ProviderAuth();
  readonly skills: IProviderSkills = new <Provider>SkillsProvider();
  readonly sessions: IProviderSessions = new <Provider>SessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer =
    new <Provider>SessionSynchronizer();

  constructor() {
    super('<provider>');
  }
}
```

Omitting `models` is the easy mistake: it is abstract on `AbstractProvider`, so
a wrapper without it fails typecheck rather than failing at runtime.

## Validation

```bash
npx eslint server/modules/providers server/shared/types.ts server/shared/interfaces.ts
npx tsc --noEmit -p server/tsconfig.json
npx vitest run server/modules/providers
```

Existing tests in this module:

- `tests/mcp.test.ts`
- `tests/skills.test.ts`
- `tests/history-cache.test.ts`
- `tests/provider-image-history.test.ts`
- `tests/provider-models.service.test.ts`
- `tests/session-export.service.test.ts`
- `tests/sessions-watcher.service.test.ts`

Add focused tests alongside any change to sessions or session synchronization.

## Common Mistakes

- Adding provider files but forgetting `provider.registry.ts` or
  `provider.routes.ts`.
- Updating the backend `LLMProvider` union but not `src/types/app.ts`.
- Omitting a facet from the wrapper — `models` and `sessionSynchronizer` are the
  usual casualties.
- Returning duplicate normalized message ids for split content.
- Treating `limit === 0` as unbounded history.
- Building file paths from raw session ids without validation.
- Hardcoding a skill root without checking the runtime's actual discovery rules.
- Forgetting that Claude plugin skills are discovered differently from normal
  user/project skill folders.
- Letting a synchronizer throw on a malformed file: it stalls
  `scan_state.last_scanned_at` for every provider, not just its own.
