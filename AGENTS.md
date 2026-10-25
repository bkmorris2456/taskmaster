# Taskmaster engineering instructions

## Authorization and scope

Phase 6 (Supabase PostgreSQL schema, security and transactional commands) is explicitly authorized. Stop after Phase 6; do not begin Phase 7 without approval. Authentication UI, client cloud synchronization and named saved-filter UI are not authorized. Preserve all seven applied migrations and inspect docs/SUPABASE.md and docs/SECURITY_REVIEW.md before database changes. Local native-stack certification has passed; rerun it after database/Auth changes and never substitute the minimal Auth fixture for that gate. View-specific current query preferences are authorized; they never mutate tasks or the outbox. Local data must remain in the labeled synthetic development/local-preview workspace; standard production builds must not enable this harness. Read SPEC.md, ARCHITECTURE.md and IMPLEMENTATION_PLAN.md before changes. Implement only the approved phase and requirements; ask before expanding product scope. Routine implementation choices within an approved phase do not need repeated approval.

Keep Taskmaster a minimal personal task manager. No collaboration, notifications, attachments, AI, rich text, custom backend or saved-filter UI without approval. Prefer a simple module or function over a framework, generic abstraction or extra service. Record material requirement ambiguities and recommendations in documentation; do not silently invent behavior.

## Architecture and organization

Follow ARCHITECTURE.md: React components → feature use cases → transactional local repositories → Dexie; sync adapters alone access remote task APIs. Keep domain recurrence, dates, filter predicates and sorting pure and independently testable. Separate transient UI state from durable task projections. Avoid parallel server caches or direct component writes to Supabase. Use app/, domain/, features/, data/local/, data/remote/ and sync/ boundaries when implementation begins; do not create empty abstractions just to fill the layout.

Build small accessible components organized by feature; extract shared primitives after real reuse. Use native HTML controls, explicit labels, focus management and restrained Tailwind styles. Dark monospace styling must not compromise readability, keyboard controls, screen readers or touch targets.

## TypeScript and dependencies

Enable strict checking, noUncheckedIndexedAccess and exactOptionalPropertyTypes. Avoid any, unexplained non-null assertions, broad casts and ignored errors. Use unknown and validate untrusted boundaries. Prefer discriminated unions for commands/results and explicit date-only/instant types. Persist versioned payloads with typed migrations. Never use client timestamps for conflict precedence or millisecond arithmetic for civil calendar recurrence.

Use the requested stack; pin compatible versions with one committed lockfile after approval. Verify official documentation for the selected versions. Explain each new runtime dependency with its need, bundle/security impact and simpler alternatives. Avoid dependencies for trivial utilities; do not write custom authentication cryptography. No Dexie Cloud, global-state framework or generic sync engine by default.

## Database and synchronization

SQL migrations are versioned, reviewed and forward-compatible; never edit an already applied migration. Use UUID identities, UTC instants, date-only due dates, revision checks, soft deletion and same-owner foreign keys. Enforce invariants in PostgreSQL independently of the client. Every writer must obey per-owner serialized change sequencing and atomic receipts. Retain tombstones, feed and idempotency receipts under v1 retention rules.

Persist local mutation, optimistic projection and outbox atomically. Never await network inside an IndexedDB transaction. Do not drop commands on timeout, validation failure, conflict, auth expiry or schema incompatibility. Keep operation IDs/payloads stable on retries. Incoming state must not overwrite unsent intent. Test cross-tab leadership failure; correctness cannot depend on one leader. Recurrence completion/history/successor creation is one atomic command. Do not introduce last-write-wins or silent merges.

## Security

RLS owner + AAL2 is mandatory for every task-data surface, including change feeds and receipts. Frontend guards are not authorization. Default-deny grants; audit definer functions, fixed search_path, role ownership and bypass risks. Derive owner from auth.uid(); validate all command fields and references server-side. Direct table mutation privileges remain revoked.

Only public Supabase URL/publishable (or legacy anon) key may appear in frontend environment variables. Never commit secrets, service-role keys, production data, access/refresh tokens, passwords, QR/TOTP seeds or task-content logs. All VITE_* values are public. Use an example environment file containing placeholders only after tooling approval. Privileged credentials stay in protected operator/CI environments.

Separate databases by project and account. Stop previous identity workers before switching, reject late async responses and require initial AAL2 before local access. Follow the documented trusted-device offline policy; do not claim encryption or immediate offline revocation. Authenticated API traffic is network-only in the service worker. Avoid raw HTML and unsafe redirects; configure deployment security headers. No bespoke MFA recovery bypass.

## Testing and validation

Use Vitest for pure domain/local/sync tests and Playwright for user flows and multi-context integration. Use real local Supabase SQL/API tests for RLS, grants, AAL1/AAL2 and transaction constraints; mocks cannot prove cloud authorization. Freeze clocks/zones, use deterministic IDs and cover recurrence month ends/leap years/DST/missed dates and cross-runtime parity.

Exercise lost acknowledgements, duplicate operations, delayed commits, concurrent devices, parent deletion, restart mid-sync, auth expiry and account switching. Tests must assert observable invariants and retained user intent rather than mirror implementation. Check keyboard/focus, mobile layout and offline service-worker behavior in production builds. Do not overtest trivial reversible presentation changes, but run all relevant phase gates and existing regression checks.

Before reporting completion, inspect the diff, run applicable validation commands, review security/data-loss implications and update affected documentation. Report exactly which checks ran and results; never claim unrun tests passed. Document blockers and residual risks. Do not overwrite unrelated user changes. No destructive migration, production deployment or privileged recovery action without authorization.

## Documentation and completion

Keep the four root documents consistent when decisions change. SPEC.md owns product semantics; ARCHITECTURE.md owns technical protocol; IMPLEMENTATION_PLAN.md owns phase gates. Document setup, environment variables, commands, migrations, recovery and deploy/rollback as those capabilities are introduced. Do not report a phase complete with missing required tests or unresolved correctness issues. Stop at the authorized phase boundary and provide a concise change/validation summary.
