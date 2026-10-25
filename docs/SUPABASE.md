# Supabase database foundation

Phase 6 implements database infrastructure only. There is no frontend Supabase client, authentication UI, account database, queue sender or production deployment. The synthetic local workspace must never be uploaded into a real account. The original four SQL migrations and three certification corrections are now applied locally; preserve applied files and use new forward migrations for later corrections.

## Tools and configuration

Use the project's Node 24/npm 11 toolchain and `npm ci`. Supabase CLI **2.122.0** is pinned as a development dependency; use `npx supabase --version`. It adds no browser runtime code. A working Docker-compatible daemon is required for the normal local stack. Start Docker Desktop on macOS; WSL integration applies only on Windows. PostgreSQL clients (`psql`) must be on PATH for native certification. Install the browser revision required by the pinned Playwright using `npx playwright install chromium`; Linux hosts also need its OS libraries. See [macOS baseline validation](MACOS_VALIDATION.md) for this Mac's setup and results.

`supabase/config.toml` targets PostgreSQL **17**, API port 54321, database port 54322 and shadow port 54320. It exposes only public schema, caps table reads at 500, disables seeds, Realtime, Storage, Edge Runtime and Analytics, and enables email confirmation plus native TOTP enrollment/verification (maximum two factors). Local configuration does not automatically configure a hosted project's Auth settings. See the [official CLI configuration reference](https://supabase.com/docs/guides/local-development/cli/config).

