# Deployment runbook — Neon + Cloudflare Workers (+ optional R2 and Groq)

Target: **Neon Free** (PostgreSQL) and **Cloudflare Workers Free** (the Next.js
app, built with the OpenNext adapter). Cloudflare R2 (resume PDFs) and Groq (AI
analysis) are optional integrations; everything else works without them.

Commands are the same in PowerShell unless a PowerShell form is shown.
Local values live in `.dev.vars` (copy `.dev.vars.example`); it is git-ignored
and never deployed. **Do not put secrets in `.env`, `.env.local` or
`.env.production`**: the OpenNext build copies those files into the Worker, and
`npm run cf:build` refuses to run if they hold anything but `NEXT_PUBLIC_*` or
`GROQ_MODEL`.

---

## 0. The one rule that matters most

**The application runtime must never connect to PostgreSQL as the database
owner.**

Neon issues `neondb_owner`, and that role carries the `BYPASSRLS` attribute.
`BYPASSRLS` overrides row-level security unconditionally — including `FORCE ROW
LEVEL SECURITY`. An application connected as the owner has all ~100 policies in
`db/migrations/0002_rls.sql` silently switched off. No error, no warning; every
user simply sees every row.

| Role | Used for | RLS |
|---|---|---|
| `neondb_owner` | migrations and schema maintenance only (`DATABASE_URL_OWNER`, local) | bypasses (by design) |
| `tip_app` | the application runtime (`DATABASE_URL`, Worker secret) | **fully subject to policies** |

`scripts/db-setup-role.ts` provisions `tip_app` with `NOBYPASSRLS`, no
ownership of any table and no `CREATE` on the schema, and refuses to finish if
the role ends up with `BYPASSRLS`.

---

## 1. Neon (Free plan)

1. Create a project at neon.tech (any region; at the time of writing the Free
   plan asks for no payment method).
2. Copy the **direct** (non-pooler) connection string of `neondb_owner` into
   `.dev.vars` as `DATABASE_URL_UNPOOLED`, and the **pooled** one as
   `DATABASE_URL`.
3. Apply the schema, then create the application role:

```bash
npm run db:migrate
npm run db:setup-role
npm run db:migrate      # safe to repeat: prints "migrations up to date"
```

`db:migrate` applies `db/migrations/*.sql` in order, once each, recording them
in `tip_migrations.applied` (a schema the application role cannot read). A file
edited after it was applied is refused; add a new numbered migration instead.
Nothing in it drops or truncates anything. A database set up before the ledger
existed (0001 and 0002 applied) is recognised and recorded.

`db:setup-role` creates `tip_app`, rewrites `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` in `.dev.vars` to that role and keeps the owner string
as `DATABASE_URL_OWNER` for future migrations. It never prints the password.
Re-running it **rotates** the `tip_app` password, so update the Worker secret
afterwards.

4. Check, as the owner (Neon SQL editor):

```sql
select tablename from pg_tables where schemaname = 'public' and rowsecurity = false;  -- zero rows
select rolbypassrls from pg_roles where rolname = 'tip_app';                         -- f
```

Driver notes: the app uses `@neondatabase/serverless` over WebSockets, which
works from Workers without TCP sockets or Hyperdrive. `sslmode=require` and
`channel_binding=require` may stay in the copied strings. The Free plan scales
compute to zero after 5 idle minutes; the first request afterwards waits for a
cold start.

---

## 2. Demo data (optional)

Set `SEED_PASSWORD_CANDIDATE`, `SEED_PASSWORD_RECRUITER` and
`SEED_PASSWORD_ADMIN` in `.dev.vars` (your own, 12+ characters; the template
placeholders are refused), then:

```bash
npm run seed
```

It creates eight fictional `@demo.internal` accounts, five candidate profiles
and resumes (text only, no PDF), four roles and nine applications, and queues
the AI analyses. It is idempotent (a re-run adds nothing and queues nothing
new) and **refuses any database that has an account outside `@demo.internal`**,
so it cannot be pointed at a database with real users. Anyone who knows the seed
passwords can sign in as the demo admin: use your own and share them
deliberately.

---

## 3. Groq (optional)

console.groq.com, API Keys, Create. `GROQ_API_KEY` is the key; `GROQ_MODEL`
defaults to `llama-3.3-70b-versatile` (`wrangler.jsonc` vars). The free tier is
rate-limited, which is why `lib/ai/service.ts` queues work with backoff and
honours `Retry-After`. **Without a key** the queue cannot run: draining marks a
job `failed` with "GROQ_API_KEY is not configured" (an admin can retry it later
from the AI page), and no scores are produced.

---

## 4. Cloudflare R2 (optional, not verified)

Only resume PDF **upload** and **viewing** use R2 (`lib/storage/r2.ts`, S3 API
with presigned URLs). Without the four `R2_*` values those two endpoints answer
`503 "Resume storage is not configured"`; sign-in, jobs, applications, scoring,
pipeline, admin and seeded resumes (text) all work.

This integration has **not** been exercised against a real bucket. Cloudflare may
require R2 to be activated on the account (which can involve billing details)
before a bucket can be created; check that before relying on it. If you enable
it: create a private bucket, an "Object Read & Write" API token scoped to it,
set `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` as
Worker secrets, and add a CORS rule allowing `PUT`/`GET` with header
`content-type` from your Worker's origin (the browser uploads straight to the
presigned URL).

---

## 5. Secrets you generate yourself

```bash
openssl rand -hex 32
```

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

One each for `AUTH_JWT_SECRET` (signs session cookies) and `AI_WORKER_SECRET`
(authenticates the scheduled and manual queue drain). Values shorter than 32
characters, or still the `.dev.vars.example` placeholder, are refused: sign-in
fails closed and the worker answers 401.

