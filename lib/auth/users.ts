import 'server-only';
import { runAuthOp, type Tx } from '@/lib/db/session';
import { DUMMY_HASH, hashSql, verifyLegacyPassword } from './password';

/**
 * The credential path.
 *
 * MIGRATION NOTE: replaces Supabase Auth's signInWithPassword and the
 * `handle_new_user` trigger that fired on the managed auth table. Both now
 * live here, in explicit transactions.
 *
 * Everything in this module runs through runAuthOp(), the only code permitted
 * to read `users`. Nothing here returns a password hash to a caller. Hashes are
 * computed and compared by PostgreSQL (lib/auth/password.ts).
 */

export type Role = 'candidate' | 'recruiter' | 'admin';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  fullName: string;
  isActive: boolean;
}

/**
 * Failed sign-ins allowed per 15 minutes (db/migrations/0003). Counting per
 * email alone would let anyone lock the published demo accounts, so the tight
 * limit is per email from one client address, with a much higher ceiling per
 * email across all addresses.
 */
const MAX_FAILURES_PER_EMAIL_IP = 5;
const MAX_FAILURES_PER_IP = 30;
const MAX_FAILURES_PER_EMAIL = 100;

type SignInResult =
  | { kind: 'ok'; user: AuthenticatedUser }
  | { kind: 'invalid' }
  | { kind: 'throttled' };

interface CredentialRow {
  throttled: boolean | null;
  id: string | null;
  email: string;
  role: Role;
  full_name: string | null;
  is_active: boolean;
  legacy_hash: string | null;
  bcrypt_ok: boolean;
}

/**
 * Verifies an email/password pair inside one auth transaction, optionally
 * applying and recording the sign-in throttle (`throttle` = the client address
 * or null when unknown; undefined = no throttling, for scripts and tests).
 *
 * Unknown email, wrong password and deactivated account give the same answer,
 * so sign-in cannot be used to discover which addresses are registered. An
 * unknown email is still compared against DUMMY_HASH, so the response time does
 * not reveal whether the account exists.
 */
async function checkCredentials(
  client: Tx,
  email: string,
  password: string,
  throttle: string | null | undefined,
): Promise<SignInResult> {
  const useThrottle = throttle !== undefined;
  const ip = throttle ?? null;
  const res = await client.query(
    `with recent as (
       select count(*) filter (where email = $1 and client_ip is not distinct from $4::text) >= $5
           or count(*) filter (where client_ip = $4::text) >= $6
           or count(*) filter (where email = $1) >= $7 as throttled
         from login_failures
        where $8::boolean and attempted_at > now() - interval '15 minutes'
          and (email = $1 or client_ip = $4::text))
     select (select throttled from recent) as throttled,
            u.id, u.email, p.role, p.full_name, p.is_active,
            case when u.password_hash like 'scrypt$%' then u.password_hash end as legacy_hash,
            case when u.password_hash like 'scrypt$%' then false
                 else coalesce(crypt($2::text, coalesce(u.password_hash, $3::text)) = u.password_hash, false)
            end as bcrypt_ok
       from (select 1) as one
       left join users u on u.email = $1
       left join profiles p on p.id = u.id
      limit 1`,
    [email, password, DUMMY_HASH, ip, MAX_FAILURES_PER_EMAIL_IP, MAX_FAILURES_PER_IP,
     MAX_FAILURES_PER_EMAIL, useThrottle],
  );
  const row = res.rows[0] as CredentialRow;
  if (row.throttled) return { kind: 'throttled' };

  let ok = row.bcrypt_ok === true;
  if (!ok && row.id && row.legacy_hash) {
    // A scrypt hash from an earlier version: verify it once, then store bcrypt.
    ok = await verifyLegacyPassword(password, row.legacy_hash);
    if (ok) {
      await client.query(`update users set password_hash = ${hashSql('$2')} where id = $1`, [row.id, password]);
    }
  }

  if (!row.id || !ok || !row.is_active) {
    if (useThrottle) {
      await client.query(
        `with pruned as (delete from login_failures where attempted_at < now() - interval '1 day')
         insert into login_failures (email, client_ip) values ($1, $2::text)`,
        [email, ip],
      );
    }
    return { kind: 'invalid' };
  }
  if (useThrottle) {
    await client.query(
      'delete from login_failures where email = $1 and client_ip is not distinct from $2::text',
      [email, ip],
    );
  }

  return {
    kind: 'ok',
    user: {
      id: row.id,
      email: row.email,
      role: row.role,
      fullName: row.full_name ?? '',
      isActive: row.is_active,
    },
  };
}

function normalise(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

/** Sign-in with throttling, for the sign-in route. `clientIp` may be null when unknown. */
export async function signIn(email: string, password: string, clientIp: string | null): Promise<SignInResult> {
  const normalised = normalise(email);
  if (!normalised || typeof password !== 'string' || password.length === 0) return { kind: 'invalid' };
  return runAuthOp((client) => checkCredentials(client, normalised, password, clientIp));
}

/** Verifies an email/password pair without throttling (scripts and tests). */
export async function authenticate(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const normalised = normalise(email);
  if (!normalised || typeof password !== 'string' || password.length === 0) {
    return null;
  }
  const result = await runAuthOp((client) => checkCredentials(client, normalised, password, undefined));
  return result.kind === 'ok' ? result.user : null;
}

/**
 * Creates a user, their profile, and — for candidates — their candidate
 * profile, in one transaction.
 *
 * MIGRATION NOTE: this is the `handle_new_user()` trigger, moved into
 * application code. The trigger fired on the managed auth table, which no
 * longer exists. Doing it in an explicit transaction keeps the same
 * all-or-nothing guarantee and makes the role assignment testable.
 */
export async function registerUser(input: {
  email: string;
  password: string;
  fullName?: string;
  role?: Role;
}): Promise<{ id: string } | { error: string }> {
  const email = normalise(input.email);
  if (!email.includes('@')) return { error: 'A valid email address is required.' };
  if (!input.password || input.password.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }
  const role: Role = input.role ?? 'candidate';

  try {
    return await runAuthOp(async (client) => {
      const inserted = await client.query(
        `insert into users (email, password_hash) values ($1, ${hashSql('$2')})
         on conflict (email) do nothing
         returning id`,
        [email, input.password],
      );
      if (inserted.rows.length === 0) {
        return { error: 'That email address is already registered.' };
      }
      const id = inserted.rows[0].id as string;

      await client.query(
        `insert into profiles (id, email, full_name, role)
         values ($1, $2, $3, $4)
         on conflict (id) do nothing`,
        [id, email, input.fullName ?? '', role],
      );

      if (role === 'candidate') {
        await client.query(
          `insert into candidate_profiles (user_id) values ($1)
           on conflict (user_id) do nothing`,
          [id],
        );
      }
      return { id };
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Replaces a user's password. Used by scripts/set-passwords.ts and the seed. */
export async function setPassword(email: string, password: string): Promise<boolean> {
  const normalised = normalise(email);
  return runAuthOp(async (client) => {
    const res = await client.query(
      `update users set password_hash = ${hashSql('$2')} where email = $1`,
      [normalised, password],
    );
    return (res.rowCount ?? 0) > 0;
  });
}
