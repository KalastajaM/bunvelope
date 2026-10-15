-- 0002_blob_backups.sql — keep a history of blob versions so destructive
-- client-side schema migrations or bad writes can be recovered.

create table if not exists budget_blob_backups (
  id         bigserial primary key,
  budget_id  uuid not null references budgets(id) on delete cascade,
  kind       text not null,
  data       jsonb not null,
  version    integer not null,
  backed_up_at timestamptz not null default now()
);

create index if not exists budget_blob_backups_budget_id_idx
  on budget_blob_backups(budget_id, backed_up_at desc);
