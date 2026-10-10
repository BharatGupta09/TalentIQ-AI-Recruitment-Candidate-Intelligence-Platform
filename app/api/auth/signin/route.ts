import { NextResponse } from 'next/server';
import { z } from 'zod';
import { signIn } from '@/lib/auth/users';
import { setSessionCookie } from '@/lib/auth/session';
import { isWorkersRuntime } from '@/lib/db/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sign in.
 *
 * MIGRATION NOTE: replaces supabase.auth.signInWithPassword(), which ran in
 * the browser. Credentials now go to the server, are verified by PostgreSQL
 * (bcrypt), and the session is issued as an httpOnly cookie the browser cannot
 * read.
 *
 * Every failure returns the same message and the same status. Unknown email,
 * wrong password and deactivated account are indistinguishable, so this
 * endpoint cannot be used to enumerate accounts. Repeated failures from one
 * address are paused for 15 minutes (lib/auth/users.ts).
 */
const Body = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(512),
});

const FAILED = { error: 'That email and password combination was not recognised.' };
const THROTTLED = { error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' };

/**
 * The client's address. On Cloudflare Workers, CF-Connecting-IP is set by
 * Cloudflare and cannot be forged by the client; elsewhere the first
 * X-Forwarded-For hop is the best available signal.
 */
function clientIp(request: Request): string | null {
  const value = isWorkersRuntime()
    ? request.headers.get('cf-connecting-ip')
    : request.headers.get('x-forwarded-for')?.split(',')[0];
  return value?.trim().slice(0, 64) || null;
}

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await request.json());
  } catch {
    return NextResponse.json(FAILED, { status: 401 });
  }
  if (!parsed.success) return NextResponse.json(FAILED, { status: 401 });

  const result = await signIn(parsed.data.email, parsed.data.password, clientIp(request));
  if (result.kind === 'throttled') return NextResponse.json(THROTTLED, { status: 429 });
  if (result.kind !== 'ok') return NextResponse.json(FAILED, { status: 401 });

  await setSessionCookie(result.user.id);
  return NextResponse.json({ ok: true });
}
