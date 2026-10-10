/**
 * Migration suite: the compatibility layer, authentication, and identity
 * propagation.
 *
 * These cover the pieces that replaced Supabase. They run without a database:
 * the query builder is driven by a fake runner that captures the SQL it would
 * have executed, and returns whatever rows the test wants. That is deliberate
 * — the properties being asserted here are about the statements produced and
 * the result shapes returned, both of which must hold before any database is
 * involved.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryBuilder } from '../lib/db/builder';
import { DUMMY_HASH, hashSql, isLegacyHash, verifyLegacyPassword } from '../lib/auth/password';
import { usableSecret } from '../lib/secrets';
import { scrypt, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
function section(title: string) { console.log(`\n[${title}]`); }

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

/* ------------------------------------------------------------------ */
/* A fake runner: captures SQL, returns canned rows.                    */

interface Captured { text: string; values: unknown[] }

function fake(rows: Record<string, unknown>[] = [], sink?: Captured[]) {
  return (<R,>(fn: (client: any) => Promise<R>): Promise<R> =>
    fn({
      query: async (text: string, values: unknown[] = []) => {
        sink?.push({ text, values });
        return { rows, rowCount: rows.length };
      },
    })) as never;
}

const qb = (table: string, rows: Record<string, unknown>[] = [], sink?: Captured[]) =>
  new QueryBuilder(fake(rows, sink), table);

