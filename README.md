# AI Resume Screening & Talent Intelligence Platform

> **Public showcase repository with fictional demo data. No live deployment.**
> An earlier demo ran on Supabase and Vercel. The platform now runs on Neon
> PostgreSQL and Cloudflare Workers (Free plans), and is verified locally: the
> Worker runs in Cloudflare's runtime (`workerd`) against a real PostgreSQL in
> CI. It has not been deployed to Cloudflare, and the optional R2 (resume PDF)
> and Groq (AI) integrations have not been exercised against the real services.
> See [`STATUS.md`](./STATUS.md) for exactly what is and is not proven.

An evidence-first recruitment platform. Every claim it makes about a candidate
is traceable to the line of the resume it came from.

<!-- Add screenshots here once deployed:
![Landing page](./docs/screenshot-landing.png)
-->

---

## The problem

Most resume screeners infer. A resume that says *"worked with cloud
technologies"* becomes an AWS qualification, and a recruiter acts on something
the candidate never actually claimed.

This platform refuses to infer. That phrase resolves to **not demonstrated**,
and becomes a question for the interview rather than a false credential.

Every requirement is resolved to one of exactly three states, and the two
positive states must carry the phrase from the resume that supports them:

| State | Meaning |
|---|---|
| **Demonstrated** | The resume explicitly supports this. Evidence quoted. |
| **Insufficient evidence** | Hinted at, but not established. Evidence quoted. |
| **Not demonstrated** | Not supported by the source at all. |

When the model is uncertain, it is instructed to choose the weaker state.
Under-claiming is treated as correct; over-claiming is treated as a failure.

---

## How an assessment is produced

```
Job posting
    ↓  AI extracts discrete, individually assessable requirements
Specification  (required / preferred / nice-to-have)
    ↓  AI assesses the resume against each one, citing evidence
Evidence states
    ↓  Deterministic scoring engine — fixed arithmetic, no model involvement
Score + full breakdown
    ↓  Recruiter reviews the matrix beside the original PDF
Decision  (stored separately; never overwrites the assessment)
```

**The language model never produces the score.** It supplies evidence states
and one bounded 0–1 semantic signal. A scoring engine then applies importance
weights and role-specific dimension weights using plain arithmetic.

This matters because language models are not consistent — ask twice, get 84
then 79. A recruiter cannot defend a decision on that basis, and in many
jurisdictions a rejected candidate can ask why. Fixed arithmetic gives the same
number for the same input, every time, with the breakdown visible on screen.

---

## Engineering notes

**Authorization is enforced in the database, not the interface.** 78
row-level security policies mean an unauthorized API call returns nothing even
if a UI check were bypassed. The API-layer guards are a second line, not the
only line.

**Recruiters cannot browse candidates.** There is no global talent pool. A
candidate becomes visible to a recruiter only by applying to that recruiter's
specific role — enforced by a policy that joins through job ownership.

**Applications snapshot their job specification at submission.** Editing a role
later cannot retroactively change an assessment that has already been made.

**The AI queue survives provider outages.** Exponential backoff, `Retry-After`
support, and partial-result preservation. A failed analysis never destroys an
uploaded file — the record degrades to a recoverable state instead.

**Cross-tenant access returns 404, not 403**, so application IDs cannot be
probed for existence.

**Over 470 automated assertions** across the scoring engine, authorization model,
PDF handling, AI behaviour, the database (127 against a real PostgreSQL with RLS
enforced) and live HTTP responses from the Cloudflare Worker.

---

## Architecture

```
Cloudflare Worker (OpenNext) ──► Next.js App Router: API routes / server components
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
            Neon          Scoring         Groq
          Postgres        engine       (LLM only)
        + Cloudflare  (deterministic)
              R2
```

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15, React 19, TypeScript | Server components keep secrets server-side by construction |
| Database | Neon PostgreSQL, serverless driver | Row-level security moves authorization below the API |
| Object storage | Cloudflare R2, private bucket (optional) | Presigned direct upload keeps PDF bytes off the Worker; only resume upload/viewing need it |
| AI | Groq | Fast inference on a free tier; abstracted behind one service module |
| Validation | Zod | Model output is schema-validated before it can reach the database |
| Styling | Tailwind CSS | — |
| Hosting | Cloudflare Workers (Free) via `@opennextjs/cloudflare` | Static assets free and unlimited; passwords hashed by PostgreSQL so the Worker stays within its CPU budget |

