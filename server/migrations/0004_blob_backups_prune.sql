-- 0004_blob_backups_prune.sql — bound the per-(budget,kind) backup history.
--
-- Previously the server backed up the prior payload of a blob on every
-- save. Combined with multi-megabyte transactions blobs that produced
-- table bloat that slowed every subsequent save (each insert had to
-- update the index and copy a TOASTed payload). The application code
-- now throttles backups to once-per-(budget,kind) per few minutes; this
-- migration also trims any historical bloat so existing budgets benefit
-- immediately without waiting for the next save.
--
-- Strategy: keep the most recent 20 backups per (budget_id, kind),
-- delete the rest. 20 is a generous window for crash-recovery while
-- preventing unbounded growth.

with ranked as (
  select id,
         row_number() over (
           partition by budget_id, kind
           order by backed_up_at desc, id desc
         ) as rn
    from budget_blob_backups
)
delete from budget_blob_backups
 where id in (select id from ranked where rn > 20);