/* ================================================================== */
async function main() {
  section('single() semantics');

  {
    const one = await qb('jobs', [{ id: 'a' }]).select('id').eq('id', 'a').single();
    check('exactly one row -> the row', one.error === null && (one.data as any)?.id === 'a');

    const none = await qb('jobs', []).select('id').eq('id', 'x').single();
    check('zero rows -> error, data null',
      none.error !== null && none.data === null, JSON.stringify(none.error));
    check('zero rows -> PGRST116, matching PostgREST',
      none.error?.code === 'PGRST116', String(none.error?.code));

    const many = await qb('jobs', [{ id: 'a' }, { id: 'b' }]).select('id').single();
    check('multiple rows -> error, never an arbitrary row',
      many.error !== null && many.data === null);
  }

  section('maybeSingle() semantics');

  {
    const none = await qb('jobs', []).select('id').maybeSingle();
    check('zero rows -> null data and NO error',
      none.data === null && none.error === null, JSON.stringify(none.error));

    const one = await qb('jobs', [{ id: 'a' }]).select('id').maybeSingle();
    check('one row -> the row', one.error === null && (one.data as any)?.id === 'a');

    const many = await qb('jobs', [{ id: 'a' }, { id: 'b' }]).select('id').maybeSingle();
    check('multiple rows -> error', many.error !== null && many.data === null);
  }

  section('RLS indistinguishability (security-critical)');

  {
    // A row hidden by RLS and a row that does not exist both arrive here as an
    // empty result set. The builder must not let those diverge, or resume and
    // application ids become probeable.
    const hidden = await qb('applications', []).select('id').eq('id', 'real-but-invisible').single();
    const absent = await qb('applications', []).select('id').eq('id', 'does-not-exist').single();
    check('hidden and absent produce identical errors',
      JSON.stringify(hidden.error) === JSON.stringify(absent.error));
    check('hidden and absent produce identical data', hidden.data === absent.data);

    const hiddenM = await qb('resumes', []).select('id').eq('id', 'x').maybeSingle();
    const absentM = await qb('resumes', []).select('id').eq('id', 'y').maybeSingle();
    check('maybeSingle is equally indistinguishable',
      hiddenM.data === absentM.data && hiddenM.error === absentM.error);
  }

  section('list results');

  {
    const rows = await qb('jobs', [{ id: 'a' }, { id: 'b' }]).select('id');
    check('list returns an array', Array.isArray(rows.data) && (rows.data as any).length === 2);
    check('list has no error', rows.error === null);

    const counted = await qb('resumes', [{ id: '1' }, { id: '2' }, { id: '3' }])
      .select('id', { count: 'exact', head: true }).eq('candidate_id', 'c');
    check('head:true returns count and no rows',
      counted.count === 3 && counted.data === null, JSON.stringify(counted));
  }

  section('SQL generation');

  {
    let sink: Captured[] = [];
    await qb('jobs', [], sink).select('id, title').eq('status', 'active')
      .order('published_at', { ascending: false }).limit(5);
    const sql = sink[sink.length - 1];
    check('columns are quoted', sql.text.includes('"id", "title"'), sql.text);
    check('filter is parameterised, not interpolated',
      sql.text.includes('"status" = $1') && sql.values[0] === 'active', sql.text);
    check('order direction honoured', sql.text.includes('order by "published_at" desc'), sql.text);
    check('limit is parameterised', /limit \$\d+/.test(sql.text), sql.text);

    sink = [];
    await qb('notifications', [], sink).update({ read_at: 'now' }).eq('user_id', 'u').is('read_at', null);
    check('is(null) becomes IS NULL', sink[0].text.includes('"read_at" is null'), sink[0].text);

    sink = [];
    await qb('ai_jobs', [], sink).select('id').in('status', ['queued', 'rate_limited']);
    check('in() expands to parameters',
      /"status" in \(\$1, \$2\)/.test(sink[0].text), sink[0].text);

    sink = [];
    await qb('ai_jobs', [], sink).select('id').in('status', []);
    check('in([]) matches nothing rather than everything',
      sink[0].text.includes('where false'), sink[0].text);

    sink = [];
    await qb('application_scores', [], sink)
      .upsert({ application_id: 'a', overall: 80 }, { onConflict: 'application_id' });
    check('upsert targets the stated conflict column',
      sink[0].text.includes('on conflict ("application_id") do update set'), sink[0].text);
    check('upsert does not overwrite the conflict key',
      !/set[\s\S]*"application_id" = excluded/.test(sink[0].text), sink[0].text);

    sink = [];
    await qb('resumes', [{ id: 'r' }], sink).insert({ id: 'r', file_name: 'a.pdf' }).select('id').single();
    check('insert + select becomes RETURNING',
      sink[0].text.includes('returning "id"') && sink[0].text.startsWith('insert into "resumes"'),
      sink[0].text);
  }

  section('injection and misuse are refused');

  {
    const bad = await qb('jobs').select('id; drop table jobs');
    check('a column name with SQL in it is rejected',
      bad.error !== null && bad.error.code === 'TIP_BUILD', JSON.stringify(bad.error));

    // Phase 2 note: declared embeds are now supported (see test-embed.ts).
    // What must stay refused is an embed the relationship map does not declare,
    // because guessing a join is how a compatibility layer silently returns the
    // wrong rows.
    const undeclared = await qb('applications').select('id, resumes(file_name)');
    check('an undeclared embed is refused, not guessed',
      undeclared.error !== null && /No declared relationship/.test(undeclared.error.message),
      JSON.stringify(undeclared.error));

    let threw = false;
    try { qb('users'); } catch { threw = true; }
    check('the credential table is unreachable through the data client', threw);

    let badTable = false;
    try { qb('jobs; drop table users'); } catch { badTable = true; }
    check('a table name with SQL in it is rejected', badTable);

    let noConflict = false;
    try { qb('jobs').upsert({ a: 1 } as never); } catch { noConflict = true; }
    check('upsert without an onConflict target is refused', noConflict);
  }

  section('password hashing');

  {
    // New hashes are bcrypt, computed and compared by PostgreSQL (pgcrypto), so the
    // Worker never spends CPU on hashing. Earlier scrypt hashes must still verify.
    check('new hashes are bcrypt made by PostgreSQL',
      hashSql('$2') === "crypt($2::text, gen_salt('bf', 10))");
    check('the dummy hash is a well-formed bcrypt hash', /^\$2a\$10\$[./A-Za-z0-9]{53}$/.test(DUMMY_HASH));

    const salt = randomBytes(16);
    const derived = await new Promise<Buffer>((resolve, reject) =>
      scrypt('correct horse battery staple', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key))));
    const legacy = ['scrypt', 16384, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');
    check('a legacy scrypt hash is recognised', isLegacyHash(legacy) && !isLegacyHash(DUMMY_HASH));
    check('correct password verifies against a legacy hash',
      await verifyLegacyPassword('correct horse battery staple', legacy));
    check('wrong password does not verify', !(await verifyLegacyPassword('wrong', legacy)));
    check('malformed stored hash returns false, does not throw',
      !(await verifyLegacyPassword('x', 'not-a-hash')));
    check('empty stored hash returns false', !(await verifyLegacyPassword('x', '')));
  }

  section('session tokens');

  {
    const src = read('lib/auth/session.ts');
    check('cookie is httpOnly', /httpOnly: true/.test(src));
    check('cookie is Secure in production',
      /secure: process\.env\.NODE_ENV === 'production'/.test(src), src.slice(0, 0));
    check('cookie is SameSite=Lax', /sameSite: 'lax'/.test(src));
    check('tokens are HS256', /alg: 'HS256'/.test(src));
    check('issuer is verified on the way in', /jwtVerify\([\s\S]{0,120}issuer: ISSUER/.test(src));
    check('a short or placeholder secret is refused', /usableSecret\(process\.env\.AUTH_JWT_SECRET\)/.test(src));
    check('verification failure returns null rather than throwing',
      /catch \{[\s\S]{0,200}return null;/.test(src));
    check('the token carries no role claim (role is read live)',
      !/setRole|role:/.test(src));
  }

  section('credential path');

  {
    const users = read('lib/auth/users.ts');
    const signin = read('app/api/auth/signin/route.ts');

    check('credential reads go through the auth escape only',
      /runAuthOp\(/.test(users) && !/serviceClient|dataClient/.test(users));
    check('deactivated accounts cannot authenticate',
      /!row\.id \|\| !ok \|\| !row\.is_active/.test(users));
    check('an unknown email still costs a hash comparison (no timing oracle)',
      /DUMMY_HASH/.test(users) && /coalesce\(u\.password_hash, \$3::text\)/.test(users));
    // The hash is read internally; what matters is that it never leaves.
    const shape = users.slice(users.indexOf('export interface AuthenticatedUser'),
                              users.indexOf('}', users.indexOf('export interface AuthenticatedUser')));
    check('the returned user shape carries no credential field',
      !/password|hash/i.test(shape), shape);
    check('authenticate returns only the five public fields',
      /user: \{\s*id: row\.id,\s*email: row\.email,\s*role: row\.role,\s*fullName:[\s\S]{0,60}isActive: row\.is_active,\s*\}/.test(users));
    check('registration writes user, profile and candidate rows in one transaction',
      /runAuthOp\(async \(client\)[\s\S]{0,900}insert into profiles[\s\S]{0,400}candidate_profiles/.test(users));
    check('sign-in returns one message for every failure mode',
      (signin.match(/FAILED/g) ?? []).length >= 3 && /status: 401/.test(signin));
    check('sign-in does not echo the submitted password',
      !/console\.[a-z]+\([^)]*password/.test(signin));
    check('repeated failures are throttled with 429',
      /kind === 'throttled'/.test(signin) && /status: 429/.test(signin));
    check('throttling is per email and client address, not per email alone',
      /client_ip is not distinct from/.test(users) && /MAX_FAILURES_PER_EMAIL_IP = 5/.test(users));
    check('legacy scrypt hashes are upgraded to bcrypt after a successful sign-in',
      /verifyLegacyPassword\(password, row\.legacy_hash\)[\s\S]{0,200}update users set password_hash/.test(users));
    const throttle = read('db/migrations/0003_login_throttle.sql');
    check('login_failures has RLS forced and only the auth_op policy',
      /force row level security/.test(throttle) && /app\.auth_op/.test(throttle)
        && (throttle.match(/create policy/g) ?? []).length === 1);
  }

  section('secrets');

  {
    check('the .dev.vars.example placeholder is not a usable secret',
      usableSecret('REPLACE_WITH_A_LONG_RANDOM_STRING') === null);
    check('a "your_..._here" placeholder is not a usable secret',
      usableSecret('your_auth_jwt_secret_goes_right_here') === null);
    check('a secret shorter than 32 characters is refused', usableSecret('a'.repeat(31)) === null);
    check('a random 48-character secret is accepted', usableSecret(randomBytes(36).toString('base64')) !== null);
    const worker = read('app/api/worker/drain/route.ts');
    check('worker secrets go through usableSecret',
      /usableSecret\(process\.env\.AI_WORKER_SECRET\)/.test(worker)
        && /usableSecret\(process\.env\.CRON_SECRET\)/.test(worker));
    check('a signed-in user drains a single job only', /trusted \? Math\.min\(10[\s\S]{0,80}: 1;/.test(worker));
    const mw = read('middleware.ts');
    check('middleware refuses placeholder secrets too', /usableSecret\(process\.env\.AUTH_JWT_SECRET\)/.test(mw));
  }

  section('recruiter workspace scoping');

  {
    // jobs_public_read lets every recruiter read all ACTIVE jobs, so lists of
    // "my roles" must filter by owner explicitly rather than rely on RLS.
    for (const page of ['app/recruiter/page.tsx', 'app/recruiter/jobs/page.tsx']) {
      check(`${page} lists only the recruiter's own jobs`,
        /if \(user\.role === 'recruiter'\) jobsQuery\.eq\('recruiter_id', user\.id\)/.test(read(page)));
    }
  }

  section('identity propagation');

  {
    const src = read('lib/db/session.ts');
    check('identity is set with SET LOCAL semantics (is_local = true)',
      /set_config\(\$1, \$2, true\)/.test(src));
    check('identity is never interpolated into SQL',
      !/SET LOCAL app\.user_id = \$\{/.test(src) && !/`set .*\$\{userId\}/.test(src));
    check('a non-UUID identity is refused before reaching SQL',
      /UUID_RE\.test\(id\)/.test(src));
    check('every identity transaction is wrapped in BEGIN/COMMIT',
      /client\.query\('BEGIN'\)/.test(src) && /client\.query\('COMMIT'\)/.test(src));
    check('errors roll back', /client\.query\('ROLLBACK'\)/.test(src));
    check('the connection is always released', /finally \{[\s\S]{0,120}client\.release\(\)/.test(src));
    check('anonymous requests set no identity at all',
      /if \(userId !== null\)/.test(src));

    const rls = read('db/migrations/0002_rls.sql');
    check('app_user_id reads a transaction-local setting',
      /current_setting\('app\.user_id', true\)/.test(rls));
    check('a missing setting yields NULL, so policies fail closed',
      /nullif\(current_setting\('app\.user_id', true\), ''\)/.test(rls));
    check('the credential table is force-protected',
      /alter table users force row level security/.test(rls));
    // Generated inside execute format(), so the quotes appear doubled.
    check('service escape is transaction-scoped too',
      /current_setting\(''app\.service_op'', true\)/.test(rls));
    check('no Supabase identity function survives', !/auth\.uid\(\)/.test(rls));
  }

  console.log('');
  console.log('====================================================');
  console.log(`${pass} passed, ${fail} failed`);
  console.log('====================================================');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
