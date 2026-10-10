/**
 * Applies db/migrations/*.sql to a PostgreSQL database, in order, once each.
 *
 *   npm run db:migrate          (reads .dev.vars; DATABASE_URL_OWNER or DATABASE_URL_UNPOOLED)
 *
 * Uses the owner connection (DATABASE_URL_OWNER, or DATABASE_URL_UNPOOLED before
 * `db:setup-role` has run). Schema changes must not go through the pooler:
 * PgBouncer in transaction mode cannot hold the session state some DDL relies
 * on, and a migration is exactly the case where you want one uninterrupted
 * session.
 *
 * Applied files are recorded, with a checksum, in tip_migrations.applied, a
 * schema the application role cannot read. Re-running applies only new files,
 * and a file edited after it was applied is refused (add a new migration
 * instead). Each file runs in its own transaction together with its ledger row.
 *
 * Each file is sent as a single query (simple query protocol), which avoids
 * splitting SQL on semicolons and so keeps the dollar-quoted `do $$ ... $$`
 * blocks and function bodies intact.
 *
 * A database built before the ledger existed (0001 and 0002 applied by hand or
 * by the earlier runner) is recognised and recorded as such; any other
 * non-empty database without a ledger is refused. Nothing here drops or
 * truncates anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@neondatabase/serverless';
import '../lib/db/neon-config';

const dir = join(import.meta.dirname, '..', 'db', 'migrations');
const BASELINE = ['0001_schema.sql', '0002_rls.sql'];

function connectionString(): string {
  // DDL needs the owner. DATABASE_URL belongs to the least-privilege
  // application role, which deliberately cannot create or alter tables.
  const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (owner connection required for DDL).');
  return url;
}

const checksum = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

async function main() {
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  if (files.length === 0) throw new Error(`No .sql files in ${dir}`);

  const client = new Client({ connectionString: connectionString() });
  await client.connect();

  try {
    await client.query('create schema if not exists tip_migrations');
    await client.query(`create table if not exists tip_migrations.applied (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now(),
      baseline   boolean not null default false)`);
    const done = new Map<string, string>(
      (await client.query('select filename, checksum from tip_migrations.applied')).rows
        .map((r) => [r.filename as string, r.checksum as string]),
    );

    if (done.size === 0) {
      const state = (await client.query(`
        select (select count(*)::int from information_schema.tables
                 where table_schema = 'public' and table_type = 'BASE TABLE') as tables,
               to_regclass('public.profiles') is not null
                 and to_regprocedure('public.app_user_id()') is not null as has_baseline`)).rows[0];
      if (state.tables > 0) {
        if (!state.has_baseline) {
          console.error(
            `  REFUSING: the database has ${state.tables} table(s) but no migration ledger and not ` +
            'this schema. Point DATABASE_URL_OWNER at a database created for this application.');
          process.exitCode = 1;
          return;
        }
        for (const file of BASELINE) {
          const sum = checksum(readFileSync(join(dir, file), 'utf8'));
          await client.query(
            'insert into tip_migrations.applied (filename, checksum, baseline) values ($1, $2, true)', [file, sum]);
          done.set(file, sum);
          console.log(`  recorded ${file} (already present; database predates the ledger)`);
        }
      }
    }

    let applied = 0;
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const sum = checksum(sql);
      const previous = done.get(file);
      if (previous) {
        if (previous !== sum) {
          throw new Error(`${file} was edited after it was applied. Revert it and add a new migration instead.`);
        }
        continue;
      }
      const started = Date.now();
      process.stdout.write(`  applying ${file} ... `);
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into tip_migrations.applied (filename, checksum) values ($1, $2)', [file, sum]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        console.log('FAILED');
        throw err;
      }
      console.log(`ok (${Date.now() - started} ms)`);
      applied += 1;
    }
    console.log(applied ? `  ${applied} migration(s) applied.` : '  migrations up to date.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  // Surface the real PostgreSQL error rather than a generic failure.
  const pg = e as { message?: string; position?: string; hint?: string; detail?: string };
  console.error('  MIGRATION FAILED');
  console.error('   message:', pg.message);
  if (pg.detail) console.error('   detail :', pg.detail);
  if (pg.hint) console.error('   hint   :', pg.hint);
  if (pg.position) console.error('   position:', pg.position);
  process.exit(1);
});
