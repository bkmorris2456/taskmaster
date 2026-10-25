# Taskmaster

A minimal personal task manager with a dark, CLI-inspired interface. **Phases 1–5 provide offline task management; Phase 6 adds the cloud database foundation.** Categories, Date and Big List retain shared filtering, sorting and search. Supabase SQL/RPC infrastructure is implemented; authentication UI and client cloud synchronization remain unimplemented. Local native Supabase-stack certification has passed.

## Stack and installation

React 19, React Router 8, strict TypeScript 6.0, Vite 8, Tailwind CSS 4, Dexie 4.4.6 and vite-plugin-pwa 2. Vitest 5, React Testing Library, fake-indexeddb (unit tests only), Playwright 1.64, ESLint 10 and Prettier 3 provide validation. Exact versions are pinned in package.json/package-lock.json. Dexie's built-in liveQuery provides reactive repository reads without an additional state or React adapter dependency.

Use Node.js 24 LTS (tested 24.21.0; `.nvmrc`) and npm 11 (tested 11.19.0). TypeScript 6.0.3 is pinned because typescript-eslint does not yet support TypeScript 7. No environment variables or credentials are required for the current local app. Phase 6 placeholder configuration and database tooling are documented below.

```sh
nvm use
npm ci
npm run dev
```

Open Vite's printed URL (normally http://127.0.0.1:5173). Development enables an explicitly labeled **local-only test workspace**. Use test data: the browser profile has no account security, encryption or backup. Data is scoped to the origin; switching hostnames or ports uses a different database. Development mode does not install a service worker.

The approved plan forbids a fake-auth bypass in production during Phases 1–5. Therefore normal `npm run build` produces a shell with task storage disabled. To test installed/cached offline local CRUD, explicitly build the local preview:

```sh
npm run build:local
npm run preview:local -- --port 4173 --strictPort
```

This writes `dist-local/`; **do not deploy it as the authenticated product**. The standard production build writes `dist/` and cannot open the synthetic workspace. Preview data will never be automatically imported into a future authenticated account. There is no account switch, session or network client hidden behind this harness.

## Task workflow

In Big List, type a title and press Enter or Create task. Optional description expands inline. Titles must contain non-whitespace text, at most 240 characters; descriptions allow 10,000 characters. Edit opens a compact inline editor. Successful writes clear the create form; failures keep input and show an alert. Unsaved drafts require explicit discard when leaving or cancelling. Browsers may also warn on reload/close; unsaved drafts are not database records and cannot survive a forced process kill.

Check a task to complete it. It disappears from Active and appears in Completed. Undo completion remains available while the current task view is mounted; after reload use the completed row's checkbox to reopen. Reopening adds a reversal event without erasing the original completion. Expand Completion history to see completion snapshots and reversals, even after task text changes or deletion. Deleted is a recovery view for tombstoned tasks; Restore retains the original UUID and completion state. No permanent delete/purge control is provided.

All task state comes from IndexedDB. No tasks, queue or history are simulated with React state or localStorage. React state holds drafts, UI status and the latest subscribed query result only. Local changes are retained with a visible count; nothing is sent to a server. Concurrent stale edits are rejected with an actionable alert and the losing draft remains available. Cancel after copying any wanted text, review the current row and edit again; there is no automatic merge in the local workspace.

## Categories, groups and Date view

Category view displays Uncategorized, category-level tasks and groups within expandable categories. Create categories with New category; use the container controls to rename/delete or add a group/task. Container Add task preselects its context in the shared quick form. Names require 1–80 trimmed characters; normalized/case-insensitive duplicates are prevented among live sibling containers. Native summary controls work with keyboard Enter/Space. Counts show completed/total records under the selected task status, explicitly labeled “shown”.

Task editors across all views support category, group and optional due date under Organization and due date. Category changes clear group; a group must belong to the selected category. Dead/missing/cross-owner references fail rather than silently dropping work. Big List continues to show tasks across all categories.