---

## 6. Cloudflare Workers (Free plan)

```bash
npx wrangler login        # opens a browser
npx wrangler whoami       # confirm the intended account
```

`wrangler.jsonc` deploys a Worker named **`talentiq-demo`**. Deploying
**replaces** any Worker of that name in the account; rename it first if the name
is taken. Then:

```bash
npm run cf:deploy         # env-file check, OpenNext build, wrangler deploy
npx wrangler secret put DATABASE_URL       # tip_app POOLED string (never the owner)
npx wrangler secret put AUTH_JWT_SECRET
npx wrangler secret put AI_WORKER_SECRET
npx wrangler secret put GROQ_API_KEY       # optional
```

Never set `DATABASE_URL_OWNER` or `SEED_PASSWORD_*` as Worker secrets. The first
deploy may ask you to choose a free `workers.dev` subdomain.

(`vercel.json` is kept only for anyone deploying to Vercel instead; Cloudflare
ignores it. On Vercel, `CRON_SECRET` authenticates its cron.)

**Cron.** `wrangler.jsonc` registers one trigger (`0 3 * * *`, daily). The
scheduled handler in `cloudflare/worker.ts` calls `/api/worker/drain` with
`AI_WORKER_SECRET`. Workers Free allows 5 cron triggers per account; remove the
`triggers` block if none are left. Signed-in users also drain one job at a time
when they act, so the queue does not depend on the cron alone.

**Free-plan fit.** The Worker bundle is about 1.7 MiB gzipped. Passwords are
hashed and checked by PostgreSQL (pgcrypto bcrypt), so sign-in CPU stays in the
database. Static assets are served free and unlimited; 100,000 Worker requests
per day are included. **Not verified:** Workers Free allows 10 ms of CPU per
request, and server-rendering a Next.js page can exceed that, which Cloudflare
reports as error 1102. This could only be confirmed by a real deployment; if it
happens, the remedy is a paid Workers plan, which this project deliberately
does not assume.

---

## 7. Post-deploy verification

- [ ] `/`, `/jobs` and `/login` load; `/jobs` shows only active roles
- [ ] Sign in as each seeded role; sign out
- [ ] As a candidate, visit `/recruiter` and `/admin`: redirected, nothing rendered
- [ ] As recruiter A, open recruiter B's job or application by URL: an error page
      with none of B's data; the matching API calls answer 404
- [ ] Six wrong passwords for one account from one browser: the sixth is `429`
- [ ] `curl -X POST https://<worker>/api/worker/drain` without a token: `401`
- [ ] The runtime is not the owner (Neon SQL editor, connected as `tip_app`):

```sql
select current_user, (select rolbypassrls from pg_roles where rolname = current_user);
```

Most of this is automated: `BASE_URL=https://<worker> bash scripts/test-http.sh`
(43 anonymous checks; needs bash, e.g. Git Bash on Windows).

---

## 8. Local development and checks

```bash
npm ci
cp .dev.vars.example .dev.vars     # PowerShell: Copy-Item .dev.vars.example .dev.vars
npm run dev                        # next dev with .dev.vars, http://localhost:3000
npm run cf:preview                 # the built Worker in workerd, http://localhost:8787
npm test                           # static suites, no database needed
npm run test:integration           # real PostgreSQL: the configured database
```

**Without Neon**: any local PostgreSQL 16+ works through the WebSocket proxy the
driver needs. Run `npm run db:wsproxy` in its own terminal, set
`NEON_LOCAL_WSPROXY=127.0.0.1:5488` and put the local server's owner string in
`DATABASE_URL_UNPOOLED` in `.dev.vars`, then `db:migrate`, `db:setup-role`,
`db:migrate`. CI does exactly this against a PostgreSQL 17 service.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Refusing to build: these variables would be embedded in the deployed Worker` | Move them from `.env*` to `.dev.vars` (local) or Worker secrets (deployed). |
| Every protected page redirects to `/login` | `AUTH_JWT_SECRET` missing, under 32 characters or a placeholder. |
| `DATABASE_URL is not set` | The Worker secret is missing, or `.dev.vars` still holds the template string. |
| A user sees other users' rows | The app is connected as the owner. Use the `tip_app` string (section 0). |
| `REFUSING: the database has N table(s) but no migration ledger` | `DATABASE_URL_OWNER` points at a database not created for this app. |
| `<file> was edited after it was applied` | Revert the edit and add a new numbered migration. |
| `Refused: this database has N account(s) outside the @demo.internal demo domain` | Intended: seed a database created for the demo. |
| `429 Too many failed sign-in attempts` | Wait 15 minutes; it applies to that email from your address. |
| Upload or resume viewer: `503 Resume storage is not configured` | R2 is optional and not set up (section 4). |
| AI jobs `failed: GROQ_API_KEY is not configured` | Set the key, then retry the jobs from Admin → AI. |
| Error 1102 on a deployed page | Exceeded the Free plan's CPU limit (section 6). |
| `WARN OpenNext is not fully compatible with Windows` | Builds work here, but WSL is recommended for production builds; CI builds on Linux. |
| `git clone`: `Filename too long` (Windows) | Clone into a short path or `git config --global core.longpaths true`. |

---

## Cost guardrails

| Service | Free allowance | Watch for |
|---|---|---|
| Neon | 0.5 GB storage, monthly compute hours | Scales to zero after 5 idle minutes |
| Cloudflare Workers | 100,000 requests/day, 10 ms CPU/request, 5 crons/account | CPU limit on heavy pages (unverified) |
| Cloudflare R2 (optional) | 10 GB storage | Account activation may need billing details; not verified here |
| Groq (optional) | Rate-limited free usage | Queue absorbs 429s |
