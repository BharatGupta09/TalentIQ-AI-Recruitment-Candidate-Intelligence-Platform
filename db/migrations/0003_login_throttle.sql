-- 0003_login_throttle.sql
-- Sign-in throttling (lib/auth/users.ts). Additive: no existing object changes.
--
-- Failed sign-ins are recorded with the email and the client address and
-- counted over 15 minutes: per email from one address, per address, and (with a
-- high ceiling) per email. Counting per email alone would let anyone lock the
-- published demo accounts. Rows older than a day are pruned on each failure.
--
-- Like `users`, the table is reachable only from the authentication path:
-- RLS is enabled and forced, and the single policy requires the
-- transaction-local `app.auth_op` flag that only lib/auth sets.

create table if not exists login_failures (
  id           bigint generated always as identity primary key,
  email        text        not null,
  client_ip    text,
  attempted_at timestamptz not null default now()
);

create index if not exists login_failures_email_idx on login_failures (email, attempted_at desc);
create index if not exists login_failures_ip_idx on login_failures (client_ip, attempted_at desc)
  where client_ip is not null;

alter table login_failures enable row level security;
alter table login_failures force row level security;

drop policy if exists login_failures_auth_op on login_failures;
create policy login_failures_auth_op on login_failures for all
  using (current_setting('app.auth_op', true) = 'on')
  with check (current_setting('app.auth_op', true) = 'on');
