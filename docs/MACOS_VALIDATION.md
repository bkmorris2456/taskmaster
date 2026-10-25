# macOS baseline validation — 2026-10-25

Project root: `/Users/bmorris56/repos/taskmaster`. The initial Git working tree was clean at `fd4a539`. AGENTS.md, SPEC.md, ARCHITECTURE.md, IMPLEMENTATION_PLAN.md, package.json, package-lock.json and supabase/config.toml are present. Source and tests cover the Phase 1–5 local application and Phase 6 database/RPC boundary. All seven migration files remain unchanged. No Windows/WSL path or dependency directory was reused.

## Tooling and installation

- macOS 26.5, Apple silicon (`arm64`).
- Node 24.21.0 matches `.nvmrc` and the package engine range.
- System npm 12.2.1 is outside the required npm 11 range. `npx --yes --package=npm@11 npm ci --fetch-retries=0` used npm 11.21.1 without changing global npm. The initial npm 12 install succeeded with an engine warning; the npm 11 clean install replaced it. Both reported zero audit vulnerabilities. Dependency versions and lockfile are unchanged.
- Docker Desktop is installed; engine 29.8.1 was started. The initial daemon was stopped. An unrelated `command-center-postgres` container/volume was left untouched.
- Project-local Supabase CLI 2.122.0 runs on this Mac.
- Homebrew libpq provides psql 18.3 at `/opt/homebrew/opt/libpq/bin/psql`. Add `/opt/homebrew/opt/libpq/bin` to PATH for the native harness; a PostgreSQL 18 client successfully tested the configured PostgreSQL 17 server.
- Playwright 1.64.1 needed Chromium revision 1248; the existing revision 1228 belonged to another installation. `node_modules/.bin/playwright install chromium` installed the required macOS Chromium, headless shell and FFmpeg.
- Git author name/email are configured. `core.ignorecase=true`; no Git configuration was changed.
- Git 2.48.1; branch `main`, tracking `origin/main`; origin is `git@github.com:bkmorris2456/taskmaster.git`. The follow-up inspection preserved the four validation changes listed below.
- Docker Compose v5.5.1 is available. The daemon reports 10 CPUs and 8,319,504,384 bytes of memory; the host has approximately 697 GiB free disk space. The full stack starts successfully with these resources.

The install/browser commands follow the official [Supabase CLI setup](https://supabase.com/docs/guides/local-development/cli/getting-started) and [Playwright browser installation](https://playwright.dev/docs/browsers) documentation. No dependency upgrade was needed.

## Local database safety and checks

Before startup, Docker inventory contained no Taskmaster containers or volumes, and no listeners occupied ports 54320–54324. The existing config retains PostgreSQL 17, public-only REST exposure, email confirmation, native TOTP and disabled seeds. `supabase start` created a fresh local Taskmaster stack and applied migrations 001–007. A transient image-registry rate-limit message did not prevent startup. `supabase migration list --local` confirmed all seven versions applied.

No reset, hosted link, production connection, bootstrap fixture or migration edit was performed. Startup output was captured outside the repository because it can contain local keys. The local stack remains running; stop it with `npx supabase stop` when finished, without data-deleting flags.

Validation results:

- `npm run check`: typecheck, ESLint, Prettier, 180 unit tests across nine files and standard production build passed after the test correction below.
- `node_modules/.bin/supabase test db`: all 18 rollback-only pgTAP assertions passed.
- `PATH=/opt/homebrew/opt/libpq/bin:$PATH TASKMASTER_NATIVE_CONFIRM_DISPOSABLE=taskmaster npm run test:db:native`: all 84 native database/API tests passed. These exercise actual GoTrue password/TOTP sessions, AAL1/AAL2, RPCs, owner isolation, grants and transactional invariants. The harness removes only its generated synthetic identities and data.
- The standalone `npm run test:db` fixture mode was not run: no dedicated standalone PostgreSQL/PostgREST fixture was provisioned. Native certification ran instead against the real local Supabase stack; the minimal Auth fixture was never substituted for it.

Sandbox restrictions initially blocked the CLI user-directory initialization, Docker socket, network downloads and Playwright preview-port binding. Those operations were rerun with approved host permissions. These were environment restrictions, not application defects.

## Browser baseline correction

The first runnable browser suite produced 67 passes and two failures in the same draft-discard test (desktop/mobile). The trace showed that navigation during the preceding validation's busy state was blocked without a dialog. Its unused one-shot dialog listener then collided with the Cancel dialog listener. The test now waits for the create control to become enabled and asserts the navigation confirmation message. This preserves the existing draft-retention behavior and strengthens the assertion; application code is unchanged.

Final `npm run test:e2e` result: all 69 tests passed in 30.3 seconds. Browser coverage is desktop and emulated mobile Chromium, including offline persistence and the standard production synthetic-workspace boundary; this does not certify Safari or native mobile installation.

## Phase boundary

The latest instruction explicitly limits work to environment validation. No Phase 7 application implementation or Phase 8 synchronization work was started. No product semantics or architecture changed.

## Development workflow and final assessment

`npm run dev -- --port 5173 --strictPort` started Vite successfully. An isolated Playwright Chromium context loaded `/list`, `/categories` and `/date`, waited for the local-workspace status, and confirmed the labeled synthetic IndexedDB database initialized. No page errors occurred. The browser and temporary Vite process group were closed, and a port inspection confirmed no listener remained on 5173. Existing application data was not reset. The production and local-preview builds were also exercised by the 69 passing browser tests. Supabase config loaded through the CLI and its native tests; the current Phase 6 application intentionally has no Supabase client or real account access.

Test totals: unit 180 passed / 0 failed / 0 skipped; browser 69 passed / 0 failed / 0 skipped; native integration 84 passed / 0 failed / 0 skipped; native pgTAP 18 passed / 0 failed / 0 skipped. Standalone fixtures were not run, so their historical 82 passed / 2 skipped result is not a macOS result. This Mac lacks a dedicated standalone cluster and PostgREST executable; no separate PostgreSQL server was installed.

Changes from the original clean clone:

- `tests/e2e/tasks.spec.ts`: baseline test synchronization and explicit confirmation assertion only, made during the earlier validation before the follow-up instructions; retained without further test changes.
- `docs/SUPABASE.md`: platform-neutral Docker/browser requirements and macOS report link.
- `IMPLEMENTATION_PLAN.md`: macOS baseline evidence.
- `docs/MACOS_VALIDATION.md`: this report.

Tools/actions: clean macOS node_modules installation using the existing lockfile and npm 11.21.1 through npx; matching Chromium/headless-shell/FFmpeg browser downloads; Docker Desktop startup; fresh project-local Supabase containers/images and disposable volume. Node, global npm, Git, Docker, Compose, libpq and the pinned Supabase package were not upgraded. No shell-profile or machine-specific configuration was committed. No commit or push was made.

**READY WITH LIMITATIONS**: native Supabase and application baseline gates pass. Standalone fixture mode remains unverified on macOS. System npm remains 12.2.1; use `npx --yes --package=npm@11 npm ci` for installs or select npm 11 in the development shell. Native SQL tests need `/opt/homebrew/opt/libpq/bin` on PATH. No observed application/security failure blocks continued development, but Phase 7 remains unauthorized. Local Docker ports use the CLI's default all-interface bindings; no hosted resources were accessed or deployment security certified.
