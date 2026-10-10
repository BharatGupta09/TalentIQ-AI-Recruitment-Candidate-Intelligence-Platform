import 'server-only';
import { scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * Passwords are hashed and checked by PostgreSQL itself, with pgcrypto's
 * bcrypt:  crypt(password, gen_salt('bf', 10))  and
 *          crypt(input, stored) = stored.
 * The application never computes a hash. That keeps the CPU-heavy work off the
 * Cloudflare Workers Free plan's 10 ms CPU budget: waiting for the database is
 * I/O, not CPU. The SQL fragments below are used inside lib/auth/users.ts.
 *
 * Earlier versions stored scrypt hashes computed in Node
 * ("scrypt$N$r$p$salt$hash"). Those still verify (verifyLegacyPassword) and are
 * replaced with bcrypt on the next successful sign-in.
 */

export const BCRYPT_COST = 10;

/** SQL expression hashing the text parameter `$n` with bcrypt. */
export const hashSql = (param: string) => `crypt(${param}::text, gen_salt('bf', ${BCRYPT_COST}))`;

/**
 * A syntactically valid bcrypt hash that matches no password. Comparing against
 * it when the email is unknown keeps the response time the same either way.
 */
export const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8DPLKXt1FYlwYpQW2G3cAwjKoh2WZu';

export function isLegacyHash(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}

// scrypt needs roughly 128 * N * r bytes; give it headroom over the default.
const MAXMEM = 64 * 1024 * 1024;

/**
 * Constant-time verification of a legacy scrypt hash. Returns false for
 * malformed stored values rather than throwing, so a corrupt row cannot become
 * an exception path that behaves differently from a wrong password.
 */
export async function verifyLegacyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: n, r, p, maxmem: MAXMEM,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
