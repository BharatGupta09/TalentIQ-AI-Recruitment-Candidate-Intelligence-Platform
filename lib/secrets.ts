/**
 * A secret that is missing, shorter than 32 characters or still a template
 * placeholder ("REPLACE_WITH_...", "your_..._here") is unusable. The values in
 * .dev.vars.example are public, so accepting one would let anyone forge a session
 * or call the worker. Used by lib/auth/session.ts, middleware.ts (Edge runtime,
 * so no server-only import here) and the worker route.
 */
const PLACEHOLDER = /^(replace[_-]|your[_-]|change[_-]?me|placeholder)|[_-]here$/i;

export const MIN_SECRET_LENGTH = 32;

export function usableSecret(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value || value.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(value)) return null;
  return value;
}
