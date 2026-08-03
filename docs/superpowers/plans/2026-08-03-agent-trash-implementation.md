# Agent Trash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-confirmation Web action that moves every managed Agent component into a Factory-controlled, seven-day recoverable trash and automatically purges expired entries on the next Factory invocation.

**Architecture:** A focused `TrashService` owns versioned manifests, same-parent atomic moves, rollback, restore, and purge. `FactoryApplication` coordinates launchd teardown and Registry mutation; Commander and Fastify expose the same use cases, while React renders the destructive action and recovery list.

**Tech Stack:** Node.js 20.19+, TypeScript strict, Zod, YAML, fs-extra, Commander, Fastify 5, React 19, Vitest, Playwright.

## Global Constraints

- Never operate on a path supplied by the browser; derive every component from a validated Registry snapshot and `FactoryPaths`.
- `--dry-run` performs no service uninstall, file move, Registry write, or manifest write.
- Runtime/Bridge Secret values never enter manifests, Registry, operation summaries, logs, or tests.
- Restore never overwrites an Agent ID or path and never starts Bridge or Job services.
- Only `ready` entries at least seven days old are automatically purged.
- Use one final Git commit after all acceptance commands pass, as explicitly requested by the user.

---

### Task 1: Versioned Trash Schema and Registry Removal

**Files:**

- Create: `src/schemas/trash-schema.ts`
- Modify: `src/core/registry.ts`
- Test: `tests/trash.test.ts`

**Interfaces:**

- Produces: `trashManifestSchema`, `TrashManifest`, `RegistryStore.remove(id): Promise<RegistryAgent>`.
- Consumes: existing `registryAgentSchema`, `atomicWriteFile`, and Registry backup behavior.

- [ ] **Step 1: Write failing schema and Registry tests**

```ts
expect(trashManifestSchema.parse(validManifest).state).toBe('ready');
expect((await registry.remove('test-agent')).id).toBe('test-agent');
expect((await registry.read()).agents).toHaveLength(0);
```

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/trash.test.ts`
Expected: FAIL because `trash-schema.ts` and `RegistryStore.remove` do not exist.

- [ ] **Step 3: Implement schema and atomic removal**

Define schema version 1, states `moving|ready|restoring|purging|failed`, registry snapshot, ISO timestamps, and component records `{name, source, trashed, existed, moved}`. Implement `remove` through the existing private Registry transaction and return the validated removed snapshot.

- [ ] **Step 4: Run the green test**

Run: `npm test -- --run tests/trash.test.ts`
Expected: PASS.

### Task 2: Transactional Trash Storage, Restore, and Expiry

**Files:**

- Create: `src/core/trash.ts`
- Modify: `src/core/paths.ts`
- Test: `tests/trash.test.ts`

**Interfaces:**

- Produces: `TrashService.list()`, `move(registry, options)`, `restore(trashId, options)`, `purgeExpired(options)`, `preview(registry)`.
- Consumes: `TrashManifest`, `RegistryStore.remove/add`, `FileLock`, `FactoryPaths.trashDir`.

- [ ] **Step 1: Add failing move/restore/purge tests**

```ts
const entry = await service.move(agent);
expect(await fs.pathExists(agent.workspace.path)).toBe(false);
expect((await registry.read()).agents).toHaveLength(0);
await service.restore(entry.trash_id);
expect(await fs.pathExists(agent.workspace.path)).toBe(true);
expect((await registry.read()).agents[0]?.status).toBe('stopped');
```

Also inject a rename failure and assert every previously moved path and Registry entry are restored; create a ready entry eight days old and assert only it is purged.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/trash.test.ts`
Expected: FAIL because `TrashService` is absent.

- [ ] **Step 3: Implement minimal transactional service**

Compute six component paths, validate non-root absolute containment, create `<source-parent>/.agentctl-trash/<trashId>/<component>`, persist a 0600 manifest, move with `fs.rename`, roll back in reverse order, remove/add Registry atomically, and delete only expired ready entries. Return DTOs containing IDs, names, timestamps, remaining days, and component names without Secret content.

- [ ] **Step 4: Run the green test**

Run: `npm test -- --run tests/trash.test.ts`
Expected: PASS.

### Task 3: Application Coordination and Service Teardown

**Files:**

- Modify: `src/application/factory-application.ts`
- Modify: `src/services/factory-services.ts` only if a reusable Job service enumeration helper is required
- Test: `tests/application-management.test.ts`

**Interfaces:**

- Produces: `trashAgent(id, {dryRun?})`, `listTrash()`, `restoreTrash(trashId, {dryRun?})`, `purgeExpiredTrash({dryRun?})`.
- Consumes: `JobStore.list`, `bridgeLaunchdService.uninstall`, `jobLaunchdService.uninstall`, `TrashService`.

- [ ] **Step 1: Write failing application test**