Deleting a group asks for confirmation and removes group assignments while keeping task categories. Deleting a category asks for confirmation, tombstones its groups and makes its tasks uncategorized. Completed and already-deleted task assignments are updated too. Tasks and completion snapshots survive; category/group deletion is one atomic queued command. Containers have no restore control; recreate with new IDs. Task restore still works and cannot resurrect deleted assignments.

Date view defaults to due-date groups in ascending order, with No due date last and active overdue groups labeled. Group dates by switches to creation or completion dates. Completion date defaults to completed tasks until a status is explicitly chosen; explicit Active stays selected and shows no completion-date rows; reopening removes them from that grouping and preserves history. Deadlines stay literal Gregorian YYYY-MM-DD strings (1900–9999); creation/completion instants group in the device’s current display zone. All views share the query controls described below.

## Commands and verification

| Command                                         | Purpose                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run dev`                                   | Development server with local test workspace                                                   |
| `npm run typecheck`                             | Strict compilation of application and tests                                                    |
| `npm run lint`                                  | ESLint, zero allowed warnings                                                                  |
| `npm run format:check` / `npm run format`       | Check/apply formatting                                                                         |
| `npm test`                                      | Vitest component, repository, transaction and migration tests                                  |
| `npm run build` / `npm run preview`             | Standard production shell, local storage disabled                                              |
| `npm run build:local` / `npm run preview:local` | Explicit offline-capable local task preview                                                    |
| `npm run check`                                 | Typecheck, lint, formatting, unit tests, standard build                                        |
| `npm run test:e2e`                              | Build both modes; real Chromium navigation, persistence, offline and production-boundary tests |

```sh
npx playwright install chromium
# Clean Linux CI hosts may need OS libraries:
npx playwright install --with-deps chromium
npm run check
npm run test:e2e
```

Playwright owns ports 4173 (local preview) and 4174 (standard production); stop manual previews first. Tests run in desktop/mobile Chromium contexts and use real IndexedDB, including quota failure injected at the native outbox write, cross-tab stale edits, reload, a fresh app page and a full browser-process restart with a persistent profile. Unit repository tests use fake-indexeddb for deterministic fault/clock/migration checks; they are not the proof of actual browser persistence. Reports are ignored in playwright-report/ and test-results/. CI is configured but local results do not imply a remote CI run.

## IndexedDB schema and repository

The synthetic workspace database is `taskmaster:local-preview:00000000-0000-4000-8000-000000000002`, schema version 3. The fixed UUID is a synthetic owner, not a user identity. A device UUID is generated once and retained in metadata.

| Store                                 | Purpose and indexes                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tasks                                 | Current local projections, including tombstones; UUID primary key; ownerId, createdAt, categoryId, groupId, dueDate, seriesId                             |
| canonicalTasks                        | Separate canonical state boundary required by the architecture; currently empty because no application cloud connection exists; UUID primary key, ownerId |
| categories / groups                   | Organization projections and tombstones; UUID primary key, ownerId; groups also index categoryId                                                          |
| canonicalCategories / canonicalGroups | Separate empty canonical organization boundaries; same identity/parent indexes                                                                            |
| recurrenceSeries / canonicalSeries    | Local recurring templates/configuration and empty canonical boundary; UUID primary key, ownerId; local series also index activeTaskId                     |
| completionEvents                      | Append-only completion snapshots/reversals; UUID primary key; taskId, ownerId                                                                             |
| outbox                                | Durable versioned commands; operation UUID primary key, unique sequence, taskId                                                                           |
| meta                                  | Workspace owner/device ID and transactional sequence; key `workspace`                                                                                     |

Task records include UUID/owner, title/description, status/timestamps, nullable due date/priority/category/group/series/occurrence date, nullable server revision, independent localRevision, provisional-timestamp flag, active completion-event ID and last operation ID. Recurrence configuration is stored in recurrenceSeries, referenced by task.seriesId; occurrenceDate identifies the scheduled occurrence. There is no background scheduler or duplicated embedded configuration. All timestamps are ISO UTC strings. Creation is stable; each mutation increments localRevision and advances updatedAt even if the device clock moves backwards. These provisional clocks never decide future cloud conflicts.

TaskRepository owns every task mutation; OrganizationRepository owns containers and atomic assignment cascades. Both share transaction-only command metadata code. TaskRepository provides the single reactive workspace read for all three views. One read-write Dexie transaction updates every affected projection, appends any history event, adds a command and advances metadata. Outbox insertion failure rolls everything back. New local v2 command envelopes retain stable IDs, sequence, intent, every affected entity’s base/result snapshots, read revisions and dependencies (including destination parents). Existing v1 commands remain unchanged. These local serialization versions now map to the Phase 6 SQL command contract; there is still no sender. They are never removed/rewritten in this phase. Server revisions remain null; dependent command revision freezing and acknowledgement/reconciliation belong to Phase 8. No queue sender, retry engine or Supabase client exists.

Schema v1 → v2 adds category/group and canonical organization stores plus task indexes without rewriting tasks, history, metadata or old queued commands. Real-browser migration tests seed native v1 IndexedDB, run the actual application upgrade and compare all legacy objects exactly. Future schema changes add a new Dexie version and transactional upgrade; never edit deployed migration logic or clear/recreate a database on error. Unsupported newer schemas are refused; failed upgrades leave prior data intact. Tests exercise additive migration and rollback. Phase 1 created no IndexedDB schema to migrate. Changing origin, browser eviction, clearing site data, private browsing or profile loss can remove local-only work; browser persistence is not backup.

## PWA and updates

Open the local preview online, wait for **Application shell ready offline**, then disconnect. CRUD and history work offline after caching. The manifest has standalone display, 192/512 PNG icons, a maskable icon and an Apple touch icon. `python3 scripts/generate_icons.py` regenerates the code-native icons with no third-party dependency; Python is not required for install/build/runtime.

The worker precaches only public HTML/JS/CSS/icons/manifest, never user records or API responses. Known view paths alone receive navigation fallback. Updates remain user-prompted; a local guard blocks applying them while drafts or writes are pending. Native reload/close protection also covers dirty forms. Complete multi-tab update coordination, future migration compatibility, physical-device installation and Safari/Firefox certification remain later-phase release work. Static hosting eventually requires HTTPS, SPA fallback, revalidated sw.js and security-header review; no hosting has been configured.

## Structure and phase boundary

```text
src/
  main.tsx              React initialization and guarded browser routing
  app/                  Shell, route focus, error boundary, PWA availability
  domain/               Task/organization models, validation and civil-date grouping
  data/local/           Versioned Dexie schema, task/organization repositories, command appender, harness
  features/tasks/       Shared task controller, forms/rows, organization form and subscription
  features/query/       Shared query controls, memoized results and scoped preferences
  features/views/       Hierarchical/chronological projections and route integration
  components/           Shared empty state
  styles/               Tailwind theme and compact task controls