### Project structure

```
app/                    Pages and API routes
  api/                  25 route handlers
  candidate/            Candidate workspace
  recruiter/            Recruiter workspace
  admin/                Administration
lib/
  ai/                   Groq client, prompts, queue, service layer
  scoring/engine.ts     Deterministic scoring — the core of the product
  auth/                 Password hashing, JWT sessions, server-side guards
  db/                   Pool, transaction-scoped identity, query builder,
                        embedded-select compiler, user/service clients
  storage/r2.ts         Cloudflare R2 via the S3-compatible API
  resume/pdf.ts         PDF validation and extraction
db/migrations/          Schema (29 tables), RLS policies, sign-in throttling
cloudflare/worker.ts    Worker entry: the OpenNext app plus the daily queue-drain cron
scripts/                Migrations, role setup, seed, test suites, local WebSocket proxy (dev/)
wrangler.jsonc          Cloudflare Worker configuration (talentiq-demo)
```

---

## Running it yourself

Requires Node.js 22 or later (CI uses 22; also tested with 24) and a PostgreSQL
database: a free Neon project, or any local PostgreSQL 16+ through the bundled
WebSocket proxy. Cloudflare (to deploy), Groq (AI) and R2 (resume PDFs) are
optional. All demo data is fictional.

```bash
npm ci
cp .dev.vars.example .dev.vars     # PowerShell: Copy-Item .dev.vars.example .dev.vars
```

Fill in `.dev.vars` (git-ignored, never deployed). Keep secrets out of `.env*`
files: the Cloudflare build copies those into the Worker, and `npm run cf:build`
refuses to run if they contain any. Then apply the schema and provision the
least-privilege application role:

```bash
npm run db:migrate
npm run db:setup-role
npm run seed                       # optional fictional demo data (refuses databases with real accounts)
```

`db:setup-role` matters: Neon's owner role carries `BYPASSRLS`, which switches
off every RLS policy in the schema. The application must connect as `tip_app`.
See [`DEPLOY.md`](./DEPLOY.md) section 0. Migrations are recorded in a ledger,
so `db:migrate` is safe to repeat.

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server with `.dev.vars`, http://localhost:3000 |
| `npm run cf:preview` | Build for Cloudflare and run the Worker in `workerd`, http://localhost:8787 |
| `npm run cf:deploy` | Build and deploy the `talentiq-demo` Worker (see DEPLOY.md first) |
| `npm test` | Static suites: scoring, authorization, PDF, AI, migration, embedded selects |
| `npm run test:integration` | 127 checks against the configured PostgreSQL, as `tip_app` |
| `BASE_URL=http://127.0.0.1:8787 npm run test:http` | 43 HTTP checks against a running server (bash) |
| `npm run db:wsproxy` | WebSocket proxy so the Neon driver can reach a local PostgreSQL |

**Demo accounts** (after `npm run seed`): `admin@demo.internal`,
`recruiter@demo.internal`, `recruiter2@demo.internal` and
`candidate@demo.internal` … `candidate5@demo.internal`. Their passwords are the
`SEED_PASSWORD_*` values you chose. They are fictional, demo-only accounts.

**Known limitations**

- Resume PDF upload and viewing need Cloudflare R2, which is optional and has
  not been tested against a real bucket. Without it they answer
  "storage not configured"; seeded resumes are text-only.
- AI analysis needs a Groq key; without one, analyses stay queued or fail with a
  clear "not configured" error, and no scores are produced.
- Workers Free allows 10 ms of CPU per request. Whether every Next.js page stays
  within it can only be confirmed by a deployment, which has not been done.

Full deployment walkthrough and troubleshooting: [`DEPLOY.md`](./DEPLOY.md).
Honest scope notes, including what is *not* built: [`STATUS.md`](./STATUS.md).

---

## Responsible use

This is decision support, not decision automation.

- No candidate is ever automatically rejected — not for a low score, a missing
  requirement, or a match category.
- The recruiter's decision is stored separately from the AI assessment, so a
  deliberate disagreement between the two stays visible rather than being
  erased.
- The model is instructed never to infer or comment on age, gender, ethnicity,
  nationality, religion, marital status, disability or health, and never to
  treat a name or institution as a proxy for them.
- Every recruiter-facing AI output carries a disclosure of what it was
  generated from.

---

## Licence

All rights reserved. Available to view for evaluation purposes.