Assert that moving an Agent invokes Bridge plus every Job uninstall adapter, then returns a trash entry and makes `getAgent(id)` fail. Assert dry-run leaves services and files untouched.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/application-management.test.ts`
Expected: FAIL because application trash use cases are absent.

- [ ] **Step 3: Implement coordination**

For non-dry runs, enumerate all Jobs regardless of enabled state, idempotently uninstall each service and Bridge, then delegate storage mutation to `TrashService`. Keep restore stopped and do not install launchd files.

- [ ] **Step 4: Run the green test**

Run: `npm test -- --run tests/application-management.test.ts`
Expected: PASS.

### Task 4: CLI and Fastify API

**Files:**

- Modify: `src/cli-program.ts`
- Modify: `src/web/server.ts`
- Modify: `tests/cli-structure.test.ts`
- Modify: `tests/web-management-api.test.ts`

**Interfaces:**

- Produces CLI `trash move|list|restore|purge` and API `GET /trash`, `POST /agents/:id/actions/trash`, `POST /trash/:id/actions/restore`, `POST /trash/actions/purge-expired`.
- Consumes application methods from Task 3.

- [ ] **Step 1: Write failing CLI/API tests**

Assert the command group and four subcommands exist. Inject Web requests with missing/mismatched `confirmId` and expect 400; a matching confirmation returns the trash DTO and removes the Agent.

- [ ] **Step 2: Run the red tests**

Run: `npm test -- --run tests/cli-structure.test.ts tests/web-management-api.test.ts`
Expected: FAIL because routes and commands are absent.

- [ ] **Step 3: Implement CLI/API**

Use existing `confirmDanger`, Zod request validation, CSRF middleware, and Chinese error mapping. `trash move --dry-run` prints component paths; restore refuses conflicts; purge defaults to expired entries only.

- [ ] **Step 4: Run the green tests**

Run: `npm test -- --run tests/cli-structure.test.ts tests/web-management-api.test.ts`
Expected: PASS.

### Task 5: Web Button and Recovery List

**Files:**

- Modify: `web/src/api.ts`
- Modify: `web/src/pages/AgentDetailPage.tsx`
- Modify: `web/src/pages/BackupsPage.tsx`
- Modify: `web/src/styles.css` if the existing danger/modal styles are insufficient
- Modify: `tests/web-ui.test.tsx`

**Interfaces:**

- Produces `api.trashAgent`, `api.listTrash`, `api.restoreTrash`; destructive detail action and recovery cards.
- Consumes API routes from Task 4.

- [ ] **Step 1: Write failing component tests**

Assert clicking “移入回收站” opens one confirmation, sends matching Agent ID, shows an in-progress state, and redirects to `#/agents` only after success. Assert Backups page renders remaining days and restores after confirmation.

- [ ] **Step 2: Run the red test**

Run: `npm test -- --run tests/web-ui.test.tsx`
Expected: FAIL because the button and recovery section are absent.

- [ ] **Step 3: Implement Web behavior**

Reuse the current notice, button, and panel patterns. Keep errors visible, disable duplicate clicks, reload server state after success, and do not require typed ID because the action is recoverable for seven days.

- [ ] **Step 4: Run the green test**

Run: `npm test -- --run tests/web-ui.test.tsx`
Expected: PASS.

### Task 6: Invocation Cleanup, Documentation, and E2E

**Files:**

- Modify: `src/cli-program.ts`
- Modify: `src/web/start.ts`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DECISIONS.md`
- Modify: `e2e/web-console.spec.ts`
- Modify: `.agent/PROJECT_STATE.md`, `.agent/TASK_BOARD.md`, `.agent/FILE_LOCKS.md`, `.agent/TASK_HANDOFF.md`

**Interfaces:**

- Produces best-effort expired cleanup on CLI/Web invocation and complete user guidance.
- Consumes application purge from Task 3.

- [ ] **Step 1: Extend E2E with move and restore**

Create the temporary employee, move it to trash, verify it disappears from `/api/v1/agents`, restore it from “员工回收站”, and verify it returns stopped. Move it again, rewrite only the temporary manifest expiry, restart the console, and verify cleanup.

- [ ] **Step 2: Run the red E2E**

Run: `npm run test:e2e`
Expected: FAIL before invocation cleanup and UI are complete.

- [ ] **Step 3: Add startup cleanup and documentation**

Run purge after path/application setup, log only a Chinese warning on failure, document the seven-day/lazy-cleanup behavior, update architectural transaction boundaries, and complete TASK-009 bookkeeping.

- [ ] **Step 4: Run final acceptance**

Run: `npm run build && npm test && npm run lint && npm run test:e2e && git diff --check`
Expected: build succeeds, every Vitest and Playwright test passes, lint has zero warnings, and diff check is clean.

- [ ] **Step 5: Final Git commit**

```bash
git add .
git commit -m "feat: add recoverable employee trash"
```

Before staging, inspect `git status`, preserve TASK-007/TASK-008 work, confirm no generated test artifacts or Secret values, and include the confirmed design/plan documents.
