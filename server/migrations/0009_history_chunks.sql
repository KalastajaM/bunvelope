-- Immutable history chunks are published atomically with budget_blobs metadata.
-- Retain chunks referenced by older metadata backups; budget deletion cascades.
create table if not exists budget_history_chunks (
  budget_id uuid not null references budgets(id) on delete cascade,
  id text not null check (id ~ '^[a-f0-9]{64}$'),
  data jsonb not null,
  primary key (budget_id, id)
);
