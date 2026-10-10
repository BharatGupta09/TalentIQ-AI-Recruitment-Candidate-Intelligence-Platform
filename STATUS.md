# Build status

## Verified (2026-10-10)

| Check | Where | Result |
|---|---|---|
| `tsc --noEmit` | local, CI | clean |
| Scoring engine suite | local, CI | 23 |
| Authorization suite | local, CI | 80 |
| PDF ingestion suite | local, CI | 32 |
| AI layer suite (mocked provider) | local, CI | 50 |
| Migration / credential / secrets suite | local, CI | 76 |
| Embedded-select suite | local, CI | 42 |
| **Integration suite (real PostgreSQL, as `tip_app`, RLS enforced)** | PostgreSQL 17 locally and in CI | **127** |
| `db:migrate` twice, `db:setup-role`, `seed` twice (idempotent; refuses non-demo databases) | PostgreSQL 17 locally and in CI | pass |
| OpenNext Cloudflare build + `wrangler deploy --dry-run` | local, CI | ~1.7 MiB gzipped |
| Live HTTP suite against the **Worker in `workerd`** (`wrangler dev`) | local, CI | 43 |
| Sign-in for every seeded role, recruiter/candidate/admin pages, throttling (429), scheduled cron handler, R2-less upload (503) | Worker in `workerd`, local | pass |

**473 assertions.** `npm test` runs the static suites; `npm run test:integration`
and `npm run test:http` need a database and a running server (CI provides both).

"Real PostgreSQL" here is a stock PostgreSQL server reached through
`@neondatabase/serverless` and a local WebSocket proxy (`scripts/dev/wsproxy.mjs`),
connected as the non-owner `tip_app` role. It is the same driver, SQL, roles and
policies as on Neon, but **not Neon itself**. Earlier development (commit
`2bd713e`, 2026-09-16) reports running the integration suite against a Neon
database; that run was not repeated in this pass.

## Fixed in this pass

- **Runs on Cloudflare Workers.** OpenNext adapter, `wrangler.jsonc`
  (`talentiq-demo`), and a Worker entry that keeps the daily queue drain as a
  cron trigger. Workers cannot reuse a WebSocket across requests, so each
  transaction opens its own connection there; Node keeps its pool.
- **Passwords are hashed by PostgreSQL** (pgcrypto bcrypt, cost 10) instead of
  scrypt in the app, which would have exceeded the Workers Free plan's 10 ms CPU
  budget. Existing scrypt hashes still verify and are upgraded on sign-in.
- **Sign-in throttling** (migration 0003): 5 failures per email and client
  address, 30 per address and 100 per email per 15 minutes. There was none.
- **Template secrets were accepted.** `.env.example`'s
  `AUTH_JWT_SECRET=REPLACE_WITH_A_LONG_RANDOM_STRING` passed the 32-character
  check, so a deployment configured from the template would sign sessions with
  a public key (anyone could forge any user). The same held for
  `AI_WORKER_SECRET` and the seed passwords. Placeholders are now refused
  everywhere (`lib/secrets.ts`).
- **The Cloudflare build bundled local secrets.** OpenNext copies `.env`,
  `.env.local` and `.env.production*` into the Worker, and the documented setup
  kept the owner connection string and seed passwords in `.env.local`. Local
  values now live in `.dev.vars` (never deployed), and `cf:build` refuses to run
  if those `.env*` files hold anything but `NEXT_PUBLIC_*` or `GROQ_MODEL`.
- **Migrations had no ledger**: `db:migrate` refused any non-empty database and,
  with `--force`, re-ran every file. It now records applied files with
  checksums, applies only new ones and refuses edited ones.
- **The seed was not idempotent** (each run added jobs and resumes) and had no
  guard against real databases. Both fixed.
- **Recruiters' role lists showed other recruiters' active jobs**: the public
  job-board policy lets everyone read active jobs, and the recruiter pages relied
  on RLS alone. They now filter by owner (applications were never exposed).
- **Any signed-in user could drain up to 10 AI jobs per call**, spending the
  Groq quota. Only a secret holder can now; users drain one.
- Resume upload and viewing answer a clear `503` when R2 is not configured.

## Defects found by earlier phases

### 1. The application was bypassing row-level security entirely

Neon issues `neondb_owner`, and that role carries the `BYPASSRLS` attribute.
`BYPASSRLS` overrides row-level security unconditionally — including `FORCE ROW
LEVEL SECURITY`. Connected as the owner, all ~100 policies were inert. The fix
restores the shape Supabase had: `scripts/db-setup-role.ts` provisions
`tip_app` — `NOBYPASSRLS`, not an owner, no `CREATE` on the schema — and the
owner connection is used only for migrations.

### 2. The auth path could not satisfy its own policies

Registration writes `profiles` and `candidate_profiles`; under Supabase that
came from a `SECURITY DEFINER` trigger. With RLS genuinely enforced, every
password would have appeared wrong and `ON CONFLICT DO NOTHING` inserts failed.
Four policies gated on the transaction-scoped `app.auth_op` flag fixed it.

### 3. NUMERIC arrived as two different types

node-postgres decodes `numeric` as a string; `jsonb_build_object` emits a JSON
number. `lib/db/pool.ts` registers a type parser for OID 1700.

## Architecture

PostgreSQL is reached through Neon's serverless driver. Every query runs inside
its own transaction carrying `SET LOCAL app.user_id`, which keeps the RLS
policies authoritative. A PostgREST-compatible query builder sits in front, so
the existing call sites were not rewritten; embedded selects compile to
correlated `jsonb` subqueries.

The app is Next.js 15 built for Cloudflare Workers with `@opennextjs/cloudflare`.
Sessions are HS256 JWTs in httpOnly cookies; middleware verifies the signature
locally. Passwords are bcrypt hashes computed and compared by PostgreSQL.

Resumes live in a private Cloudflare R2 bucket reached over the S3-compatible
API with presigned URLs. This integration is optional and unverified (below).

## Not built / not verified

- **Never deployed to Cloudflare.** Everything above ran locally and in CI. No
  Worker has been created, so production behaviour (including the CPU limit
  below) is unconfirmed.
- **Workers Free CPU limit (10 ms per request).** Server-rendering a Next.js page
  can exceed it (error 1102). This cannot be measured without a deployment; if
  it occurs, a paid Workers plan would be needed, which this project does not
  assume.
- **R2 is unverified.** No upload or download has been made against a real
  bucket, and enabling R2 on a Cloudflare account may involve billing details.
  Without it, resume upload and viewing answer 503; seeded resumes are text.
- **Groq is unverified.** No real AI call has been made; the AI suite uses a
  mocked provider. Without a key, AI jobs fail with "not configured".
- **Not tested against Neon in this pass** (see above).
- **Next.js bundles postcss 8.4.31**, which has advisories that need
  attacker-controlled CSS; it only processes this app's own stylesheets at build
  time. Clearing it needs Next.js 16. Other `npm audit` findings are dev-only
  tooling (eslint-config-next, tailwind 3).
- **OpenNext on Windows is best-effort** (its own warning). Local Windows builds
  work; CI builds on Linux.
- **Storage cleanup on hard-deleted candidates** is not implemented; orphaned
  objects would accumulate. Irrelevant at demo scale.

## Honest read

The database and authorization layers are the proven part: built from empty,
exercised as a non-owner role with RLS enforced, and run inside Cloudflare's
own runtime. What remains unproven is everything that needs an account: a
Cloudflare deployment, Neon itself in this pass, R2 and Groq.