tests/unit/             Component/repository/transaction/migration tests
tests/e2e/              Real-browser shell/CRUD/offline/production-boundary tests
public/icons/           Application icons
scripts/                Icon generator
.github/workflows/      Clean-install CI checks
```

React Router's data-router root now permits guarded navigation via useBlocker; there are no loaders, network data routes or remote caches. App/test TypeScript remains strict with noUncheckedIndexedAccess, exactOptionalPropertyTypes and skipLibCheck=false. No suppressions were introduced. See ARCHITECTURE.md for design and IMPLEMENTATION_PLAN.md for actual Phase 5 validation results. No new dependencies were needed in Phases 3–4. Large cascades and queue growth remain later performance/retention work; browser-profile loss still has no recovery or backup. The historical Phase 5 result is preserved; Phase 6 is now authorized.

## Filtering, sorting and search (Phase 4)

Use Active, Completed or All for current task status; Deleted remains recovery access. Search titles/descriptions offline with case-insensitive NFC substring matching; surrounding whitespace is ignored. Sort supports newest/oldest, title A–Z/Z–A, deadline ascending/descending, priority and completion status. Null deadlines sort last both ways, priority is High → Medium → Low → unspecified, and UUID breaks ties deterministically. Category/Date grouping remains intact, with sorting inside each group. Medium uses the existing normal stored value; optional priority editing is in the existing task form.

Expand Filter controls for category, group/direct tasks, priority and independent Created/Due/Completed ranges. Conditions combine with AND. Each field retains its range when switching the date-field control. Today/Yesterday/Last 7/14/30 Days use local calendar days; Last 14 Days means today plus the previous 13 days. Custom endpoints are inclusive; missing/reversed endpoints show an error and no results. All dates includes missing values; No date selects them explicitly. Deadlines never shift with time zones. Completion ranges match current completedAt, so reopened tasks no longer match them; the separate Completion history ledger remains unfiltered.

The date grouping control defaults completion mode to Completed only before an explicit status choice. Active explicitly chosen in completion mode yields no rows and an explanation; All shows currently completed rows there. Reset filters restores initial status, due-date grouping, ranges, search and sort. Deleted recovery mode itself is transient.

Current preferences persist per view in a versioned localStorage key scoped to the synthetic database/owner (including search terms); task data remains IndexedDB-only. Preference changes make no outbox commands. Invalid/old values reset with notice; deleted category/group references clear with notice when that view next loads. Changing a category filter clears its group filter; filtering never moves tasks. Storage failures leave controls usable for this visit and report the preference issue. Tabs do not live-synchronize preference controls. Named saved-filter UI and cloud preferences remain deferred.

The pure engine filters subscribed records and sorts a copy; memoization avoids rescans/recalculation for unrelated draft/UI changes. The deterministic 10,000-task benchmark runs with `npm test` and writes ignored `test-results/query-benchmark.json`. This is a host microbenchmark, not full-list rendering or mobile certification. The independent history ledger renders rows only when expanded. Very large DOM lists and mutation-time full workspace reads remain known scaling limits.

Historical Phase 4 verification: 126 unit tests and 55 browser tests passed (0 failed); strict typecheck, lint, formatting and production build passed. The recorded 10,000-task/20,000-resident-history microbenchmark measured 13.74 ms median and 20.45 ms p95 over 20 runs on an Intel i5-12600K Linux host with Node 24.21.0 (no CPU throttling; DOM rendering excluded). See IMPLEMENTATION_PLAN.md for full browser results and remaining release gates.

## Recurring tasks (Phase 5)

Expand Organization and due date in the quick form/editor. Choose Repeat: Daily, Weekly or Monthly, a Schedule anchor and Recurrence time zone (initially the device's IANA zone). Enabling sets the first due date to that anchor. Weekly follows its weekday; Monthly follows its day-of-month, clamped for short months without losing the target (Jan 31 → Feb 28/29 → Mar 31). The editor previews the next date after completion today. The saved series zone remains fixed when travelling or changing the display zone.

Checking the current occurrence preserves it as completed and atomically creates one next active task. Overdue slots are skipped: due Oct 21, completed Oct 24 → daily successor Oct 25. No instances appear merely because time passes. Calendar calculation handles leap years/DST without adding 24 hours. All operations and commands persist offline, including browser restart. Existing filters, sorting, groups and views apply to the same task records; active views show one occurrence per enabled series, while Completed/history retain prior occurrences.

Ordinary current-task edits update the future template. A due-date-only edit does not change the schedule anchor. Changing frequency, anchor or zone explicitly replaces the active occurrence and keeps the old one as a tombstone; series identity and historical completions survive. Disable Repeat to keep the current task standalone. Deleting the active occurrence disables its series; deleting a historical completed task does not. Incomplete recurring tombstones offer Restore as standalone, preventing accidental duplicate active occurrences. Reenable recurrence explicitly when wanted.

Undo/reopen is atomic only while the generated successor and series are untouched, with no later dependent operations. A save/edit/move, reanchor or later completion blocks it visibly. Completed recurring rows offer a confirmed Reopen as standalone fallback that leaves the current series alone. Reversal events preserve every earlier completion snapshot. Recompletion generates a fresh successor identity, retaining the old tombstone. Historical completed records can be edited but cannot alter the current schedule. Bounds are 1900–9999; overflow fails without changing records and can be resolved by rescheduling or disabling Repeat.

Schema v2 → v3 adds recurrenceSeries/canonicalSeries stores and a task seriesId index only; all previous stores and legacy/unknown outbox fields are preserved. Series records contain the template, frequency/anchor/zone, active pointer, schedule and local/server revision metadata and tombstone. Canonical series stays empty until real cloud integration. TaskRepository and transaction-only recurrence helpers record all affected tasks/series/history and one durable command together. Organization deletion also clears future template assignments atomically. No database reset or seed runs.

Runtime addition: uuid 14.0.3 provides the documented deterministic v5 successor/reanchor identity algorithm instead of custom hashing; no recurrence/date library was added. The existing PWA build dependency serialize-javascript received its compatible advisory patch. Future server synchronization must reconcile independent offline candidates with the approved serialized first-commit/idempotency rules; local replica tests do not prove cloud conflict resolution. Schema/synchronization details and actual validation results are in ARCHITECTURE.md and IMPLEMENTATION_PLAN.md.

Phase 5 local validation: `npm run check` passed (180 unit tests, zero failures; typecheck/lint/format/build passed). The full `npm run test:e2e` run passed 69 browser tests, zero failures, including offline browser-process restart, actual v2→v3 IndexedDB migration, complete/undo quota rollback, cross-view recurrence and keyboard/mobile controls. Browser execution used the documented temporary Linux library path. npm audit reported zero vulnerabilities after the compatible build-tool patch. No actual cloud conflict resolution, remote CI, deployment or cross-browser/device certification is claimed. Phase 6 was subsequently authorized; see its status below.

## Phase 6 database foundation

Supabase CLI 2.122.0 is a pinned development-only tool. Seven SQL migrations (the original four plus three native certification corrections) add normalized owner-scoped entities, forced owner/AAL2 RLS, restricted transactional commands, idempotency receipts, deterministic recurrence enforcement and safe change-feed cursors. No application network client or authentication flow is activated; the production synthetic-workspace boundary is unchanged.

See [Supabase setup and RPC protocol](docs/SUPABASE.md), [security review](docs/SECURITY_REVIEW.md) and the Phase 6 record in IMPLEMENTATION_PLAN.md. `.env.example` contains public placeholders only. Never put privileged credentials in VITE variables.

```sh
npm run db:start             # Requires working Docker/WSL integration
npm run db:test:supabase     # Native local stack: rollback-only pgTAP companion
# Standalone real SQL/PostgREST suite (dedicated disposable cluster only):
TASKMASTER_TEST_ADMIN_URL=postgresql://blake@127.0.0.1:55436/postgres \
TASKMASTER_POSTGREST_BIN=/tmp/taskmaster-postgrest/postgrest \
npm run test:db
```

Additional files: src/data/remote/contract.ts (types only), supabase/config.toml, supabase/migrations/, supabase/tests/, tests/database/ and vitest.db.config.ts. The standalone harness creates/drops only its own random test database and uses a minimal Auth SQL fixture with real PostgREST signature verification; it does not verify native GoTrue/TOTP. Temporary binaries/libraries may need reprovisioning after restart. The configured PostgreSQL 17 major and native GoTrue/TOTP/Kong authorization gate are now tested. Exact current results and remaining work are in IMPLEMENTATION_PLAN.md. Stop at Phase 6; Phase 7 needs explicit approval.

Native gateway certification uses `TASKMASTER_NATIVE_CONFIRM_DISPOSABLE=taskmaster npm run test:db:native` against the verified disposable local stack. It reuses the database suite with real GoTrue-issued AAL1/AAL2 sessions; OTPAuth 9.5.2 is a development-only authenticator fixture. All seven migrations, native pgTAP and application regressions pass; exact counts and limits are recorded in IMPLEMENTATION_PLAN.md. No Phase 7 application authentication or client synchronization has been implemented.
