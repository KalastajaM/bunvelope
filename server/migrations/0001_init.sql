-- 0001_init.sql — baseline schema for cloud mode.
-- Run by the migration runner in server/db.js at boot.

create extension if not exists "pgcrypto";

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  google_sub text unique not null,
  name       text,
  created_at timestamptz not null default now()
);

create table if not exists budgets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  name           text not null,
  version        integer not null default 0,
  created_at     timestamptz not null default now(),
  last_opened_at timestamptz not null default now()
);

create index if not exists budgets_user_id_idx on budgets(user_id);

create table if not exists budget_blobs (
  budget_id uuid not null references budgets(id) on delete cascade,
  kind      text not null check (kind in (
    'envelopes','budget_items','transactions',
    'accounts','envelope_templates','meta'
  )),
  data      jsonb not null,
  primary key (budget_id, kind)
);

-- connect-pg-simple session store. Mirrors the table it expects.
create table if not exists "session" (
  sid    varchar not null primary key,
  sess   json not null,
  expire timestamp(6) not null
);
create index if not exists "session_expire_idx" on "session" ("expire");
