import 'server-only';
import { Client, Pool, types } from '@neondatabase/serverless';
import './neon-config';

/**
 * Neon connections.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * This replaces the PostgREST transport that @supabase/ssr used. Queries now
 * go straight to Postgres, which is what makes transaction-scoped identity
 * (`SET LOCAL app.user_id`) possible — and that, in turn, is what lets the RLS
 * policies survive the migration unchanged.
 *
 * Two runtimes, two shapes:
 *   - Node (next dev, scripts): one module-scoped pool, so a warm process
 *     reuses connections.
 *   - Cloudflare Workers: a WebSocket opened while handling one request cannot
 *     be used by another, so a pool shared between requests fails there. Each
 *     transaction opens its own connection and closes it afterwards.
 */

/**
 * NUMERIC arrives as a JavaScript number, not a string.
 *
 * MIGRATION NOTE: node-postgres decodes `numeric` (OID 1700) as a string by
 * default, to avoid losing precision on values wider than a float64. PostgREST
 * did not do that — it emitted JSON numbers — so every caller in this codebase
 * is written against numbers (`overall: number`, `years_experience: number`).
 *
 * Without this, the same column would arrive as two different types depending
 * on how it was read: a string when selected directly, but a number when read
 * through an embedded resource, because jsonb_build_object produces a real JSON
 * number. That inconsistency is worse than either choice on its own.
 *
 * Safe here because every numeric column in this schema is small and bounded:
 *   application_scores.overall        numeric(5,2)
 *   candidate_profiles.years_experience numeric(4,1)
 *   jobs.experience_min / experience_max numeric(4,1)
 * All are represented exactly by a float64. Adding a wide numeric column later
 * (money, large counters) would require revisiting this.
 */
types.setTypeParser(1700, (value: string) => Number(value));

declare global {
  // eslint-disable-next-line no-var
  var __tipPool: Pool | undefined;
}

/** Template placeholders (.dev.vars.example's ":PASSWORD@HOST") count as not configured. */
const PLACEHOLDER = /^(|your[_-].*|.*[_-]here|replace[_-].*|changeme|placeholder)$/i;

export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim() ?? '';
  return !PLACEHOLDER.test(url) && !url.includes(':PASSWORD@HOST');
}

function connectionString(): string {
  if (!isDatabaseConfigured()) {
    throw new Error(
      'DATABASE_URL is not set. Point it at the Neon *pooled* connection string.',
    );
  }
  return process.env.DATABASE_URL!.trim();
}

export function isWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

function assertWebSocket(): void {
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error(
      'No global WebSocket. @neondatabase/serverless needs one; run on Node 22+ ' +
      'or set neonConfig.webSocketConstructor explicitly.',
    );
  }
}

/**
 * Single shared pool for Node, cached on globalThis so Next.js dev's module
 * reloading does not leak a new pool on every edit. Not for Workers.
 */
export function getPool(): Pool {
  if (!globalThis.__tipPool) {
    assertWebSocket();
    globalThis.__tipPool = new Pool({
      connectionString: connectionString(),
      // Neon's free tier scales to zero after five minutes of inactivity.
      // Keep the pool small and release idle connections rather than holding
      // one open against a compute that is about to suspend.
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return globalThis.__tipPool;
}

export interface Connection {
  query: Client['query'];
  release(): Promise<void>;
}

/** A connection for one transaction: pooled on Node, private on Workers. */
export async function connect(): Promise<Connection> {
  if (!isWorkersRuntime()) {
    const client = await getPool().connect();
    return {
      query: client.query.bind(client) as Client['query'],
      release: async () => { client.release(); },
    };
  }
  assertWebSocket();
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  return {
    query: client.query.bind(client) as Client['query'],
    release: () => client.end().catch(() => undefined),
  };
}