`.env.example` contains placeholders only. Copy to an ignored `.env.local` when a later authorized phase needs configuration. `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are public browser values; a legacy anon key is also public. Never put service-role keys, database passwords, access/refresh tokens or TOTP seeds in VITE variables, task records, receipts, logs or committed files. The current application does not read these placeholders. Protected operator connection strings and CLI access tokens belong in an external secret store/CI environment, never the SPA.

## Disposable local stack

First verify `docker info` succeeds and that the Taskmaster local containers/volumes contain disposable test data. Do not connect these procedures to a hosted project.

```sh
npm ci
npx supabase --version
npm run db:start
npx supabase migration list --local
npm run db:test:supabase
```

`supabase start` initializes a fresh local stack using migrations. To apply outstanding migrations to an existing local database, use `npx supabase migration up --local`. Review the target before any reset. **Only for a confirmed disposable Taskmaster local stack**, `npx supabase db reset --local` destroys its database data and reapplies migrations. It does not preserve pending work or provide a production rollback. Never use reset against remote resources. `npx supabase stop` stops the local stack; avoid data-deleting flags unless intentionally discarding the test environment.

Original migration order (certification adds 005–007 below):

1. `20261024000100_schema.sql`: extension, restricted executor role, eight tables, indexes, same-owner constraints, forced RLS and graph triggers.
2. `20261024000200_protocol_helpers.sql`: validation, canonical mapping, revision checks, calendar/UUID calculations and write/feed helpers.
3. `20261024000300_commands.sql`: transactional command processor and authenticated RPC permissions.
4. `20261024000400_reads.sql`: bounded changes/receipt RPCs and final execution/default privileges.

Apply as the protected migration administrator with permission to create/grant the restricted executor role and transfer function ownership. Never grant executor membership to API roles. The migrations fail if an unsafe preexisting executor role or API membership is detected. An existing uuid-ossp extension must be in `extensions`; inspect this before deployment. Native Auth access requires the private bridges introduced in migration 005; the original managed auth grant alone is ineffective. All command writers, including maintenance tools, must serialize on the owner counter and append changes/receipts atomically. Direct operator repairs outside this protocol require an explicit synchronization invalidation/rebootstrap procedure; no such repair UI exists.

## Two different integration environments

**Standalone PostgreSQL/PostgREST:** `tests/database/harness.ts` creates a new randomly named database on a supplied loopback-only admin connection, installs `tests/database/bootstrap.sql`, applies each migration transactionally in lexical order, starts a real PostgREST binary, runs SQL/HTTP tests, then drops only its generated database. Use a dedicated disposable cluster: the bootstrap also creates cluster roles. The bootstrap is a minimal Auth SQL interface, not GoTrue, a TOTP implementation or proof of native session issuance. It must never run against a Supabase database. Test-only JWTs use ephemeral keys for actual PostgREST signature checking; they are not product authentication.

```sh
TASKMASTER_TEST_ADMIN_URL=postgresql://blake@127.0.0.1:55436/postgres \
TASKMASTER_POSTGREST_BIN=/tmp/taskmaster-postgrest/postgrest \
npm run test:db
```

Provide your own loopback test admin URL and trusted PostgREST executable if these temporary paths are absent. PostgreSQL must have uuid-ossp and pgTAP installed; UTF-8 with C.UTF-8 was used for recorded parity tests. A missing dependency fails the suite; there is no mocked fallback. Do not send a production connection string: non-loopback hosts are refused, but an SSH tunnel could defeat that safeguard, so the operator must verify the cluster. The temporary trust-authenticated clusters used here bind only loopback and contain synthetic data; trust authentication is unsuitable for shared/production systems.

**Full Supabase stack:** `npm run db:test:supabase` runs the rollback-only `supabase/tests/phase6.test.sql` companion on the CLI-managed stack. Its 18 pgTAP assertions verify schema/grants and SQL claim-based authorization, not the actual TOTP login lifecycle. The final native certification harness below now obtains real Auth-issued AAL1/AAL2 tokens for synthetic users and exercises tables, all three RPCs, owner isolation, command concurrency and receipts through the configured gateway. Phase 7 must add product enrollment/challenge/session lifecycle tests before real task data is exposed. Do not inject the minimal bootstrap into this stack or claim its JWT fixtures prove GoTrue MFA.

## Schema and authorization

Public read-only business tables are `categories`, `groups`, `tasks`, `recurrence_series` and `completion_events`. Composite `(owner_id,id)` keys and same-owner foreign keys isolate relationships. Group/category pairs must match. `normal` remains the persisted Medium priority. Civil deadlines/anchors/occurrence dates use SQL date in 1900–9999; metadata/event instants use timestamptz. Positive revisions and counters stay within JavaScript safe integers. Completion events are append-only; reversal events preserve snapshots. Deletions are tombstones; category/group cascades preserve tasks/history and clear assignments, including disabled series templates and deleted tasks.

Private `sync_state`, `sync_changes` and `sync_receipts` are not directly exposed. All eight tables enable and force RLS with owner = `auth.uid()` and JWT `aal = aal2`. Authenticated users may SELECT the five public tables; anonymous users cannot read them. Direct client writes and service-role direct privileges are revoked. The three entry functions use a NOLOGIN, NOINHERIT, NOBYPASSRLS executor, fixed empty search_path and qualified identifiers. Mutation helpers are invoker functions in a private schema and cannot be called by API roles. The two narrow Auth bridges added by certification are the documented definer exception below. Privileged operators remain a trust boundary. Native MFA assurance claims and their limits are described in [Supabase MFA documentation](https://supabase.com/docs/guides/auth/auth-mfa); function privilege/search-path guidance is in [database functions](https://supabase.com/docs/guides/database/functions).

## Command RPC

`apply_command({command: CloudCommand})` accepts one command object, at most 256 KiB. No batch RPC exists. The envelope mirrors existing durable v1/v2 local commands: operation `id`, owner/device/task identifiers, version, payload, diagnostic base/result metadata; v2 additionally carries reads, changes and dependencies (each array at most 2,000). Creates use result.id and, when enabling recurrence, result.seriesId only for new stable identities. Projection fields never authorize or define server mutations. Local provisional revisions must be resolved to positive canonical server revisions before first transmission; this adapter is Phase 8 work. Local development records remain isolated.

Supported intents:

- Task create/edit (including assignment, due date, priority and recurrence configuration), complete, reopen, confirmed reopen-standalone, delete and restore.
- Category/group create, rename and delete; cascades are discovered on the server and require all affected revisions.
- Recurrence enable/reanchor/disable through create/edit; advance through completion; guarded recurring undo through reopen. There is no independent unchecked advance endpoint.

Owner is derived from the signed JWT, never payload authorization. Unknown versions, fields and meaningful payload types are rejected. Base/result/changes and local-only diagnostics are not executable patches. Each command locks its owner's sync_state row, checks the receipt/fingerprint, validates read revisions/dependencies, applies domain changes, forces deferred invariants, bounds the result and records its receipt in one transaction. Cascades are bounded before iteration; at most 2,000 resulting records and a conservative 2 MiB result budget are permitted (also at most 1,900 assigned tasks in a parent cascade). Oversized cascades reject atomically; do not split them silently or drop their local intent. API resource/rate limits remain an operator responsibility.

Exact JSONB-equivalent retries return the original stored response. Object key order does not matter; changing any envelope value after transmission changes the fingerprint. Reusing an operation ID with another payload returns `validation/operation_id_reused`, preserving the original receipt. Receipts are owner-scoped and retain applied, validation and conflict outcomes indefinitely. No timeout means success: use exact retry or `get_receipt({operation_id})`; absent/inaccessible receipts return null. Do not modify/retry a receipted rejection with the same ID.

Authentication/owner failures return HTTP 401/403 (SQL 42501 for insufficient assurance/owner mismatch). Malformed root bodies, missing/unparseable operation IDs and oversized requests return HTTP 400 without a usable receipt. Validly identified application errors return structured HTTP-200 JSON:

- `applied`: operationId, watermark and ordered canonical changes.
- `conflict/revision_conflict`: operationId and `authoritative: [{kind,id,state}]`. State is the current canonical row, including a tombstone; null means unavailable to this owner. A foreign identity and a nonexistent one are indistinguishable. A missing dependency uses kind dependency and its operation ID, with null state. Mismatched live hierarchy is validation; deleted parents produce a conflict with their tombstone.
- `conflict/already_completed`: compatible competing recurring completion returns canonical event/task/series/successor, submitted time and timestampDisagrees; no second completion or advancement. This explicitly classifies the architecture's earlier special result as a conflict for Phase 6.
- `validation/invalid_command`: stable operationId, SQLSTATE and bounded sanitized message. Constraint messages do not expose task bodies or other owners' records.

Unexpected database/transport errors abort the entire transaction and have no committed receipt; retry unchanged with backoff. Lock waits are bounded at five seconds. The future Phase 8 client must retain conflicts/rejections and their dependent intents, pull current state, and request explicit reconciliation. A reviewed replacement uses a new ID/current revisions; do not silently merge or discard drafts. Conflict snapshots are authoritative at the attempted transaction, not promises of future state. Receipt retrieval does not replace a fresh pull.

## Recurrence guarantees

Enabled series have exactly one nondeleted incomplete linked occurrence at transaction end, enforced by a partial unique index plus deferred graph validation. Owner/UUID/creation and linked occurrence identity cannot be rewritten. Completion/event/successor/series/feed/receipt commit together. Calendar arithmetic matches frozen TypeScript fixtures: daily, anchor weekday weekly, original anchor-day monthly with last-valid-day fallback; successor strictly follows both current scheduled date and frozen series-zone completion date. Missing slots never create history. UUID v5 URL namespace over the compact documented JSON tuple produces deterministic successor/reanchor IDs. Overflow rejects the complete transaction. Device clocks affect the reported civil completion date but never revision precedence.

Owner serialization makes simultaneous completions choose one canonical event/successor. A compatible loser receives already_completed conflict; changed schedule/successor, deleted/reopened task or incompatible bases use ordinary conflicts. Undo requires an untouched successor/current series and no accepted dependent receipt. The server records dependencies from canonical reads plus declared acknowledged dependencies, not forged last-operation diagnostics. Clients must also guard unsent local dependents in Phase 8. Explicit standalone reopen preserves the current series; no silent fallback creates a second occurrence.

## Changes RPC and recovery

`pull_changes({cursor?,watermark?,page_size?})` starts at **0 when cursor is omitted**. Explicit null cursor is invalid. Cursor/watermark are nonnegative integers within the owner's committed counter; cursor must not exceed watermark and watermark must not exceed current committed sequence. Omitted/null watermark captures the current committed boundary; hold it unchanged throughout pagination. Page size is 1–500 (default 500, null invalid). Results contain protocolVersion, cursor, watermark, hasMore and full canonical changes ordered by sequence. The contiguous page prefix is also bounded to a conservative 1 MiB. Empty initial feed returns zeros/false/empty; caught-up feed retains its cursor. Invalid bounds return HTTP 400 without advancing anything.

The owner counter is transactional, not a free-running SQL sequence. All writers take the same owner row lock until commit. Writer B cannot allocate a later owner sequence before A commits or rolls back; rolled-back increments disappear. A stable read uses one snapshot for both the captured counter and its feed rows. Thus a committed watermark never includes a gap from a still-uncommitted lower writer. The delayed-writer test demonstrates this on both tested PostgreSQL majors. See PostgreSQL's [row locking semantics](https://www.postgresql.org/docs/17/explicit-locking.html). Different owners have separate counters and independently progress.

Persist page rows and returned cursor atomically in the eventual account IndexedDB; interrupted downloads retry the same page, and writes after a captured watermark arrive next round. A client deliberately supplying a higher valid owner cursor asks to omit that earlier prefix; cursors are checkpoints, not proof of client persistence. Never advance from a command acknowledgement watermark alone: it may span changes from another device. Pull the intervening feed first. No feed/receipt/tombstone compaction exists in v1; bootstrap replays from zero. Future retention changes require a protocol epoch and safe rebootstrap preserving pending intent. Administrative account erasure is separate privileged work, not a client hard-delete endpoint.

## Hosted setup and deployment precautions

No hosted project has been created or changed. When separately authorized, create a dedicated nonproduction Supabase project in the approved region; confirm PostgreSQL version, uuid-ossp placement, supported role membership/ownership and Auth settings. Enable email verification and native TOTP; restrict callback URLs exactly. Never disable AAL2/RLS to make onboarding work. MFA recovery remains fail-closed until an approved operator process exists.

Review all seven migrations and the security report in a disposable full stack, rehearse backups/restore and additive upgrades, inspect Supabase security advisors and enumerate final grants/default grants/function owners before release. For an explicitly selected hosted test project, operators may use `npx supabase link --project-ref <approved-test-ref>` then `npx supabase db push --dry-run`, review the output, and apply only with deployment authorization. Do not run these commands merely to validate local code. Keep privileged credentials out of shell history/artifacts. Never deploy the test bootstrap or reset a hosted database. Roll back clients while preserving schema/data, and fix database defects with forward migrations.

Current implementation/test status and exact counts are in IMPLEMENTATION_PLAN.md. The former Docker blocker is resolved and native certification is recorded below. Phase 7 still requires explicit approval before real application account access.

## Final native certification

Native certification now runs against the CLI-managed PostgreSQL 17.11 stack, GoTrue 2.197.0, PostgREST 16.5 and Kong 2.8.1. Docker Desktop 29.8.0 is accessible from WSL. The original four migrations applied on a new Taskmaster volume; certification then identified and repaired native privilege differences using three forward migrations. The original four files were preserved byte-for-byte.

5. `20261024000500_native_auth_boundary.sql`: two private, argument-free, fixed-search-path bridges read native auth.uid() and the JWT assurance claim. Executor functions/policies use those bridges; authenticated read policies still call native Auth accessors directly.
6. `20261024000600_auth_call_parity.sql`: covers remaining compact Auth-call spellings in the cascade guard without editing an applied migration.
7. `20261024000700_default_privileges.sql`: removes API-role default table/sequence privileges for future objects created by the migration role and executor in Taskmaster schemas.

Supabase's normal postgres migration role cannot grant USAGE on the managed auth schema. The earlier grant is ineffective there, despite succeeding in the standalone superuser fixture. This is documented in [Supabase's custom-role Auth guidance](https://supabase.com/kb/troubleshooting/permission-errors-when-granting-custom-roles-access-to-the-auth-schema). The bridges follow its narrow definer option. They are owned by the migration administrator and return only request identity/assurance; they have no parameters, business-table reads/writes or API-role execution grants. All business RPCs remain owned by the non-bypass executor, with no authenticated-role inheritance. No broad managed schema/role privilege was added.

Native Supabase also retained default TRUNCATE/REFERENCES/TRIGGER/MAINTAIN table grants and sequence UPDATE grants for API roles even with automatic exposure disabled. Existing Taskmaster tables were already explicitly revoked; migration 007 closes the future-object defaults. Platform supabase_admin defaults remain platform-controlled; create Taskmaster objects under the reviewed migration role, not platform administration roles, and audit every future migration.

A clean local rebuild of all seven migrations was performed only after verifying this session's new project-labeled volume contained zero Auth users and zero business records. Other Docker projects/volumes and browser IndexedDB were untouched. The native REST schema setting is public only; the extra lookup path is public,extensions. Private-schema requests are rejected. Native SQL tests independently inspect forced RLS, grants, owners, exact bridge bodies and search paths.

Reproduce native gateway certification after verifying that the local Taskmaster stack is disposable:

```sh
npm run db:start
npx supabase migration up --local
npm run db:test:supabase
TASKMASTER_NATIVE_CONFIRM_DISPOSABLE=taskmaster npm run test:db:native
npm run check
npm run test:e2e
```

The native harness reads local CLI status in memory, rejects non-loopback targets and unexpected ports/major versions, and never loads bootstrap.sql or resets a database. It creates three random synthetic identities through GoTrue's admin API with confirmed test email, signs in through the password endpoint (AAL1), enrolls native TOTP, rejects an incorrect code, verifies a valid authenticator code (AAL2), and checks the native user profile's verified factor. All successful gateway requests use GoTrue-issued tokens. Manually constructed JWTs are used only for negative signature tests. Cleanup deletes only identities created in that run and their cascading test data. No existing user is deleted. Session tokens, passwords, QR/seed values and privileged keys stay in process memory; assertion failures suppress sensitive Auth response bodies. CLI status/start output can contain local test keys: never print or commit it, and keep any temporary capture private/redacted.

OTPAuth 9.5.2 and its pinned noble/hashes dependency are development-only authenticator fixtures, avoiding custom OTP cryptography. No SDK, auth UI, product MFA implementation or runtime dependency was added. npm install audited 526 packages with zero vulnerabilities. This verifies native MFA as the database certification prerequisite; Phase 7 still owns registration/email delivery, recovery, session-refresh/logout and account-cache UI/lifecycle tests.

Exact final counts and commands are recorded in IMPLEMENTATION_PLAN.md. Native local certification does not certify an uncreated hosted project, a production gateway, client synchronization or the full product release. Repeat the native gates after database/Auth/image changes; hosted deployment remains separately authorized.
