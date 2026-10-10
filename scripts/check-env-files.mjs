#!/usr/bin/env node
/**
 * Runs before `npm run cf:build` / `cf:deploy`.
 *
 * The OpenNext Cloudflare build copies every variable from .env, .env.local,
 * .env.production(.local) and .env.development(.local) into the Worker bundle
 * (.open-next/cloudflare/next-env.mjs). A database owner URL, a session secret
 * or seed passwords in any of those files would therefore be deployed inside
 * the Worker. Local secrets belong in .dev.vars (never deployed); deployed
 * secrets are Worker secrets (`npx wrangler secret put NAME`).
 *
 * Only NEXT_PUBLIC_* values and GROQ_MODEL are allowed in those files.
 */
import { existsSync, readFileSync } from 'node:fs';

const FILES = ['.env', '.env.local', '.env.production', '.env.production.local',
  '.env.development', '.env.development.local'];
const ALLOWED = (key) => key.startsWith('NEXT_PUBLIC_') || key === 'GROQ_MODEL';

const problems = [];
for (const file of FILES) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !ALLOWED(m[1])) problems.push(`${file}: ${m[1]}`);
  }
}

if (problems.length) {
  console.error('Refusing to build: these variables would be embedded in the deployed Worker:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Move local values to .dev.vars (see .dev.vars.example) and set deployed ones with');
  console.error('`npx wrangler secret put NAME`. Only NEXT_PUBLIC_* and GROQ_MODEL may stay in .env files.');
  process.exit(1);
}
