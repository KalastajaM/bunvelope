-- 0006_schema_migrations_sha.sql — fingerprint applied migrations.
--
-- Adds a content_sha256 column to schema_migrations so the boot-time runner
-- can detect when an applied migration file has been edited on disk
-- (defence in depth past the CI git-diff check). The column is populated
-- by the runner on apply; existing rows backfill on the next boot.
--
-- The column is nullable: pre-0006 rows stay null until the runner backfills
-- them from disk, and a missing/malformed file leaves the SHA null with a
-- warning rather than failing boot.

alter table schema_migrations add column if not exists content_sha256 text;
